import { type AuditWireEntry } from "./audit-read.js";
import {
  sleep, dS, makeWant, createRecorder, createInjector, createAuditReader, readToolCalls, wholeTranscriptText, sessionMatrix, scoreWithheldPair,
  type InjectBody, type Injected,
  deploymentPresenceSince,
} from "./window-harness.js";
import { wireNeonOperationalStore, rotateUnifiedWindow } from "./rotate-window-lib.js";
import { withheldFromGrain } from "../../agent/access/window-gate-manifest.js";
import { LEAN_SEAT_TOOLS } from "../../agent/access/lean-seat.js";
import { parseWindowToken } from "../../agent/channels/window-key.js";
import { unifiedDomainSessionKey } from "../../agent/channels/unified-supervisor.js";
import type { OperationalStore } from "../../agent/operational/store.js";

const TARGET = (process.env.E2E_TARGET_URL ?? "").replace(/\/+$/, "");
const READ = process.env.E2E_CONTROL_READ_TOKEN ?? "";
const INJECT = process.env.E2E_CONTROL_INJECT_TOKEN ?? "";
const DB = process.env.DATABASE_URL ?? "";
const ORG = process.env.E2E_ORG ?? "default";

const DOMAIN = process.env.E2E_SOLO_DOMAIN || "e2e-solo";
const SLACK_A = process.env.E2E_SOLO_SLACK_A || "slack/T0EXAMPLE/C0EXCHAN001";
const SLACK_B = process.env.E2E_SOLO_SLACK_B || "slack/T0EXAMPLE/C0EXCHAN002";
const DISCORD_C = process.env.E2E_SOLO_DISCORD ?? "";
const SOLO_SURFACES = [SLACK_A, SLACK_B, DISCORD_C].filter(Boolean);

const CTRL_DOMAIN = process.env.E2E_SOLO_CONTROL_DOMAIN || "e2e-unified";
const CTRL_SLACK = process.env.E2E_SOLO_CONTROL_SLACK || "slack/T0EXAMPLE/C0EXCHAN003";
const CTRL_GITHUB = process.env.E2E_SOLO_CONTROL_GITHUB || "github/example-owner/e2e-scratch";

const REPLY_TIMEOUT_MS = Number.parseInt(process.env.SOLO_REPLY_TIMEOUT_MS ?? "240000", 10);
const GATE_TIMEOUT_MS = Number.parseInt(process.env.SOLO_GATED_TIMEOUT_MS ?? "90000", 10);
const POLL_MS = 4000;
const RUN = Date.now().toString().slice(-7);
const want = makeWant(process.env.SOLO_ONLY);

const A_GATED = "turn.tool_gated";
const A_REPLY = "reply.post";
const A_NO_REPLY = "unified.no_reply";
const WIDE_HANDS = ["bash", "checkout_repo", "open_pull_request", "web_fetch", "write_file"];
const withheldStanding = new Set(withheldFromGrain("standing"));
const leanKeep = [...LEAN_SEAT_TOOLS].filter((n) => !withheldStanding.has(n)).sort();

const { results, record } = createRecorder();
const injectRaw = createInjector(TARGET, INJECT);
const { rowsSince, readFailed } = createAuditReader(TARGET, READ, { onError: "swallow" });

function originFor(surfaceKey: string): Record<string, unknown> {
  const [platform, workspace, ...rest] = surfaceKey.split("/");
  const surface = rest.join("/");
  if (platform === "discord") return { platform: "discord", channelId: surface, guildId: workspace };
  if (platform === "github") {
    return { platform: "github", owner: workspace, repo: surface, issueNumber: Number.parseInt(process.env.E2E_SOLO_CONTROL_GITHUB_ISSUE || "1", 10) };
  }
  return { platform: "slack", channelId: surface };
}

const platformOf = (surfaceKey: string): InjectBody["platform"] => surfaceKey.split("/", 1)[0] as InjectBody["platform"];

function wakeAt(domain: string, surfaceKey: string, text: string): Promise<Injected> {
  return injectRaw({
    domain,
    platform: platformOf(surfaceKey),
    surfaceKey,
    addressing: "direct-mention",
    mention: true,
    author: "tester",
    origin: originFor(surfaceKey),
    text,
  });
}

