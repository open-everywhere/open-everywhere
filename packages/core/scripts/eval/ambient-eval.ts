import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fetchAudit, type AuditWireEntry } from "../e2e/audit-read.js";
import { fetchTranscript, type TranscriptWireEvent } from "../e2e/transcript-read.js";
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
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.AMBIENT_REPLY_TIMEOUT_MS ?? "240000", 10);
const POLL_MS = Number.parseInt(process.env.AMBIENT_POLL_MS ?? "7000", 10);

const SLACK_SURFACE = (process.env.EVAL_SLACK_SURFACE ?? "").trim();
const NOTION_SURFACE = (process.env.EVAL_NOTION_SURFACE ?? "").trim();
const NOTION_DISCUSSION = (process.env.EVAL_NOTION_DISCUSSION ?? "").trim();
const SLACK_CHANNEL_ID = SLACK_SURFACE.split("/").slice(2).join("/");

let DOMAIN = "e2e-unified";

interface Cli {
  model: string; effort: ModelReasoning; turns: number; fill: number; repeats: number;
  domain: string; org: string; plan: boolean; rotate: boolean; restore: boolean;
  rescore?: string; since?: string; until?: string;
}
function parseCli(argv: readonly string[]): Cli {
  const get = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
  const has = (f: string): boolean => argv.includes(f);
  const effRaw = (get("--effort") ?? "high").toLowerCase();
  return {
    model: get("--model") ?? "deepseek/deepseek-v4-flash",
    effort: (effRaw === "med" ? "medium" : effRaw) as ModelReasoning,
    turns: Math.max(1, Number.parseInt(get("--turns") ?? String(SERIES_PATTERN.length), 10)),
    fill: Math.max(0, Number.parseInt(get("--fill") ?? "0", 10)),
    repeats: Math.max(1, Number.parseInt(get("--repeats") ?? "1", 10)),
    domain: get("--domain") ?? process.env.E2E_UNIFIED_DOMAIN ?? "e2e-unified",
    org: get("--org") ?? process.env.E2E_ORG ?? "default",
    plan: has("--plan") || has("--dry-run"),
    rotate: !has("--no-rotate"),
    restore: !has("--no-restore"),
    rescore: get("--rescore"),
    since: get("--since"),
    until: get("--until"),
  };
}

type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5";
type Expected = "LANDED" | "SILENT_OK";
type Outcome =
  | "LANDED_VIA_REPLY_TOOL"
  | "LANDED_VIA_REDRIVE"
  | "LANDED_VIA_BRIDGE"
  | "DROP"
  | "JUDGED_SILENT"
  | "SILENT_OK"
  | "OVER_REPLY"
  | "NO_ACTION"
  | "SKIP";

type FailureClass = "ANSWER_NO_TOOL" | "DELIBERATE_SILENCE" | "RECALL_MISS" | "OTHER" | "unjudged" | "n/a";

interface ScenarioSpec {
  id: ScenarioId; label: string; expected: Expected; needs: readonly ("slack" | "notion")[];
  soft?: boolean;
}
const SCENARIOS: Record<ScenarioId, ScenarioSpec> = {
  S1: { id: "S1", label: "reply @mention (Slack direct-mention; fact stated ambient on Slack)", expected: "LANDED", needs: ["slack"] },
  S2: { id: "S2", label: "namedrop recall (Notion direct-mention — Notion's addressed path, matches real namedrop ingest)", expected: "LANDED", needs: ["notion"] },
  S3: { id: "S3", label: "silence (Slack human↔human chatter, not addressed)", expected: "SILENT_OK", needs: ["slack"] },
  S4: { id: "S4", label: "cross-surface recall (fact on Notion → recalled on Slack @mention)", expected: "LANDED", needs: ["slack", "notion"] },
  S5: { id: "S5", label: "TRUE ambient step-in (Notion channel-watch, no namedrop; reply helpful, silence defensible)", expected: "LANDED", soft: true, needs: ["slack", "notion"] },
};
const SERIES_PATTERN: readonly ScenarioId[] = ["S4", "S2", "S3", "S2", "S1", "S5", "S2", "S3", "S2", "S5"];
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

type InjectionKind = "state" | "probe" | "chatter" | "filler";
interface Injection {
  readonly wakeId: string;
  readonly injectedAt: string;
  readonly kind: InjectionKind;
  readonly turn: number;
  readonly scenario?: ScenarioId;
  readonly addressing: "channel-watch" | "direct-mention";
  readonly platform: string;
  readonly text: string | null;
}
const injections: Injection[] = [];

