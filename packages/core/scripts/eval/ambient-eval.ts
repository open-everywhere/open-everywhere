import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAudit, type AuditWireEntry } from "../e2e/audit-read.js";
import { wireNeonOperationalStore, rotateUnifiedWindow } from "../e2e/rotate-window-lib.js";
import { isModelUsable, clampReasoning, type ModelPolicy } from "../../agent/model/policy.js";
import type { ModelReasoning } from "../../agent/memory/domain.js";
import type { OperationalStore, DomainModelRow } from "../../agent/operational/store.js";

const ALLOW_POLICY: ModelPolicy = {
  allow: [
    { id: "zai/glm-5.2", tier: "high" },
    { id: "deepseek/deepseek-v4-flash", tier: "low" },
    { id: "alibaba/qwen3-vl-instruct", tier: "low" },
  ],
  reasoningCeiling: "high",
};
const DOMAIN_CEILING: ModelReasoning = "high";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const FACT_WAIT_MS = Number.parseInt(process.env.AMBIENT_FACT_WAIT_MS ?? "35000", 10);
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.AMBIENT_REPLY_TIMEOUT_MS ?? "150000", 10);
const POLL_MS = Number.parseInt(process.env.AMBIENT_POLL_MS ?? "7000", 10);

const SLACK_SURFACE = (process.env.EVAL_SLACK_SURFACE ?? "").trim();
const NOTION_SURFACE = (process.env.EVAL_NOTION_SURFACE ?? "").trim();
const NOTION_DISCUSSION = (process.env.EVAL_NOTION_DISCUSSION ?? "").trim();
const SLACK_CHANNEL_ID = SLACK_SURFACE.split("/").slice(2).join("/");

let DOMAIN = "e2e-unified";

interface Cli {
  model: string; effort: ModelReasoning; turns: number; fill: number;
  domain: string; org: string; plan: boolean; rotate: boolean; restore: boolean;
}
function parseCli(argv: readonly string[]): Cli {
  const get = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
  const has = (f: string): boolean => argv.includes(f);
  const effRaw = (get("--effort") ?? "high").toLowerCase();
  return {
    model: get("--model") ?? "deepseek/deepseek-v4-flash",
    effort: (effRaw === "med" ? "medium" : effRaw) as ModelReasoning,
    turns: Math.max(1, Number.parseInt(get("--turns") ?? "8", 10)),
    fill: Math.max(0, Number.parseInt(get("--fill") ?? "0", 10)),
    domain: get("--domain") ?? process.env.E2E_UNIFIED_DOMAIN ?? "e2e-unified",
    org: get("--org") ?? process.env.E2E_ORG ?? "default",
    plan: has("--plan") || has("--dry-run"),
    rotate: !has("--no-rotate"),
    restore: !has("--no-restore"),
  };
}

type ScenarioId = "S1" | "S2" | "S3" | "S4";
type Expected = "LANDED" | "SILENT_OK";
type Outcome = "LANDED" | "SILENT_OK" | "DROP" | "OVER_REPLY" | "NO_ACTION" | "SKIP";

interface ScenarioSpec { id: ScenarioId; label: string; expected: Expected; needs: readonly ("slack" | "notion")[]; }
const SCENARIOS: Record<ScenarioId, ScenarioSpec> = {
  S1: { id: "S1", label: "reply @mention (Slack direct-mention; fact stated ambient on Slack)", expected: "LANDED", needs: ["slack"] },
  S2: { id: "S2", label: "ambient recall (Notion channel-watch; the flaky reply-tool path)", expected: "LANDED", needs: ["notion"] },
  S3: { id: "S3", label: "silence (Slack human↔human chatter, not addressed)", expected: "SILENT_OK", needs: ["slack"] },
  S4: { id: "S4", label: "cross-surface recall (fact on Notion → recalled on Slack @mention)", expected: "LANDED", needs: ["slack", "notion"] },
};
const SERIES_PATTERN: readonly ScenarioId[] = ["S4", "S2", "S3", "S2", "S1", "S2", "S3", "S2"];
const seriesOf = (n: number): ScenarioId[] => Array.from({ length: n }, (_, i) => SERIES_PATTERN[i % SERIES_PATTERN.length]);