function unarmedReason(e: unknown, surfaceKey: string): string | null {
  const m = (e as Error).message ?? "";
  if (m.includes("no standing window")) {
    return `the target REFUSED to inject at ${surfaceKey} — fail-closed at test-route gate 3a: no standing window (mode solo / unified) is enabled for it. The target must be started with window.topology: true (arms the WINDOW_TOPOLOGY_ENABLED code capability the ${DOMAIN} fixture's mode "solo" needs; the fixture itself is always registered in agent/memory/config/domains.ts). This is the state W5 asserts as CORRECT — it is only a SKIP here.`;
  }
  if (m.includes("no unified session for window")) {
    return `the ${surfaceKey} window has NO channel_session row yet and this run could not seed one (DATABASE_URL ${DB ? "wired but the rotate failed — see the [store] warning above" : "unset"}). The solo windows are per-CHANNEL and brand new, so nothing has ever minted their rows: re-run with DATABASE_URL pointed at the target's database (rotation is what mints them).`;
  }
  if (m.includes("resolves to domain")) {
    return `${surfaceKey} does not resolve to domain "${DOMAIN}" on the target (${m}) — another domain claims the channel (the ${DOMAIN} fixture itself is always registered). Check the competing domains' channel ownership on the target.`;
  }
  return null;
}

const gatedRowFor = (rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry | null =>
  rows.find((r) => r.action === A_GATED && dS(r, "wakeId") === wakeId) ?? null;

const gatedRowsFor = (rows: readonly AuditWireEntry[], wakeId: string): { grainRow: AuditWireEntry | null; leanRow: AuditWireEntry | null } => {
  const matches = rows.filter((r) => r.action === A_GATED && dS(r, "wakeId") === wakeId);
  return {
    grainRow: matches.find((r) => dS(r, "reason") === undefined) ?? null,
    leanRow: matches.find((r) => dS(r, "reason") === "lean-seat") ?? null,
  };
};

const sessionJoinRowsFor = (rows: readonly AuditWireEntry[], wakeId: string): AuditWireEntry[] =>
  rows.filter((r) => (r.action === A_REPLY || r.action === A_NO_REPLY) && dS(r, "wakeId") === wakeId);

async function pollForGatedPair(sinceIso: string, wakeId: string, timeoutMs: number): Promise<{ grainRow: AuditWireEntry | null; leanRow: AuditWireEntry | null }> {
  const deadline = Date.now() + timeoutMs;
  let pair: { grainRow: AuditWireEntry | null; leanRow: AuditWireEntry | null } = { grainRow: null, leanRow: null };
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    pair = gatedRowsFor(await rowsSince(sinceIso), wakeId);
    if (pair.grainRow && pair.leanRow) return pair;
  }
  return pair;
}

async function pollForSession(sinceIso: string, wakeId: string, timeoutMs: number): Promise<{ sessionId: string | null; via: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rows = await rowsSince(sinceIso);
    const gated = gatedRowFor(rows, wakeId);
    const sid = gated ? dS(gated, "sessionId") : undefined;
    if (sid) return { sessionId: sid, via: A_GATED };
    const joins = sessionJoinRowsFor(rows, wakeId);
    if (joins.length > 0) return { sessionId: dS(joins[0], "sessionId") ?? null, via: joins[0].action };
  }
  return { sessionId: null, via: null };
}

async function ranEvidence(sinceIso: string, wakeId: string): Promise<string[]> {
  const rows = await rowsSince(sinceIso);
  return [...new Set(rows.filter((r) => dS(r, "wakeId") === wakeId && r.action !== "control.service_call").map((r) => r.action))];
}

function soloTokenVerdict(token: string, surfaceKey: string): { ok: boolean; detail: string } {
  const key = parseWindowToken(token);
  if (!key) return { ok: false, detail: `token "${token}" is not a parseable window token at all` };
  if (key.domain !== DOMAIN) return { ok: false, detail: `token domain "${key.domain}" ≠ "${DOMAIN}"` };
  if (key.windowId === key.domain) {
    return { ok: false, detail: `token is the DEGENERATE domain-wide window (windowId === domain === "${key.domain}") — the solo re-key did NOT happen; the domain fell back to one window for the whole team` };
  }
  if (key.windowId !== surfaceKey) {
    return { ok: false, detail: `windowId "${key.windowId}" is neither the domain nor the surfaceKey "${surfaceKey}" — a solo window's id IS its fully-qualified surface key (supervisorGrainFor's \`const windowId = solo ? surfaceKey : domain.name\`)` };
  }
  return { ok: true, detail: `windowId === surfaceKey "${surfaceKey}" (generation ${key.generation})` };
}

