import assert from "node:assert/strict";
import {
  classifySessionId,
  isSupervisorShapedToken,
  formatDmSeatToken,
  parseDmSeatToken,
  isDmSeatToken,
  dmSeatRegistryKey,
  bareTokenFromEveContext,
  formatWindowToken,
  parseWindowToken,
  mintGenerationSalt,
  saltSupervisorGeneration,
  dmAnchorDomain,
  dmWindowKey,
  type SessionId,
} from "../agent/channels/window-key.js";
import { dmWindowRegistryKey, standingSeatRegistryKey } from "../agent/channels/unified-supervisor.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const OLD_SUPERVISOR_TOKEN_RE = /(?:^|:)oe-sup:g\d+$/;
function oldIsSupervisorSession(token: unknown): boolean {
  return typeof token === "string" && OLD_SUPERVISOR_TOKEN_RE.test(token);
}

const OLD_EXPLICIT_WINDOW_TOKEN_RE = /^oe-dom:(.+):win:([^:]+):oe-sup:g(\d+)$/;
const OLD_LEGACY_WINDOW_TOKEN_RE = /^oe-dom:(.+):oe-sup:g(\d+)$/;
function oldParseWindowId(token: string): string | undefined {
  const explicit = OLD_EXPLICIT_WINDOW_TOKEN_RE.exec(token);
  if (explicit) return explicit[2];
  const legacy = OLD_LEGACY_WINDOW_TOKEN_RE.exec(token);
  if (legacy) return legacy[1];
  return undefined;
}
function oldParseDomain(token: string): string | undefined {
  const explicit = OLD_EXPLICIT_WINDOW_TOKEN_RE.exec(token);
  if (explicit) return explicit[1];
  const legacy = OLD_LEGACY_WINDOW_TOKEN_RE.exec(token);
  if (legacy) return legacy[1];
  return undefined;
}
const OLD_STANDING_TOKEN_SUFFIX_RE = /(?:^|:)oe-sup:g\d+$/;
type OldGrain = "standing" | "task" | "native" | "thread";
function oldClassifyTokenGrain(token: unknown): OldGrain {
  if (typeof token !== "string") return "native";
  const raw = token.startsWith("unified:") ? token.slice("unified:".length) : token;
  const wid = oldParseWindowId(raw);
  if (wid !== undefined && /^t\//.test(wid)) return "task";
  if (wid !== undefined && /^s\//.test(wid)) return "thread";
  if (OLD_STANDING_TOKEN_SUFFIX_RE.test(raw)) return "standing";
  return "native";
}

function oldDomainLabel(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const token = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
  const domain = oldParseDomain(token);
  if (domain !== undefined) return domain;
  const suffix = token.lastIndexOf(":oe-sup:g");
  return suffix > 0 ? token.slice(0, suffix) : "unknown";
}

function oldIsSupervisorTokenSpend(token: unknown): boolean {
  return typeof token === "string" && token.includes(":oe-sup:g");
}

const CK = "slack/T1/C_PAY";
const TS = "1720000000.001";

const REAL: readonly unknown[] = [
  "oe-dom:payments:oe-sup:g4",
  "oe-dom:payments:win:solo-C_PAY:oe-sup:g7",
  "oe-dom:a:b:oe-sup:g2",
  `oe-dom:payments:win:t/${CK}/${TS}:oe-sup:g4`,
  `oe-dom:payments:win:t/${CK}/${TS}/wake-nonce-abc:oe-sup:g4`,
  `oe-dom:payments:win:s/${CK}/${TS}:oe-sup:g4`,
  "github:acme/widgets:oe-sup:g5",
  "linear:TEAM123:oe-sup:g5",
  "notion:page-abc123:oe-sup:g5",
  "C_PAYMENTS01:oe-sup:g3",
  "teams:19:meetingabc@thread.v2:oe-sup:g1",
  "cse_abcdef123456",
  "",
  undefined,
  null,
  12345,
  { not: "a string" },
  "C_PAY:1720000000.001",
];

const UNIFIED_VARIANTS: readonly unknown[] = REAL.filter((t): t is string => typeof t === "string").map(
  (t) => `unified:${t}`,
);

const ADVERSARIAL: readonly unknown[] = [
  "oe-dom:x:oe-sup:g5:trailing",
  "foo:oe-sup:gNOTNUM",
  ":oe-sup:g1",
  "oe-sup:g1",
  "x:oe-sup:g",
  "oe-dom:a:b:oe-sup:g2",
  "prefix:oe-sup:g5:oe-sup:g9",
  "oe-sup:g5:oe-sup:g9",
  "unified:oe-dom:x:oe-sup:g5:trailing",
  "subagent:cse_abcdef123456:call_1",
  "task:task_c5a7cc13ba1b8529a7832190:9f2c1ab4d7e60358",
  "subagent:oe-dom:payments:oe-sup:g4:call_1",
  "task:oe-dom:payments:oe-sup:g4",
];

const CORPUS: readonly unknown[] = [...REAL, ...UNIFIED_VARIANTS, ...ADVERSARIAL];

for (const tok of CORPUS) {
  const sid = classifySessionId(tok);
  const label = JSON.stringify(tok);

  eq(
    isSupervisorShapedToken(tok),
    oldIsSupervisorSession(tok),
    `routing byte-identity: isSupervisorShapedToken(${label}) === OLD SUPERVISOR_TOKEN_RE`,
  );

  eq(
    sid.grain,
    oldClassifyTokenGrain(tok),
    `binding byte-identity: classifySessionId(${label}).grain === old classifyTokenGrain`,
  );

  const newLabel = ((): string => {
    if (sid.kind === "window" || sid.kind === "task" || sid.kind === "thread-seat") return sid.key.domain;
    if (sid.kind === "container-supervisor") return sid.containerKey.length > 0 ? sid.containerKey : "unknown";
    if (typeof tok !== "string") return "unknown";
    const t = tok.startsWith("unified:") ? tok.slice("unified:".length) : tok;
    const suffix = t.lastIndexOf(":oe-sup:g");
    return suffix > 0 ? t.slice(0, suffix) : "unknown";
  })();
  eq(newLabel, oldDomainLabel(tok), `window-gated byte-identity: new domainLabelOf(${label}) === old domainLabelOf`);
}

{
  const junk = "oe-dom:x:oe-sup:g5:trailing";
  ok(oldIsSupervisorTokenSpend(junk), "spend outlier: substring MATCHES the trailing-junk token");
  ok(!isSupervisorShapedToken(junk), "spend outlier: anchored codec REJECTS the trailing-junk token");
  ok(
    oldIsSupervisorTokenSpend(junk) !== isSupervisorShapedToken(junk),
    "spend outlier: the substring test and the anchored codec DISAGREE — folding spend into the codec would change its truth-table (leave spend as-is)",
  );

  const nonNum = "foo:oe-sup:gX";
  ok(oldIsSupervisorTokenSpend(nonNum), "spend outlier: substring MATCHES a non-numeric-generation token");
  ok(!isSupervisorShapedToken(nonNum), "spend outlier: anchored codec REJECTS a non-numeric-generation token");
}

function expectKind(tok: unknown, kind: SessionId["kind"], grain: SessionId["grain"], note: string): void {
  const sid = classifySessionId(tok);
  eq(sid.kind, kind, `kind matrix: ${note} → kind=${kind}`);
  eq(sid.grain, grain, `grain matrix: ${note} → grain=${grain}`);
}

expectKind("oe-dom:payments:oe-sup:g4", "window", "standing", "degenerate window");
expectKind("oe-dom:payments:win:solo-C_PAY:oe-sup:g7", "window", "standing", "explicit solo window");
expectKind("oe-dom:a:b:oe-sup:g2", "window", "standing", "colon-bearing-domain window");
expectKind(`oe-dom:payments:win:t/${CK}/${TS}:oe-sup:g4`, "task", "task", "task worker (2-arg)");
expectKind(`oe-dom:payments:win:t/${CK}/${TS}/nonce9:oe-sup:g4`, "task", "task", "task worker (3-arg nonce)");
expectKind(`oe-dom:payments:win:s/${CK}/${TS}:oe-sup:g4`, "thread-seat", "thread", "thread seat");
expectKind("github:acme/widgets:oe-sup:g5", "container-supervisor", "standing", "github per-container");
expectKind("linear:TEAM123:oe-sup:g5", "container-supervisor", "standing", "linear per-container");
expectKind("notion:page-abc123:oe-sup:g5", "container-supervisor", "standing", "notion per-container");
expectKind("C_PAYMENTS01:oe-sup:g3", "container-supervisor", "standing", "slack per-container");
expectKind("teams:19:meetingabc@thread.v2:oe-sup:g1", "container-supervisor", "standing", "teams per-container");
expectKind("cse_abcdef123456", "native", "native", "eve-minted native");
expectKind("", "native", "native", "blank");
expectKind(undefined, "native", "native", "undefined");
expectKind(null, "native", "native", "null");
expectKind(12345, "native", "native", "non-string");
expectKind("C_PAY:1720000000.001", "native", "native", "bare thread ts (not supervisor)");
expectKind("unified:oe-dom:payments:oe-sup:g4", "window", "standing", "unified-prefixed window");
expectKind(`unified:oe-dom:payments:win:t/${CK}/${TS}:oe-sup:g4`, "task", "task", "unified-prefixed task");
expectKind("unified:github:acme/widgets:oe-sup:g5", "container-supervisor", "standing", "unified-prefixed per-container");
expectKind("oe-dom:x:oe-sup:g5:trailing", "native", "native", "trailing-junk (suffix not at tail)");
expectKind("foo:oe-sup:gNOTNUM", "native", "native", "non-numeric generation");
expectKind("x:oe-sup:g", "native", "native", "no-digit suffix");

{
  const gh = classifySessionId("github:acme/widgets:oe-sup:g5");
  ok(gh.kind === "container-supervisor" && gh.containerKey === "github:acme/widgets", "containerKey = github:acme/widgets");
  ok(gh.kind === "container-supervisor" && gh.generation === 5, "generation = 5 from the suffix");

  const teams = classifySessionId("teams:19:meetingabc@thread.v2:oe-sup:g1");
  ok(
    teams.kind === "container-supervisor" && teams.containerKey === "teams:19:meetingabc@thread.v2",
    "containerKey split at the LAST :oe-sup:g (colon-bearing container key preserved)",
  );

  const bare = classifySessionId("oe-sup:g1");
  ok(bare.kind === "container-supervisor" && bare.containerKey === "", "bare oe-sup:g1 → empty containerKey");
  const leadingColon = classifySessionId(":oe-sup:g1");
  ok(
    leadingColon.kind === "container-supervisor" && leadingColon.containerKey === "",
    ":oe-sup:g1 → empty containerKey (lastIndexOf === 0, not > 0)",
  );
}

{
  const t = classifySessionId(`oe-dom:payments:win:t/${CK}/${TS}/nonce9:oe-sup:g4`);
  ok(t.kind === "task" && t.key.domain === "payments", "task token still anchors its domain (payments)");
  ok(t.kind === "task" && t.key.windowId === `t/${CK}/${TS}/nonce9`, "task windowId preserved verbatim");
  ok(t.kind === "task" && t.nonce === undefined, "nonce left undefined (not segment-recoverable — multi-segment channelKey)");
}

{
  const dmTok = formatDmSeatToken("D0EXDMCH001", 7);
  eq(dmTok, "D0EXDMCH001:oe-dm:g7", "formatDmSeatToken shape");

  const sid = classifySessionId(dmTok);
  eq(sid.kind, "dm-seat", "dm-seat token classifies kind=dm-seat");
  eq(sid.grain, "native", "dm-seat grain is native (same hands as a plain DM)");
  ok(sid.kind === "dm-seat" && sid.channelId === "D0EXDMCH001", "dm-seat channelId recovered");
  ok(sid.kind === "dm-seat" && sid.generation === 7, "dm-seat generation recovered");

  ok(!isSupervisorShapedToken(dmTok), "dm-seat token is NOT supervisor-shaped (primary model, like a native DM)");

  eq(oldClassifyTokenGrain(dmTok), "native", "OLD grain oracle sees a dm-seat token as native");
  eq(oldIsSupervisorSession(dmTok), false, "OLD routing oracle: a dm-seat token is not supervisor");
  eq(sid.grain, oldClassifyTokenGrain(dmTok), "dm-seat grain byte-identity: codec === old classifyTokenGrain");
  eq(isSupervisorShapedToken(dmTok), oldIsSupervisorSession(dmTok), "dm-seat routing byte-identity: codec === old regex");
  eq(oldDomainLabel(dmTok), "unknown", "OLD label oracle: a dm-seat token → unknown (no oe-sup suffix)");
  ok(!oldIsSupervisorTokenSpend(dmTok), "spend supervisor-substring is inert to a dm-seat token");

  const parsed = parseDmSeatToken(dmTok);
  ok(parsed !== undefined && parsed.channelId === "D0EXDMCH001" && parsed.generation === 7, "parseDmSeatToken round-trips");
  ok(isDmSeatToken(dmTok), "isDmSeatToken true for a seat token");
  ok(!isDmSeatToken("D123:1720000000.001"), "isDmSeatToken false for a bare DM thread ts");
  ok(!isDmSeatToken("C_PAY:oe-sup:g3"), "isDmSeatToken false for a supervisor token");
  eq(dmSeatRegistryKey("D0EXDMCH001"), "oe-dm-seat::D0EXDMCH001", "dmSeatRegistryKey shape");
  ok(formatDmSeatToken("D0EXDMCH001", 7) !== formatDmSeatToken("D0EXDMCH001", 8), "generation bump ⇒ different token");
  ok(parseDmSeatToken("unified:D9:oe-dm:g2")?.generation === 2, "parseDmSeatToken strips unified: prefix");
}

{
  eq(bareTokenFromEveContext("slack:D0EXDMCH001:oe-dm:g2"), "D0EXDMCH001:oe-dm:g2", "OPE-92: slack-namespaced dm-seat token bares to the row token");
  eq(
    bareTokenFromEveContext("unified:oe-dom:e2e-connector:win:slack/T0EXAMPLE/C0EXGENRL:oe-sup:g2"),
    "oe-dom:e2e-connector:win:slack/T0EXAMPLE/C0EXGENRL:oe-sup:g2",
    "OPE-92: unified-namespaced solo window token bares to the row token",
  );
  eq(bareTokenFromEveContext("slack:C0EXCHAN005:oe-sup:g1"), "C0EXCHAN005:oe-sup:g1", "OPE-92: slack-namespaced per-container supervisor bares");
  eq(
    bareTokenFromEveContext("notion:notion:394cb5e7-aaaa:oe-sup:g1"),
    "notion:394cb5e7-aaaa:oe-sup:g1",
    "OPE-92: doubled platform prefix strips exactly ONE segment",
  );
  eq(bareTokenFromEveContext("D0EXDMCH001:oe-dm:g2"), "D0EXDMCH001:oe-dm:g2", "bare dm-seat token passes through");
  eq(bareTokenFromEveContext("oe-dom:payments:oe-sup:g3"), "oe-dom:payments:oe-sup:g3", "bare legacy window token passes through (NOT stripped to a container form)");
  eq(bareTokenFromEveContext("oe-dom:d:win:x:oe-sup:g1"), "oe-dom:d:win:x:oe-sup:g1", "bare explicit window token passes through");
  eq(bareTokenFromEveContext("slack:D0EXDMCH001:1720000000.001"), undefined, "namespaced native DM thread token → undefined");
  eq(bareTokenFromEveContext("cse_abc123"), undefined, "eve-native session token → undefined");
  eq(bareTokenFromEveContext(""), undefined, "empty string → undefined (eve seeds missing tokens to '')");
  eq(bareTokenFromEveContext(undefined), undefined, "non-string → undefined");
}

{
  const s1 = mintGenerationSalt();
  const s2 = mintGenerationSalt();
  ok(/^[0-9a-f]{6}$/.test(s1), `mintGenerationSalt shape: ${JSON.stringify(s1)} is 6 lowercase hex chars`);
  ok(/^[0-9a-f]{6}$/.test(s2), `mintGenerationSalt shape: ${JSON.stringify(s2)} is 6 lowercase hex chars`);
  ok(s1 !== s2, "mintGenerationSalt: two consecutive calls mint DIFFERENT salts");

  const bareWindow = "oe-dom:payments:oe-sup:g4";
  const salted = saltSupervisorGeneration(bareWindow);
  ok(salted.startsWith(`${bareWindow}-`), "saltSupervisorGeneration appends -<salt> after the bare token");
  ok(/^oe-dom:payments:oe-sup:g4-[0-9a-f]{6}$/.test(salted), `salted window token shape: ${JSON.stringify(salted)}`);
  ok(saltSupervisorGeneration(bareWindow) !== saltSupervisorGeneration(bareWindow), "saltSupervisorGeneration: re-salting the SAME bare token twice yields DIFFERENT full tokens (reset→reuse defeated)");

  const saltedCases: ReadonlyArray<{ readonly bare: string; readonly note: string }> = [
    { bare: "oe-dom:payments:oe-sup:g4", note: "degenerate window (DEGENERATE_WINDOW_TOKEN_RE)" },
    { bare: "oe-dom:payments:win:solo-C_PAY:oe-sup:g7", note: "explicit window (EXPLICIT_WINDOW_TOKEN_RE)" },
    { bare: "github:acme/widgets:oe-sup:g5", note: "per-container (SUPERVISOR_SUFFIX_RE)" },
    { bare: "linear:TEAM123:oe-sup:g5", note: "per-container linear" },
    { bare: `oe-dom:payments:win:t/${CK}/${TS}:oe-sup:g4`, note: "task window (windowId carries t/ prefix)" },
    { bare: `oe-dom:payments:win:s/${CK}/${TS}:oe-sup:g4`, note: "thread-seat window (windowId carries s/ prefix)" },
  ];
  for (const { bare, note } of saltedCases) {
    const salted2 = saltSupervisorGeneration(bare);
    const bareSid = classifySessionId(bare);
    const saltedSid = classifySessionId(salted2);
    eq(saltedSid.kind, bareSid.kind, `salted ${note}: kind unchanged (${JSON.stringify(salted2)})`);
    eq(saltedSid.grain, bareSid.grain, `salted ${note}: grain unchanged`);
    if (bareSid.kind === "window" || bareSid.kind === "task" || bareSid.kind === "thread-seat") {
      ok(saltedSid.kind === bareSid.kind && "key" in saltedSid, `salted ${note}: still a window-shaped kind`);
      if ("key" in saltedSid && "key" in bareSid) {
        eq(saltedSid.key.generation, bareSid.key.generation, `salted ${note}: generation recovered unchanged`);
        eq(saltedSid.key.domain, bareSid.key.domain, `salted ${note}: domain recovered unchanged`);
        eq(saltedSid.key.windowId, bareSid.key.windowId, `salted ${note}: windowId recovered unchanged`);
      }
    } else if (bareSid.kind === "container-supervisor" && saltedSid.kind === "container-supervisor") {
      eq(saltedSid.generation, bareSid.generation, `salted ${note}: generation recovered unchanged`);
      eq(saltedSid.containerKey, bareSid.containerKey, `salted ${note}: containerKey recovered unchanged`);
    }
    ok(isSupervisorShapedToken(salted2), `salted ${note}: isSupervisorShapedToken still true`);
    ok(oldIsSupervisorTokenSpend(salted2), `salted ${note}: spend's bare substring test still matches (inert to the salt)`);
    if (bareSid.kind === "window" || bareSid.kind === "task" || bareSid.kind === "thread-seat") {
      const parsed = parseWindowToken(salted2);
      ok(parsed !== undefined, `salted ${note}: parseWindowToken accepts the salted form`);
    }

    ok(!oldIsSupervisorSession(salted2), `salted ${note}: OLD routing oracle (\\d+$ anchored) rejects the salt — EXPECTED divergence`);
    ok(oldClassifyTokenGrain(salted2) === "native", `salted ${note}: OLD grain oracle sees a salted token as native — EXPECTED divergence`);
  }

  expectKind("oe-dom:payments:oe-sup:g4-", "native", "native", "trailing bare dash, no hex chars → rejected");
  expectKind("oe-dom:payments:oe-sup:g4-ABCDEF", "native", "native", "uppercase hex → rejected (lowercase-only salt)");
  expectKind("oe-dom:payments:oe-sup:g4-xyz123", "native", "native", "non-hex chars in the salt → rejected");
  expectKind("oe-dom:payments:oe-sup:g4-abc-def", "native", "native", "double-dash salt → rejected (not tail-anchored)");

  const wt = formatWindowToken({ domain: "payments", windowId: "payments", generation: 9 });
  eq(wt, "oe-dom:payments:oe-sup:g9", "formatWindowToken stays unsalted (pure function of the key)");
  eq(formatWindowToken({ domain: "payments", windowId: "payments", generation: 9 }), wt, "formatWindowToken is deterministic — no accidental salt leaking in");
}

{
  const DM_SURFACE = "slack/T1/D999";
  const dmWindow = formatWindowToken(dmWindowKey(DM_SURFACE, 4));
  eq(dmWindow, "oe-dom:oe-dm/slack/T1/D999:oe-sup:g4", "a DM window token is an ORDINARY degenerate window token — no :win: segment, no new field");

  expectKind(dmWindow, "window", "standing", "DM seat window (OPE-351)");
  expectKind(`unified:${dmWindow}`, "window", "standing", "unified-prefixed DM seat window");
  const sid = classifySessionId(dmWindow);
  ok(sid.kind === "window" && sid.key.domain === dmAnchorDomain(DM_SURFACE), "a DM window anchors the PSEUDO-DOMAIN as its domain (memory/access/audit anchor, exactly like a real domain does)");
  ok(sid.kind === "window" && sid.key.windowId === sid.key.domain, "…degenerately (windowId === domain)");

  ok(isSupervisorShapedToken(dmWindow), "a DM window token IS supervisor-shaped — the spend counter and rotation machinery keep the broad predicate");
  ok(oldIsSupervisorSession(dmWindow), "…and the OLD anchored routing oracle agrees (no differential introduced by the new namespace)");
  eq(oldClassifyTokenGrain(dmWindow), "standing", "…and the OLD grain oracle agrees it is standing — the reserved namespace lives INSIDE the domain field, invisible to every shape detector");

  eq(standingSeatRegistryKey(dmWindow, "ignored-fallback"), "oe-domain::oe-dm/slack/T1/D999", "a DM window token keys the ORDINARY synthetic window row (oe-domain::<windowId>)");
  eq(dmWindowRegistryKey(DM_SURFACE), standingSeatRegistryKey(dmWindow, "ignored-fallback"), "dmWindowRegistryKey (surface-key side) agrees with standingSeatRegistryKey (token side) — one row, two derivations that cannot drift");
  ok(dmWindowRegistryKey(DM_SURFACE) !== dmSeatRegistryKey("D999"), "…and it is DISTINCT from the OPE-90 dm-seat row (`oe-dm-seat::<channelId>`) — two different seats, two different rows");

  eq(parseWindowToken(dmWindow), dmWindowKey(DM_SURFACE, 4), "a DM window token round-trips through parse");
  const rotated = saltSupervisorGeneration(formatWindowToken(dmWindowKey(DM_SURFACE, 5)));
  expectKind(rotated, "window", "standing", "ROTATED (salted) DM seat window");
  eq(parseWindowToken(rotated)?.generation, 5, "a salted DM window token still recovers its numeric generation");
}

console.log(`session-id-codec-test: ${n} assertions passed (corpus size ${CORPUS.length})`);