const ADJ = ["SCARLET", "COBALT", "AMBER", "JADE", "CRIMSON", "AZURE", "IVORY", "ONYX", "SABLE", "TOPAZ"];
const ANIMAL = ["WEASEL", "HERON", "LYNX", "OTTER", "FALCON", "MARTEN", "BADGER", "STOAT", "RAVEN", "IBEX"];
function freshFact(run: string, turn: number): { code: string; date: string; ref: string } {
  const year = 2029 + (turn % 5), mm = String(((turn * 7) % 12) + 1).padStart(2, "0"), dd = String(((turn * 13) % 27) + 1).padStart(2, "0");
  return { code: `${ADJ[turn % ADJ.length]} ${ANIMAL[(turn * 3 + 1) % ANIMAL.length]}-${run}${turn}`, date: `${year}-${mm}-${dd}`, ref: `R${run}${turn}` };
}
function recallHit(body: string, m: { code: string; date: string; ref: string }): { code: boolean; date: boolean; ref: boolean } {
  const b = body.toLowerCase();
  return { code: b.includes(m.code.toLowerCase()), date: b.includes(m.date), ref: b.includes(m.ref.toLowerCase()) };
}

interface InjectBody {
  domain: string; platform: string; surfaceKey: string; text: string;
  addressing?: string; origin: Record<string, unknown>; mention?: boolean; author?: string;
}
interface InjectResult { ok: boolean; wakeId: string; token: string; }
async function injectWake(b: InjectBody): Promise<InjectResult> {
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as InjectResult;
}

const A_REPLY_POST = "reply.post";
const A_PROSE_DELIVERED = "turn.direct_mention_prose_delivered";
const A_PROSE_DROPPED = "turn.supervisor_prose_dropped";
const A_NO_REPLY = "unified.no_reply";
const dS = (e: AuditWireEntry, k: string): string | undefined => (typeof e.detail?.[k] === "string" ? (e.detail![k] as string) : undefined);
const dB = (e: AuditWireEntry, k: string): boolean | undefined => (typeof e.detail?.[k] === "boolean" ? (e.detail![k] as boolean) : undefined);
const dN = (e: AuditWireEntry, k: string): number | undefined => (typeof e.detail?.[k] === "number" ? (e.detail![k] as number) : undefined);

async function auditWindow(sinceIso: string): Promise<readonly AuditWireEntry[]> {
  try { return await fetchAudit(TARGET, READ, { sinceIso, limit: 400 }); }
  catch (e) { console.warn(`  [audit] ${(e as Error).message}`); return []; }
}
function landedFor(rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry | undefined {
  return rows.find((e) => (e.action === A_REPLY_POST || e.action === A_PROSE_DELIVERED) && (dS(e, "wakeId") === wakeId || dS(e, "wakeId") === undefined));
}
function proseDrops(rows: readonly AuditWireEntry[]): { chars: number; replied: boolean }[] {
  return rows.filter((e) => e.action === A_PROSE_DROPPED).map((e) => ({ chars: dN(e, "chars") ?? 0, replied: dB(e, "replied") ?? false }));
}

interface TurnResult {
  turn: number; scenario: ScenarioId; label: string; expected: Expected; outcome: Outcome;
  wakeId: string | null; latencyMs: number | null; recall: { code: boolean; date: boolean; ref: boolean } | null;
  drops: { chars: number; replied: boolean }[]; replyPlatform: string | null; notes: string;
}

async function scoreProbe(wakeId: string, sinceIso: string, expected: Expected, t0: number): Promise<{ outcome: Outcome; latencyMs: number | null; drops: { chars: number; replied: boolean }[]; replyPlatform: string | null; notes: string; landedRow?: AuditWireEntry }> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await auditWindow(sinceIso);
    const landed = landedFor(rows, wakeId);
    const drops = proseDrops(rows);
    const silent = rows.some((e) => e.action === A_NO_REPLY);
    if (expected === "LANDED") {
      if (landed) return { outcome: "LANDED", latencyMs: Date.now() - t0, drops, replyPlatform: dS(landed, "platform") ?? null, notes: "reply.post joined by wakeId", landedRow: landed };
      const realDrop = drops.find((d) => !d.replied);
      if (realDrop) return { outcome: "DROP", latencyMs: null, drops, replyPlatform: null, notes: `prose dropped (${realDrop.chars} chars, replied=false)` };
      if (silent) return { outcome: "NO_ACTION", latencyMs: null, drops, replyPlatform: null, notes: "no_reply on a reply-warranted probe (judged silent — recall miss or over-cautious)" };
    } else {
      if (landed) return { outcome: "OVER_REPLY", latencyMs: Date.now() - t0, drops, replyPlatform: dS(landed, "platform") ?? null, notes: "posted despite human↔human chatter" };
      if (silent) return { outcome: "SILENT_OK", latencyMs: null, drops, replyPlatform: null, notes: "unified.no_reply audited, nothing posted" };
    }
    await sleep(POLL_MS);
  }
  const rows = await auditWindow(sinceIso);
  const drops = proseDrops(rows);
  const realDrop = drops.find((d) => !d.replied);
  if (expected === "SILENT_OK") return { outcome: "SILENT_OK", latencyMs: null, drops, replyPlatform: null, notes: "timeout with no post (treated as silence held)" };
  return { outcome: realDrop ? "DROP" : "NO_ACTION", latencyMs: null, drops, replyPlatform: null, notes: realDrop ? `prose dropped (${realDrop.chars} chars)` : "timeout, no terminal signal" };
}