const HEAVY = "please clone the acme/web repo, run the full test suite in a sandbox, then open a pull request with the fix. reply here when the PR is up.";
async function w1(): Promise<void> {
  const since = await deploymentPresenceSince(TARGET, READ);
  let inj: Injected;
  try {
    inj = await wakeAt(DOMAIN, SLACK_A, HEAVY);
  } catch (e) {
    const skip = unarmedReason(e, SLACK_A);
    return skip ? record("W1", "SKIP", skip) : record("W1", "FAIL", `injection at ${SLACK_A} failed: ${(e as Error).message}`);
  }
  const shape = soloTokenVerdict(inj.token, SLACK_A);
  console.log(`  W1 injected solo Slack wake ${inj.wakeId} → token ${inj.token} (solo shape: ${shape.ok})`);
  if (!shape.ok) {
    return record("W1", "FAIL", `the REAL solo path did not re-key the window: ${shape.detail}. Dispatched token: ${inj.token}. (This is the whole topology — supervisorGrainFor → windowModeFor → windowId = surfaceKey → supervisorTokenForGrain's explicit :win: form.)`);
  }
  const { grainRow, leanRow } = await pollForGatedPair(since, inj.wakeId, GATE_TIMEOUT_MS);
  if (!grainRow && !leanRow) {
    const ev = await ranEvidence(since, inj.wakeId);
    if (ev.length === 0) {
      return record("W1", "FAIL", `NO turn.tool_gated row AND no audit activity of any kind for wake ${inj.wakeId} within ${GATE_TIMEOUT_MS}ms — consistent with the solo session never starting, not with a gating decision. ${readFailed() ? "NB an audit read FAILED during this run, so this may be an observability failure rather than a dead session." : ""}`);
    }
    return record("W1", "FAIL", `the solo session RAN (audit: ${ev.join(",")}) but emitted NO turn.tool_gated row for wake ${inj.wakeId} — a solo window was NOT narrowed. A solo window is a standing watcher and MUST narrow; the "sources.length===1 ⇒ full toolset" idea in window-capability-e2e-spec.md §2(b) is explicitly NOT what ships.`);
  }
  if (!grainRow) {
    return record("W1", "FAIL", `the LEAN-SEAT row landed for wake ${inj.wakeId} but the GRAIN gate row (no reason) never did within ${GATE_TIMEOUT_MS}ms — the MUST-WITHHOLD wall cannot be scored`);
  }
  if (!leanRow) {
    return record("W1", "FAIL", `the GRAIN gate row landed for wake ${inj.wakeId} but the LEAN-SEAT row (reason=lean-seat) never did within ${GATE_TIMEOUT_MS}ms — the MUST-KEEP wall cannot be scored`);
  }
  const grainWithheld = (grainRow.detail?.withheld as string[]) ?? [];
  const leanWithheld = (leanRow.detail?.withheld as string[]) ?? [];
  const grain = dS(grainRow, "grain");
  const missingWide = WIDE_HANDS.filter((w) => !grainWithheld.includes(w));
  const verdict = scoreWithheldPair(grainWithheld, leanWithheld, [...withheldStanding], leanKeep);
  if (grain !== "standing" || missingWide.length > 0 || !verdict.ok) {
    return record("W1", "FAIL", `gated rows present (grain=${grain}) — missing wide-hands: ${missingWide.join(",") || "none"}; manifest names NOT withheld: ${verdict.missing.join(",") || "none"}; speak/delegate roster wrongly withheld: ${verdict.cutKeep.join(",") || "none"}; grain-withheld=[${grainWithheld.join(",")}]; lean-withheld=[${leanWithheld.join(",")}]`);
  }
  const sid = dS(leanRow, "sessionId") ?? dS(grainRow, "sessionId");
  const calls = sid ? await readToolCalls(TARGET, READ, sid, { paged: true, sinceIso: since }) : null;
  const leaked = (calls ?? []).filter((c) => WIDE_HANDS.includes(c.name)).map((c) => c.name);
  record("W1", "PASS", `the REAL solo topology re-keyed AND narrowed — the dispatch resolved a per-channel window (${shape.detail}) through supervisorGrainFor's solo arm (nothing here passed a soloWindowId selector: the token came from the \`oe-domain::${SLACK_A}\` registry row, which only exists because windowedSupervisorEnabled admitted the channel), and its seat is grain=standing with all ${grainWithheld.length} manifest-withheld tools absent incl. bash/checkout_repo/open_pull_request (lean-seat withheld ${leanWithheld.length} keeps the whole speak/delegate roster intact: ${leanKeep.join(",")}; surplus ${verdict.surplus.length} beyond the manifest — INFORMATION, not a leak). Session ${sid ?? "?"} tools=[${[...new Set((calls ?? []).map((c) => c.name))].join(",") || "none"}]${calls === null ? " (transcript UNREADABLE — the leak check could not run)" : leaked.length ? ` ⚠ LEAKED ${leaked.join(",")}` : " (no wide-hands invoked)"}.`);
}