interface InjectBody {
  domain: string; platform: string; surfaceKey: string; text: string;
  addressing?: string; origin: Record<string, unknown>; mention?: boolean; author?: string; threadTs?: string;
}
async function injectWake(b: InjectBody, kind: InjectionKind, turn: number, scenario?: ScenarioId): Promise<Injection> {
  const res = await fetch(`${TARGET}/control/v1/test/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ}`, "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  if (!res.ok) throw new Error(`inject ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const jb = (await res.json()) as { wakeId: string };
  const inj: Injection = {
    wakeId: jb.wakeId,
    injectedAt: new Date().toISOString(),
    kind,
    turn,
    ...(scenario !== undefined ? { scenario } : {}),
    addressing: b.addressing === "direct-mention" ? "direct-mention" : "channel-watch",
    platform: b.platform,
    text: b.text,
  };
  injections.push(inj);
  return inj;
}

const A_REPLY_POST = "reply.post";
const A_PROSE_DELIVERED = "turn.direct_mention_prose_delivered";
const A_PROSE_DROPPED = "turn.supervisor_prose_dropped";
const A_NO_REPLY = "unified.no_reply";
const A_BRIDGE_UNRESOLVED = "turn.direct_mention_bridge_unresolved";
const A_BRIDGE_FAILED = "turn.direct_mention_bridge_post_failed";
const A_REDRIVE = "unified.turn.redrive";
const COMPLETION_ACTIONS: ReadonlySet<string> = new Set([A_NO_REPLY, A_PROSE_DROPPED, A_PROSE_DELIVERED, A_BRIDGE_UNRESOLVED, A_BRIDGE_FAILED]);

const dS = (e: AuditWireEntry, k: string): string | undefined => (typeof e.detail?.[k] === "string" ? (e.detail![k] as string) : undefined);
const dB = (e: AuditWireEntry, k: string): boolean | undefined => (typeof e.detail?.[k] === "boolean" ? (e.detail![k] as boolean) : undefined);
const dN = (e: AuditWireEntry, k: string): number | undefined => (typeof e.detail?.[k] === "number" ? (e.detail![k] as number) : undefined);

interface Attribution {
  readonly completionOf: ReadonlyMap<string, AuditWireEntry>;
  readonly replyPostsOf: ReadonlyMap<string, readonly AuditWireEntry[]>;
  readonly sessionId: string | null;
  readonly completions: readonly AuditWireEntry[];
  readonly redrivenWakeIds: ReadonlySet<string>;
  readonly notes: readonly string[];
}

function attributeOutcomes(injs: readonly Injection[], rows: readonly AuditWireEntry[]): Attribution {
  const notes: string[] = [];
  const asc = rows.slice().sort((a, b) => a.ts.localeCompare(b.ts));

  const replyPostsOf = new Map<string, AuditWireEntry[]>();
  for (const r of asc) {
    if (r.action !== A_REPLY_POST) continue;
    const w = dS(r, "wakeId");
    if (!w) continue;
    if (!replyPostsOf.has(w)) replyPostsOf.set(w, []);
    replyPostsOf.get(w)!.push(r);
  }

  let completions = asc.filter((r) => r.platform === "unified" && COMPLETION_ACTIONS.has(r.action));
  const sidCounts = new Map<string, number>();
  for (const r of completions) {
    const sid = dS(r, "sessionId");
    if (sid) sidCounts.set(sid, (sidCounts.get(sid) ?? 0) + 1);
  }
  const sessionId = [...sidCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (sessionId) {
    const before = completions.length;
    completions = completions.filter((r) => (dS(r, "sessionId") ?? sessionId) === sessionId);
    if (completions.length !== before) notes.push(`${before - completions.length} completion row(s) from other session(s) excluded (eval session ${sessionId})`);
  }

  const redriveRows = asc.filter((r) => r.platform === "unified" && r.action === A_REDRIVE && (sessionId === null || (dS(r, "sessionId") ?? sessionId) === sessionId));
  const redrivenWakeIds = new Set(redriveRows.map((r) => dS(r, "originalWakeId")).filter((w): w is string => !!w));
  if (redriveRows.length > 0) {
    const timeline = [
      ...completions.map((row) => ({ kind: "c" as const, row })),
      ...redriveRows.map((row) => ({ kind: "r" as const, row })),
    ].sort((a, b) => a.row.ts.localeCompare(b.row.ts) || (a.kind === b.kind ? 0 : a.kind === "c" ? -1 : 1));
    const corrective = new Set<AuditWireEntry>();
    let armed = 0;
    for (const item of timeline) {
      if (item.kind === "r") armed++;
      else if (armed > 0) { corrective.add(item.row); armed--; }
    }
    const before = completions.length;
    completions = completions.filter((c) => !corrective.has(c));
    notes.push(`${redriveRows.length} auto-redrive(s) fired → ${before - completions.length} corrective-turn completion(s) pulled out of the FIFO (kept 1:1 with injections)`);
  }

  const sortedInjs = injs.slice().sort((a, b) => a.injectedAt.localeCompare(b.injectedAt));
  const completionOf = new Map<string, AuditWireEntry>();

  const isBridgeRow = (c: AuditWireEntry): boolean =>
    c.action === A_PROSE_DELIVERED || c.action === A_BRIDGE_UNRESOLVED || c.action === A_BRIDGE_FAILED;

  const fifoValid =
    completions.length === sortedInjs.length &&
    completions.every((c, i) => !isBridgeRow(c) || sortedInjs[i].addressing === "direct-mention");

  if (fifoValid) {
    completions.forEach((c, i) => completionOf.set(sortedInjs[i].wakeId, c));
  } else {
    notes.push(
      `FIFO 1:1 broke (${sortedInjs.length} injections vs ${completions.length} completions${completions.length === sortedInjs.length ? ", bridge-row misalignment" : ""}) — semantic fallback used; treat per-turn attribution as approximate`,
    );
    const usedC = new Set<number>();
    const usedI = new Set<number>();
    const dmInjs = sortedInjs.map((inj, i) => ({ inj, i })).filter((x) => x.inj.addressing === "direct-mention");
    let dmCursor = 0;
    completions.forEach((c, ci) => {
      if (isBridgeRow(c) && dmCursor < dmInjs.length) {
        const { inj, i } = dmInjs[dmCursor++];
        completionOf.set(inj.wakeId, c);
        usedC.add(ci);
        usedI.add(i);
      }
    });
    let icur = 0;
    completions.forEach((c, ci) => {
      if (usedC.has(ci)) return;
      while (icur < sortedInjs.length && usedI.has(icur)) icur++;
      if (icur >= sortedInjs.length) return;
      completionOf.set(sortedInjs[icur].wakeId, c);
      usedI.add(icur);
      icur++;
    });
  }

  return { completionOf, replyPostsOf, sessionId, completions, redrivenWakeIds, notes };
}

function outcomeFor(
  inj: Injection,
  expected: Expected,
  attribution: Attribution,
): { outcome: Outcome; latencyMs: number | null; notes: string; matched: AuditWireEntry[] } {
  const posts = attribution.replyPostsOf.get(inj.wakeId) ?? [];
  const c = attribution.completionOf.get(inj.wakeId);
  const matched = [...posts, ...(c ? [c] : [])];
  const lat = (row: AuditWireEntry): number => new Date(row.ts).getTime() - new Date(inj.injectedAt).getTime();

  if (posts.length > 0) {
    if (expected === "SILENT_OK") {
      return { outcome: "OVER_REPLY", latencyMs: lat(posts[0]), notes: `reply.post (wakeId-joined) on a silence-warranted turn`, matched };
    }
    if (attribution.redrivenWakeIds.has(inj.wakeId)) {
      return { outcome: "LANDED_VIA_REDRIVE", latencyMs: lat(posts[0]), notes: `reply.post wakeId-joined AFTER auto-redrive → ${dS(posts[0], "platform") ?? "?"} (first-try was a prose drop; the redrive rescued it)`, matched };
    }
    return { outcome: "LANDED_VIA_REPLY_TOOL", latencyMs: lat(posts[0]), notes: `reply.post wakeId-joined → ${dS(posts[0], "platform") ?? "?"}`, matched };
  }
  if (!c) return { outcome: "NO_ACTION", latencyMs: null, notes: "no completion attributable (pending or timed out)", matched };

  switch (c.action) {
    case A_PROSE_DELIVERED:
      return expected === "SILENT_OK"
        ? { outcome: "OVER_REPLY", latencyMs: lat(c), notes: `bridge delivery attributed to a silence-warranted turn (${dN(c, "chars")}c)`, matched }
        : { outcome: "LANDED_VIA_BRIDGE", latencyMs: lat(c), notes: `prose bridged to ${dS(c, "platform") ?? "?"} (${dN(c, "chars")}c) — model used PROSE on a mention (rescued, adherence-relevant)`, matched };
    case A_PROSE_DROPPED: {
      const replied = dB(c, "replied") ?? false;
      if (expected === "SILENT_OK") {
        return { outcome: "SILENT_OK", latencyMs: null, notes: `silence held EXTERNALLY but the model wrote prose (${dN(c, "chars")}c, replied=${replied}) — gated drop`, matched };
      }
      return { outcome: "DROP", latencyMs: null, notes: `prose dropped (${dN(c, "chars")}c, replied=${replied})${replied ? " — after a real reply (harmless wrap-up?)" : ""}`, matched };
    }
    case A_BRIDGE_UNRESOLVED:
    case A_BRIDGE_FAILED:
      return { outcome: "DROP", latencyMs: null, notes: `${c.action} — answer owed and lost (delivery failure, not model judgment)`, matched };
    case A_NO_REPLY: {
      const reason = dS(c, "reason") ?? "";
      return expected === "SILENT_OK"
        ? { outcome: "SILENT_OK", latencyMs: null, notes: `no_reply (${reason})`, matched }
        : { outcome: "JUDGED_SILENT", latencyMs: null, notes: `no_reply (${reason}) on a reply-warranted probe — judgment/recall miss, NOT a drop`, matched };
    }
    default:
      return { outcome: "NO_ACTION", latencyMs: null, notes: `unrecognised completion ${c.action}`, matched };
  }
}

interface TurnResult {
  turn: number;
  scenario: ScenarioId;
  label: string;
  expected: Expected;
  outcome: Outcome;
  probe: Injection | null;
  state: Injection | null;
  latencyMs: number | null;
  recall: { code: boolean; date: boolean; ref: boolean } | null;
  matchedRows: AuditWireEntry[];
  notes: string;
  failureClass?: FailureClass;
  failureRationale?: string;
  droppedProse?: string | null;
  reasoningSlice?: string | null;
}

function summarize(turns: readonly TurnResult[], allRows: readonly AuditWireEntry[], sessionId: string | null) {
  const isSoft = (t: TurnResult): boolean => SCENARIOS[t.scenario].soft === true;
  const softTurns = turns.filter((t) => isSoft(t) && t.outcome !== "SKIP");
  const rExp = turns.filter((t) => t.expected === "LANDED" && t.outcome !== "SKIP" && !isSoft(t));
  const landedTool = rExp.filter((t) => t.outcome === "LANDED_VIA_REPLY_TOOL");
  const landedRedrive = rExp.filter((t) => t.outcome === "LANDED_VIA_REDRIVE");
  const landedBridge = rExp.filter((t) => t.outcome === "LANDED_VIA_BRIDGE");
  const judgedSilent = rExp.filter((t) => t.outcome === "JUDGED_SILENT");
  const sExp = turns.filter((t) => t.expected === "SILENT_OK" && t.outcome !== "SKIP");
  const silent = sExp.filter((t) => t.outcome === "SILENT_OK");
  const dropRows = allRows.filter((r) => r.action === A_PROSE_DROPPED && (sessionId === null || (dS(r, "sessionId") ?? sessionId) === sessionId));
  const redriveRows = allRows.filter((r) => r.action === A_REDRIVE && (sessionId === null || (dS(r, "sessionId") ?? sessionId) === sessionId));
  const lRec = [...landedTool, ...landedRedrive, ...landedBridge].filter((t) => t.recall);
  const full = lRec.filter((t) => t.recall!.code && t.recall!.date && t.recall!.ref);
  const landedTotal = landedTool.length + landedRedrive.length + landedBridge.length;
  const rate = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
  const nonLanded = rExp.filter((t) => t.outcome === "DROP" || t.outcome === "JUDGED_SILENT" || t.outcome === "NO_ACTION");
  const fcCount = (c: FailureClass): number => nonLanded.filter((t) => t.failureClass === c).length;
  const softLanded = softTurns.filter((t) => t.outcome === "LANDED_VIA_REPLY_TOOL" || t.outcome === "LANDED_VIA_REDRIVE" || t.outcome === "LANDED_VIA_BRIDGE");
  return {
    soft_reply_rate: {
      landed: softLanded.length,
      of: softTurns.length,
      rate: rate(softLanded.length, softTurns.length),
      judged_silent: softTurns.filter((t) => t.outcome === "JUDGED_SILENT").length,
      drop: softTurns.filter((t) => t.outcome === "DROP").length,
      no_action: softTurns.filter((t) => t.outcome === "NO_ACTION").length,
    },
    reply_landed_rate: {
      landed: landedTotal,
      of: rExp.length,
      rate: rate(landedTotal, rExp.length),
      via_reply_tool: landedTool.length,
      via_redrive: landedRedrive.length,
      via_bridge: landedBridge.length,
    },
    reply_tool_adherence: { via_reply_tool: landedTool.length, of: rExp.length, rate: rate(landedTool.length, rExp.length) },
    adherence_after_redrive: { via_reply_tool_or_redrive: landedTool.length + landedRedrive.length, of: rExp.length, rate: rate(landedTool.length + landedRedrive.length, rExp.length), redrives_fired: redriveRows.length },
    judged_silent_count: judgedSilent.length,
    failure_class: { ANSWER_NO_TOOL: fcCount("ANSWER_NO_TOOL"), DELIBERATE_SILENCE: fcCount("DELIBERATE_SILENCE"), RECALL_MISS: fcCount("RECALL_MISS"), OTHER: fcCount("OTHER"), unjudged: fcCount("unjudged"), of: nonLanded.length },
    prose_drop_count: {
      total: dropRows.length,
      repliedFalse: dropRows.filter((r) => dB(r, "replied") === false).length,
      repliedTrue: dropRows.filter((r) => dB(r, "replied") === true).length,
    },
    silence_precision: { silent: silent.length, of: sExp.length, rate: rate(silent.length, sExp.length) },
    recall_accuracy: { full: full.length, ofLandedRead: lRec.length, rate: rate(full.length, lRec.length) },
  };
}

async function auditSince(sinceIso: string): Promise<readonly AuditWireEntry[]> {
  try { return await fetchAudit(TARGET, READ, { sinceIso, limit: 1000 }); }
  catch (e) { console.warn(`  [audit] ${(e as Error).message}`); return []; }
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

async function injectTurn(id: ScenarioId, turn: number, fact: { code: string; date: string; ref: string }, surf: Surfaces): Promise<{ probe: Injection | null; state: Injection | null; skip?: string }> {
  const spec = SCENARIOS[id];
  const missing = spec.needs.filter((n) => !surf[n]);
  if (missing.length > 0) return { probe: null, state: null, skip: `missing surface(s): ${missing.join(",")}` };

  const slackOrigin = { platform: "slack", channelId: SLACK_CHANNEL_ID };
  const notionOrigin = { platform: "notion", discussionId: NOTION_DISCUSSION };
  const factLine = `Team — locking codename ${fact.code}, ship date ${fact.date}, ref ${fact.ref}. Holding other releases that day.`;
  const ask = `what codename, date and ref did we just lock in? reply here with all three.`;

  if (id === "S3") {
    const probe = await injectWake(
      { domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "channel-watch", author: "alex", origin: slackOrigin, text: `morning all — anyone grabbing coffee before standup? heading down in 5.` },
      "chatter", turn, id,
    );
    return { probe, state: null };
  }

  const stateOn = id === "S4" ? "notion" : "slack";
  let state: Injection | null = null;
  try {
    state = stateOn === "notion"
      ? await injectWake({ domain: DOMAIN, platform: "notion", surfaceKey: NOTION_SURFACE, addressing: "channel-watch", author: "sam", origin: notionOrigin, threadTs: NOTION_DISCUSSION, text: factLine }, "state", turn, id)
      : await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "channel-watch", author: "sam", origin: slackOrigin, text: factLine }, "state", turn, id);
  } catch (e) { console.warn(`  state-wake failed: ${(e as Error).message}`); }
  await sleep(FACT_WAIT_MS);

  let probe: Injection;
  if (id === "S2") {
    probe = await injectWake({ domain: DOMAIN, platform: "notion", surfaceKey: NOTION_SURFACE, addressing: "direct-mention", mention: true, author: "sam", origin: notionOrigin, threadTs: NOTION_DISCUSSION, text: `open everywhere — ${ask}` }, "probe", turn, id);
  } else if (id === "S5") {
    probe = await injectWake({ domain: DOMAIN, platform: "notion", surfaceKey: NOTION_SURFACE, addressing: "channel-watch", author: "alex", origin: notionOrigin, threadTs: NOTION_DISCUSSION, text: `hmm, does anyone remember the codename, date and ref we locked in earlier? I can't find them anywhere.` }, "probe", turn, id);
  } else {
    probe = await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "direct-mention", mention: true, author: "sam", origin: slackOrigin, text: ask }, "probe", turn, id);
  }
  return { probe, state };
}