async function readSlackReplyBody(sinceIso: string): Promise<string | null> {
  try {
    const { resolveSlack } = await import("../e2e/env.js");
    const { SlackDriver } = await import("../e2e/slack-driver.js");
    const r = resolveSlack();
    if (!r.ok || !SLACK_CHANNEL_ID) return null;
    const drv = new SlackDriver({ token: r.cfg.token, channel: SLACK_CHANNEL_ID, botUserId: r.cfg.botUserId });
    const floorTs = `${Math.floor(new Date(sinceIso).getTime() / 1000)}.000000`;
    const hist = await drv.history(floorTs).catch(() => []);
    const bot = hist.find((m) => drv.isBotReply(m));
    return bot?.text ?? null;
  } catch { return null; }
}

interface Surfaces { slack: boolean; notion: boolean; }

async function runScenario(id: ScenarioId, turn: number, fact: { code: string; date: string; ref: string }, surf: Surfaces): Promise<TurnResult> {
  const spec = SCENARIOS[id];
  const base: TurnResult = { turn, scenario: id, label: spec.label, expected: spec.expected, outcome: "NO_ACTION", wakeId: null, latencyMs: null, recall: null, drops: [], replyPlatform: null, notes: "" };
  if (spec.needs.some((n) => !surf[n])) return { ...base, outcome: "SKIP", notes: `missing surface(s): ${spec.needs.filter((n) => !surf[n]).join(",")}` };

  const slackOrigin = { platform: "slack", channelId: SLACK_CHANNEL_ID };
  const notionOrigin = { platform: "notion", discussionId: NOTION_DISCUSSION };
  const factLine = `Team — locking codename ${fact.code}, ship date ${fact.date}, ref ${fact.ref}. Holding other releases that day.`;
  const ask = `what codename, date and ref did we just lock in? reply here with all three.`;

  if (id === "S3") {
    const sinceIso = new Date().toISOString();
    const t0 = Date.now();
    const { wakeId } = await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "channel-watch", author: "alex", origin: slackOrigin, text: `morning all — anyone grabbing coffee before standup? heading down in 5.` });
    const s = await scoreProbe(wakeId, sinceIso, "SILENT_OK", t0);
    return { ...base, wakeId, outcome: s.outcome, latencyMs: s.latencyMs, drops: s.drops, replyPlatform: s.replyPlatform, notes: s.notes };
  }

  const stateOn = id === "S4" ? "notion" : "slack";
  if (stateOn === "notion") {
    await injectWake({ domain: DOMAIN, platform: "notion", surfaceKey: NOTION_SURFACE, addressing: "channel-watch", author: "sam", origin: notionOrigin, text: factLine }).catch((e) => console.warn(`  state-wake failed: ${(e as Error).message}`));
  } else {
    await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "channel-watch", author: "sam", origin: slackOrigin, text: factLine }).catch((e) => console.warn(`  state-wake failed: ${(e as Error).message}`));
  }
  await sleep(FACT_WAIT_MS);

  const sinceIso = new Date().toISOString();
  const t0 = Date.now();
  let wakeId: string;
  if (id === "S2") {
    const r = await injectWake({ domain: DOMAIN, platform: "notion", surfaceKey: NOTION_SURFACE, addressing: "channel-watch", author: "sam", origin: notionOrigin, text: `open everywhere — ${ask}` });
    wakeId = r.wakeId;
  } else {
    const r = await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "direct-mention", mention: true, author: "sam", origin: slackOrigin, text: ask });
    wakeId = r.wakeId;
  }
  const s = await scoreProbe(wakeId, sinceIso, "LANDED", t0);
  let recall: TurnResult["recall"] = null;
  if (s.outcome === "LANDED" && s.replyPlatform === "slack") {
    const body = await readSlackReplyBody(sinceIso);
    if (body) recall = recallHit(body, fact);
  }
  return { ...base, wakeId, outcome: s.outcome, latencyMs: s.latencyMs, drops: s.drops, replyPlatform: s.replyPlatform, recall, notes: s.notes + (recall ? ` recall:${recall.code ? "c" : "·"}${recall.date ? "d" : "·"}${recall.ref ? "r" : "·"}` : "") };
}