interface Leg { tag: string; surfaceKey: string; sessionId: string | null; via: string | null; wakeId: string }
async function driveLeg(domain: string, surfaceKey: string, tag: string, since: string): Promise<Leg | { skip: string } | { fail: string }> {
  let inj: Injected;
  try {
    inj = await wakeAt(domain, surfaceKey, `Bookkeeping ping ${tag}. Please reply here quoting the marker ${tag} exactly once, and nothing else.`);
  } catch (e) {
    const skip = unarmedReason(e, surfaceKey);
    return skip ? { skip } : { fail: `injection at ${surfaceKey} failed: ${(e as Error).message}` };
  }
  console.log(`  ${tag} injected at ${surfaceKey} → wake ${inj.wakeId}, token ${inj.token}`);
  const { sessionId, via } = await pollForSession(since, inj.wakeId, REPLY_TIMEOUT_MS);
  return { tag, surfaceKey, sessionId, via, wakeId: inj.wakeId };
}

async function sessionSplitCheck(
  id: string,
  domain: string,
  surfaceA: string,
  surfaceB: string,
  expect: "distinct" | "equal",
): Promise<void> {
  const since = await deploymentPresenceSince(TARGET, READ);
  const tagA = `${id}A-${RUN}`;
  const tagB = `${id}B-${RUN}`;
  const legA = await driveLeg(domain, surfaceA, tagA, since);
  if ("skip" in legA) return record(id, "SKIP", legA.skip);
  if ("fail" in legA) return record(id, "FAIL", legA.fail);
  const legB = await driveLeg(domain, surfaceB, tagB, since);
  if ("skip" in legB) return record(id, "SKIP", legB.skip);
  if ("fail" in legB) return record(id, "FAIL", legB.fail);

  for (const leg of [legA, legB]) {
    if (leg.sessionId) continue;
    const ev = await ranEvidence(since, leg.wakeId);
    if (ev.length === 0) {
      return record(id, "FAIL", `NO audit activity of ANY kind for the ${leg.surfaceKey} wake ${leg.wakeId} within ${REPLY_TIMEOUT_MS}ms — no turn.tool_gated, no reply.post, no unified.no_reply. Consistent with the wake never reaching a session (dead dispatch), NOT with model choice. ${readFailed() ? "NB an audit read FAILED this run — this may be an observability failure." : "Bump SOLO_REPLY_TIMEOUT_MS if the turn was genuinely still running."}`);
    }
    return record(id, "SKIP", `the ${leg.surfaceKey} wake ${leg.wakeId} RAN (audit: ${ev.join(",")}) but never joined a sessionId-bearing row within ${REPLY_TIMEOUT_MS}ms, so the two-window comparison has nothing to compare. ${readFailed() ? "An audit read also FAILED this run — this SKIP may be an observability failure rather than a slow turn." : ""}`);
  }
  const sidA = legA.sessionId!;
  const sidB = legB.sessionId!;
  const same = sidA === sidB;
  const what = expect === "distinct" ? "SEPARATE windows" : "ONE shared window";
  if (same !== (expect === "equal")) {
    return record(id, "FAIL", `${surfaceA} and ${surfaceB} on domain "${domain}" were expected to share ${what}, but landed in ${same ? `the SAME session ${sidA}` : `DIFFERENT sessions (${sidA} vs ${sidB})`} (joined via ${legA.via}/${legB.via}).${expect === "distinct" ? " Two channels folded into one window under a SOLO domain — the per-channel re-key did not happen, and every channel in the domain is reading every other channel's context." : " Two channels did NOT fold under a CROSS-SURFACE domain — the single-window fan-in regressed (cf. e2e:fanin)."}`);
  }

  const sids = same ? [sidA] : [sidA, sidB];
  const items = [{ tag: tagA, surfaceKey: surfaceA }, { tag: tagB, surfaceKey: surfaceB }];
  const matrix = await sessionMatrix(TARGET, READ, sids, items, {
    onSession: (sid, events, complete) => console.log(`  [matrix] session ${sid}: ${events} events (complete=${complete})`),
    onHit: (sid, item) => console.log(`  [matrix] ${item.tag} (${item.surfaceKey}) → ${sid}`),
  });
  const homeA = matrix.get(tagA) ?? [];
  const homeB = matrix.get(tagB) ?? [];
  if (homeA.length === 0 || homeB.length === 0) {
    return record(id, "SKIP", `sessionIds compared as expected (${expect}: ${sidA}${same ? "" : ` / ${sidB}`}), but the transcript matrix could not corroborate — tag ${tagA} found in ${homeA.length} session(s), ${tagB} in ${homeB.length}. A tag missing from its own session's transcript means the read (not the topology) is the problem; the sessionId comparison stands on the audit join alone.`);
  }
  if (expect === "distinct") {
    const bleed = [...homeA.filter((s) => s !== sidA), ...homeB.filter((s) => s !== sidB)];
    if (bleed.length > 0) {
      return record(id, "FAIL", `the two solo windows have DIFFERENT sessionIds (${sidA} vs ${sidB}) but their transcripts BLEED — ${tagA}→[${homeA.join(",")}], ${tagB}→[${homeB.join(",")}]. One channel's traffic is visible in the other's window; distinct session ids are not, on their own, distinct context.`);
    }
    return record(id, "PASS", `THE FALSIFIER HOLDS — two channels on the SAME platform and SAME workspace in the SOLO domain "${domain}" landed in SEPARATE windows: ${surfaceA} → session ${sidA}, ${surfaceB} → session ${sidB} (joined via ${legA.via}/${legB.via}), and each channel's marker appears ONLY in its own transcript (${tagA}→${homeA.join(",")}, ${tagB}→${homeB.join(",")}). Same platform ⇒ identical sources (["slack"]) ⇒ the ONLY difference between the two windows is the per-channel windowId, which is exactly the claim. Under mode "unified" these two would be ONE window (W2N drives that control).`);
  }
  return record(id, "PASS", `negative control HOLDS — ${surfaceA} and ${surfaceB} on the CROSS-SURFACE domain "${domain}" folded into ONE window: both wakes joined session ${sidA} (via ${legA.via}/${legB.via}) and that single transcript carries BOTH markers (${tagA}, ${tagB}). This is what makes W2 falsifiable: the same drive + the same matrix DOES report equality when the topology shares a window, so W2's "distinct" is a property of the solo topology, not of the method.`);
}