interface OldResults {
  config: Record<string, unknown>;
  series: ScenarioId[];
  turns: { turn: number; scenario: ScenarioId; wakeId?: string | null; probe?: { wakeId: string } | null; expected: Expected; outcome?: Outcome }[];
  injections?: Injection[];
  startedAt?: string;
  seriesStartedAt?: string;
  finishedAt?: string;
}

async function rescoreRun(cli: Cli): Promise<void> {
  const path = cli.rescore!;
  const old = JSON.parse(readFileSync(path, "utf8")) as OldResults;
  const anchor = old.seriesStartedAt ?? old.startedAt ?? new Date().toISOString();
  const since = cli.since ?? new Date(new Date(anchor).getTime() - 20 * 60_000).toISOString();
  const until = cli.until ?? (old.finishedAt ? new Date(new Date(old.finishedAt).getTime() + 5 * 60_000).toISOString() : new Date(new Date(anchor).getTime() + 10 * 60_000).toISOString());
  console.log(`\n=== ambient-eval RESCORE ===\nfile:   ${path}\nwindow: ${since} → ${until}`);

  const rows = (await auditSince(since)).filter((r) => r.ts <= until);
  if (rows.length === 0) { console.error("no audit rows in the window — check --since/--until"); process.exit(1); }
  console.log(`audit rows in window: ${rows.length}`);

  const probeByWake = new Map<string, { turn: number; scenario: ScenarioId; expected: Expected }>();
  for (const t of old.turns) {
    const w = t.probe?.wakeId ?? t.wakeId;
    if (w) probeByWake.set(w, { turn: t.turn, scenario: t.scenario, expected: t.expected });
  }

  injections.length = 0;
  if (Array.isArray(old.injections) && old.injections.length > 0) {
    injections.push(...old.injections);
    console.log(`using the results file's own injection log: ${injections.length} injections (authoritative)`);
  } else {
    for (const r of rows.slice().sort((a, b) => a.ts.localeCompare(b.ts))) {
      if (r.action !== "control.service_call" || dS(r, "view") !== "test_wake") continue;
      const wakeId = dS(r, "wakeId") ?? "";
      const probe = probeByWake.get(wakeId);
      injections.push({
        wakeId,
        injectedAt: r.ts,
        kind: probe ? (probe.scenario === "S3" ? "chatter" : "probe") : "state",
        turn: probe?.turn ?? 0,
        ...(probe ? { scenario: probe.scenario } : {}),
        addressing: dS(r, "addressing") === "direct-mention" ? "direct-mention" : "channel-watch",
        platform: dS(r, "injectedPlatform") ?? "?",
        text: null,
      });
    }
    console.log(`reconstructed ${injections.length} injections from audit (legacy file without injections[]; ${injections.filter((i) => i.kind !== "state").length} probes/chatter)`);
  }

  const attribution = attributeOutcomes(injections, rows);
  for (const n of attribution.notes) console.log(`  [attribution] ${n}`);

  const turns: TurnResult[] = old.turns.map((t) => {
    const spec = SCENARIOS[t.scenario];
    const w = t.probe?.wakeId ?? t.wakeId;
    const probe = injections.find((i) => i.wakeId === w) ?? null;
    const state = injections.find((i) => i.kind === "state" && i.turn === t.turn) ?? null;
    if (!probe) {
      return { turn: t.turn, scenario: t.scenario, label: spec.label, expected: t.expected, outcome: "SKIP" as Outcome, probe: null, state, latencyMs: null, recall: null, matchedRows: [], notes: "probe wakeId not found in the injection log / audit window" };
    }
    const o = outcomeFor(probe, t.expected, attribution);
    return { turn: t.turn, scenario: t.scenario, label: spec.label, expected: t.expected, outcome: o.outcome, probe, state, latencyMs: o.latencyMs, recall: null, matchedRows: o.matched, notes: `[rescored] ${o.notes}` };
  });

  const disagreements: string[] = [];
  const freshFormat = Array.isArray(old.injections) && old.injections.length > 0;
  if (freshFormat) {
    for (const t of old.turns) {
      if (!t.outcome || t.outcome === "SKIP") continue;
      const rescored = turns.find((x) => x.turn === t.turn);
      if (rescored && rescored.outcome !== t.outcome) {
        disagreements.push(`T${t.turn} ${t.scenario}: live=${t.outcome} rescored=${rescored.outcome}`);
      }
    }
    if (disagreements.length > 0) {
      console.warn(`\n⚠ RESCORE DISAGREES with the live outcomes the file carries (${disagreements.length} turn(s)) — suspect attribution (window bleed / FIFO break), NOT the model:`);
      for (const d of disagreements) console.warn(`  ${d}`);
    } else if (old.turns.some((t) => t.outcome)) {
      console.log(`rescore reproduces the live outcomes 1:1 ✓`);
    }
  }

  const fc = await classifyFailures(turns, attribution);
  console.log(`  [failure-class] ${fc.note}`);

  const summary = summarize(turns, rows, attribution.sessionId);
  printReport(turns, summary, attribution);

  const outPath = join(dirname(path), basename(path).replace(/\.json$/, "-rescored.json"));
  writeFileSync(outPath, JSON.stringify({
    rescoredFrom: path,
    rescoredAt: new Date().toISOString(),
    window: { since, until },
    config: old.config,
    series: old.series,
    sessionId: attribution.sessionId,
    attributionNotes: attribution.notes,
    liveDisagreements: disagreements,
    failureClassNote: fc.note,
    injections: [...injections],
    turns,
    completions: attribution.completions,
    summary,
  }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

interface TurnTexts { atEnd: string | null; prose: string; reasoning: string }

function evStr(data: unknown, keys: readonly string[]): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
      const inner = evStr(v, ["text", "content", "value"]);
      if (inner) return inner;
    }
  }
  return "";
}