async function injectFiller(n: number): Promise<number> {
  let ok = 0;
  const origin = { platform: "slack", channelId: SLACK_CHANNEL_ID };
  for (let i = 0; i < n; i++) {
    try {
      await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "channel-watch", author: `fill${i}`, origin, text: `filler ${i}: just chatting about the weekend plans, nothing actionable here.` });
      ok++;
      await sleep(1500);
    } catch (e) { console.warn(`  filler ${i} failed: ${(e as Error).message}`); }
  }
  return ok;
}

function summarize(turns: readonly TurnResult[]) {
  const rExp = turns.filter((t) => t.expected === "LANDED" && t.outcome !== "SKIP");
  const landed = rExp.filter((t) => t.outcome === "LANDED");
  const sExp = turns.filter((t) => t.expected === "SILENT_OK" && t.outcome !== "SKIP");
  const silent = sExp.filter((t) => t.outcome === "SILENT_OK");
  const drops = turns.flatMap((t) => t.drops);
  const lRec = landed.filter((t) => t.recall);
  const full = lRec.filter((t) => t.recall!.code && t.recall!.date && t.recall!.ref);
  const rate = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
  return {
    reply_landed_rate: { landed: landed.length, of: rExp.length, rate: rate(landed.length, rExp.length) },
    prose_drop_count: { total: drops.length, repliedFalse: drops.filter((d) => !d.replied).length, repliedTrue: drops.filter((d) => d.replied).length },
    silence_precision: { silent: silent.length, of: sExp.length, rate: rate(silent.length, sExp.length) },
    recall_accuracy: { full: full.length, ofLandedRead: lRec.length, rate: rate(full.length, lRec.length) },
  };
}

const slug = (m: string): string => m.replace(/[^a-z0-9]+/gi, "-");