const w2 = (): Promise<void> => sessionSplitCheck("W2", DOMAIN, SLACK_A, SLACK_B, "distinct");
const w2n = (): Promise<void> => sessionSplitCheck("W2N", CTRL_DOMAIN, CTRL_SLACK, CTRL_GITHUB, "equal");

async function w3(): Promise<void> {
  if (!DISCORD_C) {
    return record("W3", "SKIP", "no dedicated Discord channel configured (E2E_SOLO_DISCORD unset) — the prod-resident e2e-solo domain is Slack-only until a Discord channel it OWNS exists (the bot lacks Manage Channels / the Slack token lacks channels:write, so one can't be auto-provisioned). The core solo proof is W1/W2/W4/W5; set E2E_SOLO_DISCORD to light up the sources-narrowing leg.");
  }
  const since = await deploymentPresenceSince(TARGET, READ);
  const slackChannelId = SLACK_A.split("/").slice(2).join("/");
  const brief = `Please pull recent messages from Slack channel ${slackChannelId} and reply with W3-${RUN} summarising what you saw. If you cannot read that Slack channel — no tool for it, or it refuses — reply W3-${RUN} NOSLACK and say so explicitly.`;
  let inj: Injected;
  try {
    inj = await wakeAt(DOMAIN, DISCORD_C, brief);
  } catch (e) {
    const skip = unarmedReason(e, DISCORD_C);
    return skip ? record("W3", "SKIP", skip) : record("W3", "FAIL", `injection at ${DISCORD_C} failed: ${(e as Error).message}`);
  }
  const shape = soloTokenVerdict(inj.token, DISCORD_C);
  console.log(`  W3 injected solo Discord wake ${inj.wakeId} → token ${inj.token} (solo shape: ${shape.ok})`);
  if (!shape.ok) {
    return record("W3", "FAIL", `the Discord window is not a real solo window: ${shape.detail}. Its sources would then not be derived from a surface-key windowId at all, so the narrowing under test isn't the one that ships.`);
  }
  const { sessionId, via } = await pollForSession(since, inj.wakeId, REPLY_TIMEOUT_MS);
  if (!sessionId) {
    const ev = await ranEvidence(since, inj.wakeId);
    if (ev.length === 0) {
      return record("W3", "FAIL", `NO audit activity of ANY kind for wake ${inj.wakeId} within ${REPLY_TIMEOUT_MS}ms — consistent with the Discord solo session never running, not with model choice. ${readFailed() ? "NB an audit read FAILED this run — this may be an observability failure." : ""}`);
    }
    return record("W3", "SKIP", `the Discord solo session RAN (audit: ${ev.join(",")}) but joined no sessionId-bearing row within ${REPLY_TIMEOUT_MS}ms, so its mount can't be read. The narrowing is pinned offline (source-scoped-mount-test.ts).`);
  }
  const calls = await readToolCalls(TARGET, READ, sessionId, { paged: true, sinceIso: since });
  if (calls === null) {
    return record("W3", "SKIP", `transcript fetch failed for session ${sessionId} — observation UNAVAILABLE. A vacuous negative must never read as an observed absence (that is the whole reason readToolCalls returns null rather than []), so this is a SKIP, not a PASS. The narrowing is pinned offline (source-scoped-mount-test.ts).`);
  }
  const names = [...new Set(calls.map((c) => c.name))];
  const slackReaders = names.filter((t) => t.startsWith("read_slack"));
  if (slackReaders.length > 0) {
    return record("W3", "FAIL", `session ${sessionId} INVOKED a per-surface Slack reader (${slackReaders.join(",")}) on a SOLO DISCORD window (windowId=${DISCORD_C} ⇒ sources=["discord"]) — OPE-1145 deleted that tool, so its presence means the deletion did not reach this target. tools=[${names.join(",")}]`);
  }
  const tr = await wholeTranscriptText(TARGET, READ, sessionId).catch(() => null);
  if (tr === null) {
    return record("W3", "SKIP", `transcript text fetch failed for session ${sessionId} — the NOSLACK marker cannot be read, and a vacuous negative must never read as an observed absence. The narrowing is pinned offline (source-scoped-mount-test.ts).`);
  }
  if (tr.text.includes("NOSLACK")) {
    return record("W3", "PASS", `the solo Discord window could NOT reach the Slack channel — session ${sessionId} (joined via ${via}) reported NOSLACK on a window whose sources derive to ["discord"] from its surface-key windowId (tools=[${names.join(",") || "none"}]). CORROBORATION, not proof: source-scoping emits no audit row (gap G7 — there is no turn.tool_scoped analogue). Unlike source-scoped-mount's S2, the window here is a REAL solo one, so the sources vector is the one a live wake derives (S2's synthetic windowId made platformOf return "" and fail closed to the origin platform). The binding proof remains the offline unit.`);
  }
  if (names.includes("read_channel") || names.includes("read_thread")) {
    return record("W3", "FAIL", `session ${sessionId} invoked a chat reader on a SOLO DISCORD window asked for SLACK content and did NOT report NOSLACK — a cross-source read may have succeeded, or the agent answered about the wrong container without saying so. Verify the sources gate (tools=[${names.join(",") || "none"}], text tail: ${tr.text.slice(-300)})`);
  }
  record("W3", "SKIP", `session ${sessionId} (joined via ${via}) replied without invoking a reader and without the NOSLACK marker (tools=[${names.join(",") || "none"}]) — the model declined the brief rather than demonstrating the narrowing, so there is nothing to observe. The binding proof remains the offline unit (source-scoped-mount-test.ts).`);
}