function segmentTurns(events: readonly TranscriptWireEvent[]): TurnTexts[] {
  const turns: TurnTexts[] = [];
  let reasoning = "";
  let prose = "";
  for (const e of events) {
    const t = e.type;
    if (t.includes("reasoning")) {
      reasoning += evStr(e.data, ["delta", "text", "content"]);
    } else if (t === "message.appended" || t === "message.delta") {
      prose += evStr(e.data, ["delta", "text", "content", "message"]);
    } else if (t === "message.completed") {
      const finalProse = evStr(e.data, ["message", "text", "content"]) || prose;
      turns.push({ atEnd: e.at, prose: finalProse, reasoning });
      reasoning = "";
      prose = "";
    }
  }
  return turns;
}

function turnTextsFor(c: AuditWireEntry | undefined, segments: readonly TurnTexts[]): TurnTexts | null {
  if (!c || segments.length === 0) return null;
  const target = new Date(c.ts).getTime();
  let best: TurnTexts | null = null;
  let bestDelta = Infinity;
  for (const s of segments) {
    if (!s.atEnd) continue;
    const delta = Math.abs(new Date(s.atEnd).getTime() - target);
    if (delta < bestDelta) { bestDelta = delta; best = s; }
  }
  return best;
}

interface JudgeVerdict { failureClass: FailureClass; rationale: string }