async function main() {
  const cli = parseCli(process.argv.slice(2));
  DOMAIN = cli.domain;
  const series = seriesOf(cli.turns);
  const effort = clampReasoning(cli.effort, DOMAIN_CEILING) ?? cli.effort;
  if (effort !== cli.effort) console.warn(`⚠ --effort "${cli.effort}" > ceiling "${DOMAIN_CEILING}" — clamped to "${effort}".`);
  if (!isModelUsable(cli.model, ALLOW_POLICY)) {
    console.error(`✗ --model "${cli.model}" not in allow-list ${JSON.stringify(ALLOW_POLICY.allow!.map((a) => a.id))}. Add it to agent/model/policy.ts + ALLOW_POLICY, redeploy.`);
    process.exit(1);
  }
  const surf: Surfaces = { slack: SLACK_SURFACE.length > 0, notion: NOTION_SURFACE.length > 0 && NOTION_DISCUSSION.length > 0 };

  console.log(`\n=== ambient-eval (spoofed-wake injection) ===`);
  console.log(`model:   ${cli.model} @ ${effort}`);
  console.log(`domain:  ${cli.domain}   org: ${cli.org}`);
  console.log(`turns:   ${cli.turns}   fill: ${cli.fill}   rotate: ${cli.rotate}   plan-only: ${cli.plan}`);
  console.log(`surfaces: slack=${surf.slack}${surf.slack ? ` (${SLACK_SURFACE})` : ""}  notion=${surf.notion}${surf.notion ? ` (${NOTION_SURFACE})` : ""}`);
  console.log(`waits:   fact=${FACT_WAIT_MS}ms reply-timeout=${REPLY_TIMEOUT_MS}ms poll=${POLL_MS}ms`);
  console.log(`\nseries (turn → scenario):`);
  for (let i = 0; i < series.length; i++) {
    const s = SCENARIOS[series[i]];
    const skip = s.needs.some((n) => !surf[n]) && !cli.plan ? "  [WILL SKIP — surface absent]" : "";
    console.log(`  T${i + 1}: ${s.id}  ${s.label}   [expect ${s.expected}]${skip}`);
  }
  if (cli.plan) { console.log(`\n(plan-only — no store writes, no injection.)`); return; }

  if (!TARGET || !READ) { console.error("\n✗ need E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN"); process.exit(1); }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("\n✗ DATABASE_URL required (live Neon) for the pick + rotate"); process.exit(1); }
  if (!surf.slack) { console.error("\n✗ EVAL_SLACK_SURFACE required for any live run (S1/S3/S4 all use Slack)"); process.exit(1); }

  const store: OperationalStore = await wireNeonOperationalStore(dbUrl);
  const prior: DomainModelRow | null = await store.getDomainModel(cli.org, cli.domain);
  console.log(`\nprior pick: ${prior ? JSON.stringify({ modelId: prior.modelId, reasoning: prior.reasoning }) : "none (git route)"}`);
  await store.setDomainModel(cli.org, cli.domain, { modelId: cli.model, reasoning: effort }, "ambient-eval");
  console.log(`set  pick: ${JSON.stringify({ modelId: cli.model, reasoning: effort })}`);

  const run = Date.now().toString().slice(-5);
  const turns: TurnResult[] = [];
  try {
    if (cli.rotate) {
      const r = await rotateUnifiedWindow(store, cli.org, cli.domain);
      console.log(`\nrotated window: ${r.oldToken ?? "none"} → ${r.newRow.token}`);
    } else console.log(`\n(--no-rotate: running on the ACCUMULATED window)`);

    if (cli.fill > 0) {
      console.log(`\ninjecting ${cli.fill} filler ambient wakes to grow the window...`);
      const filled = await injectFiller(cli.fill);
      console.log(`  ${filled}/${cli.fill} filler wakes injected`);
      await sleep(FACT_WAIT_MS);
    }

    for (let i = 0; i < series.length; i++) {
      const fact = freshFact(run, i + 1);
      console.log(`\n── T${i + 1}/${series.length} ${series[i]} ${SCENARIOS[series[i]].label} ─ fact ${fact.code}`);
      let res: TurnResult;
      try { res = await runScenario(series[i], i + 1, fact, surf); }
      catch (e) { res = { turn: i + 1, scenario: series[i], label: SCENARIOS[series[i]].label, expected: SCENARIOS[series[i]].expected, outcome: "NO_ACTION", wakeId: null, latencyMs: null, recall: null, drops: [], replyPlatform: null, notes: `ERROR: ${(e as Error).message}` }; }
      turns.push(res);
      console.log(`   → ${res.outcome}  (lat ${res.latencyMs ? Math.round(res.latencyMs / 1000) + "s" : "-"})  ${res.notes}`);
    }
  } finally {
    if (cli.restore) {
      try {
        if (prior) await store.setDomainModel(cli.org, cli.domain, { modelId: prior.modelId, reasoning: prior.reasoning }, "ambient-eval-restore");
        else await store.clearDomainModel(cli.org, cli.domain);
        console.log(`\nrestored pick: ${prior ? JSON.stringify({ modelId: prior.modelId, reasoning: prior.reasoning }) : "cleared (git route)"}`);
      } catch (e) { console.error(`⚠ FAILED to restore pick — domain left on ${cli.model}@${effort}. Fix manually. (${(e as Error).message})`); }
    }
  }

  const summary = summarize(turns);
  console.log(`\n=== TRAJECTORY (${cli.model}@${effort}) ===`);
  for (const t of turns) {
    const rec = t.recall ? `${t.recall.code ? "c" : "·"}${t.recall.date ? "d" : "·"}${t.recall.ref ? "r" : "·"}` : "—";
    console.log(`T${String(t.turn).padEnd(3)} ${t.scenario}  ${t.expected.padEnd(10)} ${t.outcome.padEnd(11)} ${(t.latencyMs ? Math.round(t.latencyMs / 1000) + "s" : "-").padEnd(5)} rec:${rec}  ${t.notes}`);
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`reply_landed_rate ⭐ : ${summary.reply_landed_rate.landed}/${summary.reply_landed_rate.of} = ${summary.reply_landed_rate.rate ?? "n/a"}`);
  console.log(`prose_drop_count     : ${summary.prose_drop_count.total} (replied=false ${summary.prose_drop_count.repliedFalse} ← real, replied=true ${summary.prose_drop_count.repliedTrue} harmless)`);
  console.log(`silence_precision    : ${summary.silence_precision.silent}/${summary.silence_precision.of} = ${summary.silence_precision.rate ?? "n/a"}`);
  console.log(`recall_accuracy      : ${summary.recall_accuracy.full}/${summary.recall_accuracy.ofLandedRead} = ${summary.recall_accuracy.rate ?? "n/a"} (best-effort read-back)`);

  const outDir = join(process.cwd(), "scripts/eval/results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `ambient-eval-${slug(cli.model)}-${effort}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify({ config: { model: cli.model, effort, domain: cli.domain, org: cli.org, turns: cli.turns, fill: cli.fill, rotate: cli.rotate }, series, turns, summary, startedAt: new Date().toISOString() }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => { console.error("AMBIENT-EVAL FAILED:", e); process.exit(1); });