async function w4(store: OperationalStore | null): Promise<void> {
  if (!store) return record("W4", "SKIP", "no DATABASE_URL — the registry assertion reads channel_session rows directly from the live operational store.");
  const rows: { key: string; token: string | null }[] = [];
  for (const surfaceKey of SOLO_SURFACES) {
    const key = unifiedDomainSessionKey(surfaceKey);
    const row = await store.getChannelSession(ORG, key).catch(() => null);
    rows.push({ key, token: row?.token ?? null });
  }
  const missing = rows.filter((r) => r.token === null);
  if (missing.length > 0) {
    return record("W4", "SKIP", `${missing.length} of ${SOLO_SURFACES.length} per-channel window rows are absent (${missing.map((m) => m.key).join(", ")}) — nothing has minted them, so there is no registry shape to assert. They are minted by this pack's rotate at startup; check the [store] warning above.`);
  }
  const domainKey = unifiedDomainSessionKey(DOMAIN);
  const domainRow = await store.getChannelSession(ORG, domainKey).catch(() => null);
  if (domainRow) {
    return record("W4", "FAIL", `a DOMAIN-WIDE registry row "${domainKey}" exists (token ${domainRow.token}) alongside the per-channel rows — a solo domain must never key a window by its domain name. Either the fixture carries mode "unified" instead of mode "solo" (which would explain it), or a flag-off run seeded a degenerate window under the same domain. Whichever it is, this pack's other routes cannot claim the solo registryKey was used while this row exists.`);
  }
  const tokens = new Set(rows.map((r) => r.token!));
  if (tokens.size !== rows.length) {
    return record("W4", "FAIL", `the ${rows.length} per-channel rows do not hold DISTINCT tokens (${rows.length - tokens.size} collision(s)): ${rows.map((r) => `${r.key} → ${r.token}`).join(" | ")}. Distinct rows holding one token would resume ONE eve session — separate registry keys with a shared token is not a separate window.`);
  }
  const misKeyed = rows.filter((r, i) => parseWindowToken(r.token!)?.windowId !== SOLO_SURFACES[i]);
  if (misKeyed.length > 0) {
    return record("W4", "FAIL", `a row's token does not embed its own window: ${misKeyed.map((r) => `${r.key} → ${r.token}`).join(" | ")}. The registry key and the token's windowId must agree or a rotate and a dispatch will disagree about which window they mean.`);
  }
  record("W4", "PASS", `the registry is keyed PER CHANNEL — ${rows.length} distinct rows (${rows.map((r) => r.key).join(", ")}), each holding a distinct token whose windowId is its own surfaceKey, and NO domain-wide "${domainKey}" row exists. That absence is load-bearing for the rest of the pack: a wake that resolved the degenerate domain grain would have found no row and 400'd, so every successful dispatch here provably went through supervisorGrainFor's solo arm.`);
}