async function judgeFailure(input: { probe: string; expectedFact: string; prose: string; reasoning: string }): Promise<JudgeVerdict | null> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return null;
  const base = (process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, "");
  const model = process.env.AMBIENT_JUDGE_MODEL ?? "openai/gpt-4o-mini";
  const sys =
    "You classify why an ambient team-assistant turn failed to deliver a reply. You are given the user's probe, " +
    "the fact the assistant should have recalled, the assistant's terminal prose (may be empty), and its reasoning trace. " +
    "Reply with STRICT JSON {\"class\":\"ANSWER_NO_TOOL|DELIBERATE_SILENCE|RECALL_MISS|OTHER\",\"why\":\"one line\"}. " +
    "ANSWER_NO_TOOL = it produced the answer (the fact) as prose but never called the reply tool. " +
    "DELIBERATE_SILENCE = it reasoned that no reply was warranted. " +
    "RECALL_MISS = it tried to answer but did not have/find the fact. OTHER = none of these.";
  const user = `PROBE:\n${input.probe}\n\nFACT TO RECALL:\n${input.expectedFact}\n\nTERMINAL PROSE:\n${input.prose || "(none)"}\n\nREASONING TRACE (truncated):\n${input.reasoning.slice(0, 6000) || "(none)"}`;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? "";
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { class?: string; why?: string };
    const cls = parsed.class;
    const failureClass: FailureClass =
      cls === "ANSWER_NO_TOOL" || cls === "DELIBERATE_SILENCE" || cls === "RECALL_MISS" || cls === "OTHER" ? cls : "OTHER";
    return { failureClass, rationale: (parsed.why ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

async function classifyFailures(turns: TurnResult[], attribution: Attribution): Promise<{ judged: boolean; note: string }> {
  const targets = turns.filter((t) => t.expected === "LANDED" && (t.outcome === "DROP" || t.outcome === "JUDGED_SILENT" || t.outcome === "NO_ACTION"));
  for (const t of turns) if (!targets.includes(t)) t.failureClass = "n/a";
  if (targets.length === 0) return { judged: true, note: "no non-landed reply-warranted turns to classify" };

  let segments: TurnTexts[] = [];
  let transcriptOk = false;
  if (attribution.sessionId) {
    try {
      const tr = await fetchTranscript(TARGET, READ, attribution.sessionId, { limit: 10000, idleMs: 1000 });
      segments = segmentTurns(tr.events);
      transcriptOk = true;
    } catch (e) {
      console.warn(`  [failure-class] transcript fetch failed (${(e as Error).message}) — stage 1 degraded, judging on prose=none`);
    }
  }

  let judgeReachable = !!process.env.AI_GATEWAY_API_KEY;
  let judgedAny = false;
  for (const t of targets) {
    const c = t.probe ? attribution.completionOf.get(t.probe.wakeId) : undefined;
    const seg = transcriptOk ? turnTextsFor(c, segments) : null;
    const prose = seg?.prose ?? null;
    const reasoning = seg?.reasoning ?? null;
    t.droppedProse = prose;
    t.reasoningSlice = reasoning ? reasoning.slice(0, 4000) : null;
    const code = t.state ? extractCodeFromFact(t.state.text) : null;
    const codeInProse = code && prose ? prose.toLowerCase().includes(code.toLowerCase()) : false;
    if (codeInProse) {
      t.failureClass = "ANSWER_NO_TOOL";
      t.failureRationale = "deterministic: the terminal prose contains the planted codename — the model answered but never called the reply tool";
      continue;
    }
    if (!judgeReachable) { t.failureClass = "unjudged"; t.failureRationale = "no AI_GATEWAY_API_KEY reachable — stage-2 skipped"; continue; }
    const verdict = await judgeFailure({
      probe: t.probe?.text ?? "",
      expectedFact: t.state?.text ?? "(none)",
      prose: prose ?? "",
      reasoning: reasoning ?? "",
    });
    if (!verdict) { judgeReachable = false; t.failureClass = "unjudged"; t.failureRationale = "judge call failed/unreachable — stage-2 skipped from here on"; continue; }
    judgedAny = true;
    t.failureClass = verdict.failureClass;
    t.failureRationale = `judge(${process.env.AMBIENT_JUDGE_MODEL ?? "openai/gpt-4o-mini"}): ${verdict.rationale}`;
  }

  const note = process.env.AI_GATEWAY_API_KEY
    ? judgedAny
      ? `stage-1 deterministic + stage-2 LLM judge (${process.env.AMBIENT_JUDGE_MODEL ?? "openai/gpt-4o-mini"})${transcriptOk ? "" : "; transcript unavailable → prose=none"}`
      : `stage-1 deterministic only (no turn needed the judge)${transcriptOk ? "" : "; transcript unavailable"}`
    : `stage-1 deterministic only — NO judge credential (AI_GATEWAY_API_KEY) reachable; stage-2 turns marked "unjudged"`;
  return { judged: !!process.env.AI_GATEWAY_API_KEY, note };
}

function extractCodeFromFact(factText: string | null): string | null {
  if (!factText) return null;
  const m = /codename\s+([A-Z]+ [A-Z]+-[a-z0-9]+)/i.exec(factText);
  return m ? m[1] : null;
}

function printReport(turns: readonly TurnResult[], summary: ReturnType<typeof summarize>, attribution: Attribution): void {
  console.log(`\n=== TRAJECTORY (session ${attribution.sessionId ?? "?"}) ===`);
  for (const t of turns) {
    const rec = t.recall ? `${t.recall.code ? "c" : "·"}${t.recall.date ? "d" : "·"}${t.recall.ref ? "r" : "·"}` : "—";
    const fc = t.failureClass && t.failureClass !== "n/a" ? `  ✗${t.failureClass}` : "";
    console.log(`T${String(t.turn).padEnd(3)} ${t.scenario}  ${t.expected.padEnd(10)} ${t.outcome.padEnd(22)} ${(t.latencyMs ? Math.round(t.latencyMs / 1000) + "s" : "-").padEnd(6)} rec:${rec}  ${t.notes}${fc}`);
  }
  console.log(`\n=== SUMMARY ===`);
  const s = summary;
  console.log(`reply_landed_rate ⭐  : ${s.reply_landed_rate.landed}/${s.reply_landed_rate.of} = ${s.reply_landed_rate.rate ?? "n/a"}  (reply_tool ${s.reply_landed_rate.via_reply_tool} + redrive ${s.reply_landed_rate.via_redrive} + bridge ${s.reply_landed_rate.via_bridge})`);
  console.log(`reply_tool_adherence  : ${s.reply_tool_adherence.via_reply_tool}/${s.reply_tool_adherence.of} = ${s.reply_tool_adherence.rate ?? "n/a"}  (strict FIRST-TRY axis — redrive + bridge rescues excluded)`);
  console.log(`adherence_after_redrive: ${s.adherence_after_redrive.via_reply_tool_or_redrive}/${s.adherence_after_redrive.of} = ${s.adherence_after_redrive.rate ?? "n/a"}  (first-try + auto-redrive rescues; ${s.adherence_after_redrive.redrives_fired} redrive(s) fired)`);
  console.log(`judged_silent_count   : ${s.judged_silent_count} (strict reply-warranted probes the model chose silence on)`);
  console.log(`soft_reply_rate (S5)  : ${s.soft_reply_rate.landed}/${s.soft_reply_rate.of} = ${s.soft_reply_rate.rate ?? "n/a"}  (judged_silent ${s.soft_reply_rate.judged_silent} defensible · drop ${s.soft_reply_rate.drop} · no_action ${s.soft_reply_rate.no_action}) — observation, silence is OK here`);
  console.log(`failure_class         : ANSWER_NO_TOOL ${s.failure_class.ANSWER_NO_TOOL} · DELIBERATE_SILENCE ${s.failure_class.DELIBERATE_SILENCE} · RECALL_MISS ${s.failure_class.RECALL_MISS} · OTHER ${s.failure_class.OTHER} · unjudged ${s.failure_class.unjudged}  (of ${s.failure_class.of} non-landed strict)`);
  console.log(`prose_drop_count      : ${s.prose_drop_count.total} window-wide (replied=false ${s.prose_drop_count.repliedFalse} ← real, replied=true ${s.prose_drop_count.repliedTrue})`);
  console.log(`silence_precision     : ${s.silence_precision.silent}/${s.silence_precision.of} = ${s.silence_precision.rate ?? "n/a"}`);
  console.log(`recall_accuracy       : ${s.recall_accuracy.full}/${s.recall_accuracy.ofLandedRead} = ${s.recall_accuracy.rate ?? "n/a"} (best-effort read-back)`);
}

const slug = (m: string): string => m.replace(/[^a-z0-9]+/gi, "-");

interface SeriesRunResult {
  readonly repeat: number;
  readonly turns: TurnResult[];
  readonly summary: ReturnType<typeof summarize>;
  readonly sessionId: string | null;
  readonly outPath: string;
}

async function runOneSeries(
  cli: Cli,
  effort: ModelReasoning,
  surf: Surfaces,
  store: OperationalStore,
  series: readonly ScenarioId[],
  repeat: number,
  totalRepeats: number,
): Promise<SeriesRunResult> {
  injections.length = 0;
  const run = Date.now().toString().slice(-5);
  const seriesStartedAt = new Date().toISOString();
  const pending: { turn: number; scenario: ScenarioId; probe: Injection | null; state: Injection | null; skip?: string; fact: ReturnType<typeof freshFact> }[] = [];

  if (cli.rotate) {
    const r = await rotateUnifiedWindow(store, cli.org, cli.domain);
    console.log(`\nrotated window: ${r.oldToken ?? "none"} → ${r.newRow.token}`);
  } else console.log(`\n(--no-rotate: running on the ACCUMULATED window)`);

  if (cli.fill > 0) {
    console.log(`\ninjecting ${cli.fill} filler ambient wakes to grow the window...`);
    const slackOrigin = { platform: "slack", channelId: SLACK_CHANNEL_ID };
    for (let i = 0; i < cli.fill; i++) {
      try {
        await injectWake({ domain: DOMAIN, platform: "slack", surfaceKey: SLACK_SURFACE, addressing: "channel-watch", author: `fill${i}`, origin: slackOrigin, text: `filler ${i}: just chatting about the weekend plans, nothing actionable here.` }, "filler", 0);
        await sleep(1500);
      } catch (e) { console.warn(`  filler ${i} failed: ${(e as Error).message}`); }
    }
    await sleep(FACT_WAIT_MS);
  }

  for (let i = 0; i < series.length; i++) {
    const fact = freshFact(run, i + 1);
    console.log(`\n── [r${repeat}] T${i + 1}/${series.length} ${series[i]} ${SCENARIOS[series[i]].label} ─ fact ${fact.code}`);
    try {
      const t = await injectTurn(series[i], i + 1, fact, surf);
      pending.push({ turn: i + 1, scenario: series[i], ...t, fact });
      if (t.skip) { console.log(`   → SKIP  ${t.skip}`); continue; }
      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      let resolved = false;
      while (Date.now() < deadline) {
        const rows = await auditSince(seriesStartedAt);
        const attribution = attributeOutcomes(injections, rows);
        if (t.probe && (attribution.completionOf.has(t.probe.wakeId) || (attribution.replyPostsOf.get(t.probe.wakeId)?.length ?? 0) > 0)) {
          const o = outcomeFor(t.probe, SCENARIOS[series[i]].expected, attribution);
          console.log(`   → ${o.outcome}  (lat ${o.latencyMs ? Math.round(o.latencyMs / 1000) + "s" : "-"})  ${o.notes}  [interim — final pass below settles it]`);
          resolved = true;
          break;
        }
        await sleep(POLL_MS);
      }
      if (!resolved) console.log(`   → (no completion yet — the final attribution pass will settle it)`);
    } catch (e) {
      console.error(`   → turn ERROR: ${(e as Error).message}`);
      pending.push({ turn: i + 1, scenario: series[i], probe: null, state: null, skip: `ERROR: ${(e as Error).message}`, fact });
    }
  }

  console.log(`\nsettling (up to ${Math.round(REPLY_TIMEOUT_MS / 1000)}s for trailing completions)...`);
  const settleDeadline = Date.now() + REPLY_TIMEOUT_MS;
  let finalRows: readonly AuditWireEntry[] = [];
  let finalAttribution: Attribution = attributeOutcomes(injections, []);
  for (;;) {
    finalRows = await auditSince(seriesStartedAt);
    finalAttribution = attributeOutcomes(injections, finalRows);
    const unresolved = pending.filter((p) => p.probe && !finalAttribution.completionOf.has(p.probe.wakeId) && (finalAttribution.replyPostsOf.get(p.probe.wakeId)?.length ?? 0) === 0);
    if (unresolved.length === 0 || Date.now() >= settleDeadline) break;
    await sleep(POLL_MS);
  }
  for (const n of finalAttribution.notes) console.log(`  [attribution] ${n}`);

  const turns: TurnResult[] = [];
  for (const p of pending) {
    const spec = SCENARIOS[p.scenario];
    if (p.skip || !p.probe) {
      turns.push({ turn: p.turn, scenario: p.scenario, label: spec.label, expected: spec.expected, outcome: "SKIP", probe: p.probe, state: p.state, latencyMs: null, recall: null, matchedRows: [], notes: p.skip ?? "no probe injected" });
      continue;
    }
    const o = outcomeFor(p.probe, spec.expected, finalAttribution);
    let recall: TurnResult["recall"] = null;
    if (o.outcome === "LANDED_VIA_REPLY_TOOL" || o.outcome === "LANDED_VIA_REDRIVE" || o.outcome === "LANDED_VIA_BRIDGE") {
      const platform = o.matched.map((r) => dS(r, "platform")).find((x) => x) ?? null;
      if (platform === "slack") {
        const body = await readSlackReplyBody(p.probe.injectedAt);
        if (body) recall = recallHit(body, p.fact);
      }
    }
    turns.push({ turn: p.turn, scenario: p.scenario, label: spec.label, expected: spec.expected, outcome: o.outcome, probe: p.probe, state: p.state, latencyMs: o.latencyMs, recall, matchedRows: o.matched, notes: o.notes });
  }

  const fc = await classifyFailures(turns, finalAttribution);
  console.log(`  [failure-class] ${fc.note}`);

  const summary = summarize(turns, finalRows, finalAttribution.sessionId);
  printReport(turns, summary, finalAttribution);

  const outDir = join(process.cwd(), "scripts/eval/results");
  mkdirSync(outDir, { recursive: true });
  const repeatSuffix = totalRepeats > 1 ? `-r${repeat}` : "";
  const outPath = join(outDir, `ambient-eval-${slug(cli.model)}-${effort}-${seriesStartedAt.replace(/[:.]/g, "-")}${repeatSuffix}.json`);
  writeFileSync(outPath, JSON.stringify({
    config: { model: cli.model, effort, domain: cli.domain, org: cli.org, turns: cli.turns, fill: cli.fill, rotate: cli.rotate, repeat, totalRepeats },
    series,
    seriesStartedAt,
    finishedAt: new Date().toISOString(),
    sessionId: finalAttribution.sessionId,
    attributionNotes: finalAttribution.notes,
    failureClassNote: fc.note,
    injections: [...injections],
    turns,
    completions: finalAttribution.completions,
    summary,
  }, null, 2));
  console.log(`\nwrote ${outPath}`);
  return { repeat, turns, summary, sessionId: finalAttribution.sessionId, outPath };
}

function aggStat(vals: readonly (number | null)[]): { mean: number | null; min: number | null; max: number | null; n: number } {
  const nums = vals.filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return { mean: null, min: null, max: null, n: 0 };
  const mean = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
  return { mean, min: Math.min(...nums), max: Math.max(...nums), n: nums.length };
}

function writeAggregate(
  cli: Cli,
  effort: ModelReasoning,
  startedAt: string,
  ok: readonly SeriesRunResult[],
  errored: readonly { repeat: number; error: string }[],
): void {
  const s = (f: (x: SeriesRunResult) => number | null) => aggStat(ok.map(f));
  const metrics = {
    reply_landed_rate: s((x) => x.summary.reply_landed_rate.rate),
    reply_tool_adherence: s((x) => x.summary.reply_tool_adherence.rate),
    adherence_after_redrive: s((x) => x.summary.adherence_after_redrive.rate),
    silence_precision: s((x) => x.summary.silence_precision.rate),
    soft_reply_rate: s((x) => x.summary.soft_reply_rate.rate),
    recall_accuracy: s((x) => x.summary.recall_accuracy.rate),
    prose_drops_replied_false: s((x) => x.summary.prose_drop_count.repliedFalse),
    judged_silent_count: s((x) => x.summary.judged_silent_count),
  };
  const perScenario: Record<string, Record<string, number>> = {};
  for (const r of ok) {
    for (const t of r.turns) {
      perScenario[t.scenario] ??= {};
      perScenario[t.scenario][t.outcome] = (perScenario[t.scenario][t.outcome] ?? 0) + 1;
    }
  }
  const outDir = join(process.cwd(), "scripts/eval/results");
  const outPath = join(outDir, `ambient-eval-${slug(cli.model)}-${effort}-${startedAt.replace(/[:.]/g, "-")}-aggregate.json`);
  writeFileSync(outPath, JSON.stringify({
    config: { model: cli.model, effort, domain: cli.domain, org: cli.org, turns: cli.turns, fill: cli.fill, repeats: cli.repeats },
    startedAt,
    finishedAt: new Date().toISOString(),
    repeats: {
      requested: cli.repeats,
      succeeded: ok.map((r) => ({ repeat: r.repeat, outPath: r.outPath, sessionId: r.sessionId, summary: r.summary })),
      errored: [...errored],
    },
    metrics,
    perScenario,
  }, null, 2));
  console.log(`\n=== AGGREGATE (${ok.length}/${cli.repeats} repeats succeeded${errored.length ? `, ${errored.length} ERRORED` : ""}) ===`);
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`${k.padEnd(26)}: mean ${v.mean ?? "n/a"}  min ${v.min ?? "n/a"}  max ${v.max ?? "n/a"}  (n=${v.n})`);
  }
  for (const e of errored) console.log(`repeat ${e.repeat}: ERRORED — ${e.error}`);
  console.log(`wrote ${outPath}`);
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  DOMAIN = cli.domain;

  if (cli.rescore) {
    if (!TARGET || !READ) { console.error("✗ need E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN"); process.exit(1); }
    await rescoreRun(cli);
    return;
  }

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
  console.log(`turns:   ${cli.turns}   fill: ${cli.fill}   repeats: ${cli.repeats}   rotate: ${cli.rotate}   plan-only: ${cli.plan}`);
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

  const startedAt = new Date().toISOString();
  const okRuns: SeriesRunResult[] = [];
  const errored: { repeat: number; error: string }[] = [];
  try {
    for (let r = 1; r <= cli.repeats; r++) {
      if (cli.repeats > 1) console.log(`\n════════ REPEAT ${r}/${cli.repeats} ════════`);
      try {
        okRuns.push(await runOneSeries(cli, effort, surf, store, series, r, cli.repeats));
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`\n✗ repeat ${r} ERRORED: ${msg}`);
        errored.push({ repeat: r, error: msg });
      }
    }
    if (cli.repeats > 1) writeAggregate(cli, effort, startedAt, okRuns, errored);
  } finally {
    if (cli.restore) {
      try {
        if (prior) await store.setDomainModel(cli.org, cli.domain, { modelId: prior.modelId, reasoning: prior.reasoning }, "ambient-eval-restore");
        else await store.clearDomainModel(cli.org, cli.domain);
        console.log(`\nrestored pick: ${prior ? JSON.stringify({ modelId: prior.modelId, reasoning: prior.reasoning }) : "cleared (git route)"}`);
      } catch (e) { console.error(`⚠ FAILED to restore pick — domain left on ${cli.model}@${effort}. Fix manually. (${(e as Error).message})`); }
    }
  }
}

main().catch((e) => { console.error("AMBIENT-EVAL FAILED:", e); process.exit(1); });