async function w5(): Promise<void> {
  let token: string;
  try {
    ({ token } = await wakeAt(DOMAIN, SLACK_A, `flag-off control probe ${RUN} — no action needed.`));
  } catch (e) {
    const m = (e as Error).message ?? "";
    if (m.includes("no standing window")) {
      return record("W5", "PASS", `flag-OFF control HOLDS — the target REFUSED the injection at ${SLACK_A} fail-closed ("no standing window (mode solo / unified) is enabled"), so the ${DOMAIN} fixture mints NO token while unarmed even though it is always registered. This is a single-gate refusal: WINDOW_TOPOLOGY_ENABLED (window.topology) is off, which IS the inertness being asserted. DIVERGENCE from the matrix spec's W5 (which predicted a degenerate \`oe-dom:${DOMAIN}:oe-sup:g<N>\` mint): that mint is unreachable through this seam, because gate 3a refuses before any token is minted. The degenerate-mint shape is pinned where it is deterministic — supervisorTokenForGrain with a flag-off grain, scripts/unified-supervisor-test.ts.`);
    }
    if (m.includes("no unified session for window")) {
      return record("W5", "SKIP", `the target ACCEPTED ${SLACK_A} as a windowed surface (so the window topology IS enabled — the armed state) but has no session row for it: ${m}. W5 is the flag-OFF control; re-run against a target started WITHOUT window.topology to exercise it.`);
    }
    return record("W5", "FAIL", `the flag-off probe failed in an unexpected way (neither the fail-closed refusal nor a clean accept): ${m}`);
  }
  const key = parseWindowToken(token);
  if (key && key.windowId === key.domain) {
    return record("W5", "FAIL", `the target ACCEPTED the injection and minted the DEGENERATE token ${token} for a mode-"solo" domain — a solo domain must key its window by surfaceKey, never by domain. The likeliest cause is the fixture carrying mode "unified" instead of "solo" on "${DOMAIN}" (supervisorGrainFor's \`const solo = !unifiedMode\`, unified-supervisor.ts), which would silently destroy the whole topology this pack tests.`);
  }
  record("W5", "SKIP", `the target is ARMED (the injection was accepted and minted ${token}), so the flag-OFF control cannot run — W5 asserts that an UNARMED target refuses. Re-run the pack against a target started WITHOUT window.topology (the fixture stays registered regardless) to exercise it; W1–W4 will then SKIP with the mirror-image reason. Not faked here.`);
}

async function main(): Promise<void> {
  console.log(`=== SOLO WINDOW · Stage 3 per-route e2e · run ${RUN} · ${new Date().toISOString()} ===`);
  console.log(`target=${TARGET || "(unset)"} domain=${DOMAIN}`);
  console.log(`  solo windows: ${SOLO_SURFACES.join(" | ")}`);
  console.log(`  control (cross-surface): ${CTRL_DOMAIN} → ${CTRL_SLACK} | ${CTRL_GITHUB}`);
  const ids = ["W1", "W2", "W2N", "W3", "W4", "W5"];
  if (!TARGET || !READ || !INJECT) {
    console.error("\nMISSING E2E_TARGET_URL and/or E2E_CONTROL_READ_TOKEN and/or E2E_CONTROL_INJECT_TOKEN — cannot drive any route.");
    for (const id of ids) if (want(id)) record(id, "SKIP", "no E2E_TARGET_URL / E2E_CONTROL_READ_TOKEN / E2E_CONTROL_INJECT_TOKEN");
    return summary();
  }

  let store: OperationalStore | null = null;
  if (DB) {
    try {
      store = await wireNeonOperationalStore(DB);
      for (const surfaceKey of SOLO_SURFACES) {
        const rot = await rotateUnifiedWindow(store, ORG, DOMAIN, surfaceKey);
        console.log(`  rotated solo window ${surfaceKey} → generation ${rot.mintedGeneration} (row ${rot.registryKey}, token ${rot.newRow.token})`);
      }
      if (want("W2N")) {
        const rot = await rotateUnifiedWindow(store, ORG, CTRL_DOMAIN);
        console.log(`  rotated control window ${CTRL_DOMAIN} → generation ${rot.mintedGeneration} (row ${rot.registryKey}, token ${rot.newRow.token})`);
      }
    } catch (e) {
      console.warn(`  [store] could not wire/rotate: ${(e as Error).message} — W4 will skip and the drives rely on pre-existing rows (a solo window probably has none)`);
      store = null;
    }
  } else {
    console.warn("  no DATABASE_URL — no rotate (the per-channel rows likely do not exist at all) + W4 will skip");
  }

  const steps: [string, () => Promise<void>][] = [
    ["W1", w1], ["W2", w2], ["W2N", w2n], ["W3", w3], ["W4", () => w4(store)], ["W5", w5],
  ];
  for (const [id, fn] of steps) {
    if (!want(id)) continue;
    try { await fn(); }
    catch (e) { record(id, "FAIL", `threw: ${(e as Error).message}`); }
  }
  summary();
}

function summary(): void {
  console.log(`\n=== SOLO WINDOW SUMMARY (run ${RUN}) ===`);
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`  ${pass} pass · ${skip} skip · ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => { console.error("Solo-window pack failed:", e); process.exit(1); });
