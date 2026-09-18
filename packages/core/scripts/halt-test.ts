import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { HaltAddress, HaltRow, OperationalStore } from "../agent/operational/store.js";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-halt-"));
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "halt.sqlite3");

const { sqliteOperationalStore, _resetOperationalDbForTest } = await import("../agent/operational/sqlite.js");
const { initOperationalSchema, makeOperationalPostgresStore } = await import("../agent/operational/postgres.js");
const { openTestPg, closeAllTestPg } = await import("./test-pg-driver.js");
const { CAP_LEVELS, OPERATIONAL_TABLES, assertHaltAddress, haltAddressColumns, haltAddressFromColumns } = await import("../agent/operational/store.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const halt = await import("../agent/access/halt.js");
const { TRANSFORM_TABLE, resolveApproverChain } = await import("../agent/access/approver-chain.js");
const { RESUME_TOOL, TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { CONTRIBUTIONS } = await import("../agent/contributions.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function throws(fn: () => Promise<unknown>, label: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    passed++;
    return e as Error;
  }
  console.error(`✗ ${label} — expected a throw, got none`);
  process.exit(1);
}

const ORG = deploymentOrg();
const OTHER_ORG = "some-other-org";
const SURFACE = "slack/T1/C1";
const WORKSPACE = "slack/T1";
const DOMAIN = "payments";
const USER = "user:slack/T1/U1";

const ORG_WIDE: HaltAddress = { orgWide: true };
const AT_SURFACE: HaltAddress = { orgWide: false, level: "surface", scopeKey: SURFACE };

ok(OPERATIONAL_TABLES.includes("halt"), "§1 `halt` is in OPERATIONAL_TABLES — a table missing there is one the sqlite→postgres migrator silently skips");

async function storeContract(store: OperationalStore, engine: string): Promise<void> {
  ok((await store.activeHalts(ORG)).length === 0, `§1/${engine} a fresh store holds no halts`);

  const fixedSetAt = "2026-05-26T05:32:00.123Z";
  await store.setHalt(ORG, ORG_WIDE, { setBy: "U-alice", setAt: fixedSetAt, setRef: "wake-owned" });
  const afterSet = await store.activeHalts(ORG);
  ok(afterSet.length === 1 && afterSet[0]!.address.orgWide === true, `§1/${engine} an org-wide halt round-trips as the org-wide ADDRESS, not as a scope key`);
  ok(afterSet[0]!.setBy === "U-alice" && afterSet[0]!.setAt === fixedSetAt && afterSet[0]!.setRef === "wake-owned", `§1/${engine} the row preserves the exact host time + wake ownership stamp`);

  await store.setHalt(ORG, AT_SURFACE, { setBy: "U-bob" });
  ok((await store.activeHalts(ORG)).length === 2, `§1/${engine} an addressed halt is a SECOND row — it does not replace the org-wide one`);

  await store.setHalt(OTHER_ORG, ORG_WIDE, { setBy: "U-elsewhere" });
  ok((await store.activeHalts(ORG)).length === 2, `§1/${engine} another org's halt is invisible — the rows are org-partitioned`);

  ok((await store.clearHalt(ORG, AT_SURFACE, { clearedBy: "U-bob" })) === true, `§1/${engine} clearHalt reports true when it cleared an ACTIVE row`);
  ok((await store.clearHalt(ORG, AT_SURFACE, { clearedBy: "U-bob" })) === false, `§1/${engine} a second clear reports false — resume is idempotent, and says so honestly`);
  await store.setHalt(ORG, AT_SURFACE, { setBy: "U-carol" });
  const re = (await store.activeHalts(ORG)).find((r) => !r.address.orgWide)!;
  ok(re.setBy === "U-carol", `§1/${engine} re-halting an address restamps setBy`);
  ok(re.clearedAt === undefined && re.clearedBy === undefined, `§1/${engine} 🔴 re-halting DROPS the previous resume stamps — a cleared_at beside an active row would read as "resumed"`);
  ok((await store.activeHalts(ORG)).length === 2, `§1/${engine} and it is still ONE row for that address, not two`);

  ok(
    (await store.clearHalt(ORG, AT_SURFACE, { clearedBy: "fixture" }, { setAt: re.setAt, setBy: "not-carol" })) === false,
    `§1/${engine} an owner-safe clear refuses a mismatched setter`,
  );
  ok(
    (await store.clearHalt(ORG, AT_SURFACE, { clearedBy: "fixture" }, { setAt: re.setAt, setBy: re.setBy, setRef: "another-wake" })) === false,
    `§1/${engine} an owner-safe clear refuses a mismatched wake ownership stamp`,
  );
  ok(
    (await store.activeHalts(ORG)).some((r) => !r.address.orgWide && r.setBy === "U-carol"),
    `§1/${engine} the refused owner-safe clear leaves the active halt untouched`,
  );
  ok(
    (await store.clearHalt(ORG, AT_SURFACE, { clearedBy: "fixture" }, { setAt: re.setAt, setBy: re.setBy })) === true,
    `§1/${engine} the exact owner-safe handle clears its own unchanged halt`,
  );
  await store.setHalt(ORG, AT_SURFACE, { setBy: "U-carol" });

  for (const level of CAP_LEVELS) {
    await store.setHalt(ORG, { orgWide: false, level, scopeKey: `k-${level}` });
  }
  const levels = (await store.activeHalts(ORG)).filter((r) => !r.address.orgWide && r.address.scopeKey.startsWith("k-"));
  ok(levels.length === CAP_LEVELS.length, `§1/${engine} all four CAP_LEVELS address a halt row`);

  await store.clearHalt(ORG, ORG_WIDE, { clearedBy: "U-alice" });
  ok(
    (await store.activeHalts(ORG)).every((r) => !r.address.orgWide),
    `§1/${engine} clearing the org-wide halt leaves the ADDRESSED rows standing — the two are a strict partition`,
  );
  for (const r of await store.activeHalts(ORG)) await store.clearHalt(ORG, r.address, { clearedBy: "cleanup" });
  await store.clearHalt(OTHER_ORG, ORG_WIDE, { clearedBy: "cleanup" });
  ok((await store.activeHalts(ORG)).length === 0, `§1/${engine} the store is clean again`);
}

{
  const livePath = process.env.OE_SQLITE_PATH!;
  const legacyPath = join(SQLITE_DIR, "legacy-halt.sqlite3");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE halt (org_id TEXT NOT NULL, level TEXT NOT NULL, scope_key TEXT NOT NULL, org_wide INTEGER NOT NULL, active INTEGER NOT NULL, set_by TEXT, set_at TEXT NOT NULL, cleared_by TEXT, cleared_at TEXT, PRIMARY KEY (org_id, level, scope_key, org_wide));`);
  legacy.prepare("INSERT INTO halt (org_id, level, scope_key, org_wide, active, set_by, set_at) VALUES (?, '', '', 1, 1, ?, ?)").run(ORG, "legacy-operator", "2026-03-18T16:50:00.000Z");
  legacy.close();
  process.env.OE_SQLITE_PATH = legacyPath;
  _resetOperationalDbForTest();
  const [row] = await sqliteOperationalStore.activeHalts(ORG);
  ok(row?.setBy === "legacy-operator" && row.setRef === undefined, "§1/sqlite legacy schema adds set_ref without rewriting an existing operator halt");
  await sqliteOperationalStore.clearHalt(ORG, ORG_WIDE, { clearedBy: "cleanup" }, { setAt: row!.setAt, setBy: row!.setBy });
  process.env.OE_SQLITE_PATH = livePath;
  _resetOperationalDbForTest();
}

await storeContract(sqliteOperationalStore, "sqlite");
{
  const pg = await openTestPg();
  await pg.client.query(`CREATE TABLE halt (org_id text NOT NULL, level text NOT NULL, scope_key text NOT NULL, org_wide boolean NOT NULL, active boolean NOT NULL, set_by text, set_at text NOT NULL, cleared_by text, cleared_at text, PRIMARY KEY (org_id, level, scope_key, org_wide))`);
  await pg.client.query("INSERT INTO halt (org_id, level, scope_key, org_wide, active, set_by, set_at) VALUES ($1, '', '', true, true, $2, $3)", [ORG, "legacy-operator", "2026-03-18T16:50:00.000Z"]);
  await initOperationalSchema(pg.client);
  const store = makeOperationalPostgresStore(pg.client);
  const [legacy] = await store.activeHalts(ORG);
  ok(legacy?.setBy === "legacy-operator" && legacy.setRef === undefined, "§1/postgres legacy schema adds set_ref without rewriting an existing operator halt");
  await store.clearHalt(ORG, ORG_WIDE, { clearedBy: "cleanup" }, { setAt: legacy!.setAt, setBy: legacy!.setBy });
  await storeContract(store, "postgres");
}

assert.throws(() => assertHaltAddress({ orgWide: false, level: "surface", scopeKey: "  " }), /non-blank/);
passed++;
assert.throws(() => assertHaltAddress({ orgWide: false, level: "nonsense" as never, scopeKey: "x" }), /halt level/);
passed++;
assertHaltAddress(ORG_WIDE);
passed++;
{
  const cols = haltAddressColumns(ORG_WIDE);
  ok(cols.orgWide === true && cols.level === "" && cols.scopeKey === "", "§1 the org-wide row stores EMPTY filler beside the marker — never a sentinel string");
  ok(haltAddressFromColumns("", "", true).orgWide === true, "§1 and the decode branches on the MARKER, so it never reads the filler back as an address");
  ok(haltAddressFromColumns("domain", "", false).orgWide === false, "§1 a domain row with an empty key decodes as ADDRESSED, not as org-wide — the marker decides, not the string");
}

const row = (address: HaltAddress, org = ORG): HaltRow => ({ org, address, active: true, setAt: "2026-03-10T16:50:00Z" });
const FULL_SCOPE = { org: ORG, surfaceKey: SURFACE, workspaceKey: WORKSPACE, domain: DOMAIN, userScopeKey: USER };

ok(halt.haltRowCovers(row(ORG_WIDE), { org: ORG }), "§2 an org-wide row covers a call that can name NO axis at all");
ok(!halt.haltRowCovers(row(ORG_WIDE, OTHER_ORG), { org: ORG }), "§2 negative control: another org's org-wide row covers nothing here");
ok(halt.haltRowCovers(row({ orgWide: false, level: "surface", scopeKey: SURFACE }), FULL_SCOPE), "§2 the surface axis matches");
ok(halt.haltRowCovers(row({ orgWide: false, level: "workspace", scopeKey: WORKSPACE }), FULL_SCOPE), "§2 the workspace axis matches");
ok(halt.haltRowCovers(row({ orgWide: false, level: "domain", scopeKey: DOMAIN }), FULL_SCOPE), "§2 the domain axis matches");
ok(halt.haltRowCovers(row({ orgWide: false, level: "user", scopeKey: USER }), FULL_SCOPE), "§2 the person axis matches");
ok(
  !halt.haltRowCovers(row({ orgWide: false, level: "surface", scopeKey: SURFACE }), { org: ORG, workspaceKey: WORKSPACE, domain: DOMAIN, userScopeKey: USER }),
  "§2 negative control: a surface row does NOT match a call that names every OTHER axis — the axes are independent, not a ladder",
);
ok(
  !halt.haltRowCovers(row({ orgWide: false, level: "workspace", scopeKey: WORKSPACE }), { org: ORG, surfaceKey: SURFACE }),
  "🔴 §2 a WORKSPACE halt does not reach a call that names only its surface — a caller that cannot name an axis is not covered on it, which is why each arrow's comment says which axes it names",
);
ok(
  !halt.haltRowCovers(row({ orgWide: false, level: "domain", scopeKey: "" }), { org: ORG, domain: DOMAIN }),
  "§2 🔴 an empty-keyed DOMAIN row matches no real domain — the filler columns cannot become a wildcard",
);
{
  const rows = [row({ orgWide: false, level: "surface", scopeKey: SURFACE }), row(ORG_WIDE)];
  ok(halt.haltCovering(rows, FULL_SCOPE)?.address.orgWide === true, "§2 when several rows cover, the ORG-WIDE one is reported — a refusal names the widest true reason");
  ok(halt.haltCovering([], FULL_SCOPE) === undefined, "§2 negative control: no rows, no cover");
}

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { grantCallHaltScope } = await import("../agent/access/credential-grant-broker.js");

const CTX_SURFACE = "local/dev/default";
const GRANT_SCOPE = "slack/T1/C-grant";
const GRANT_SESSION = "sess-grant-1";
const OTHER_DOMAIN = "sundries";

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: DOMAIN, reach: [SURFACE, GRANT_SCOPE, CTX_SURFACE] }), defineDomain({ name: OTHER_DOMAIN, reach: ["slack/T1/C-sundry"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
} as never);

{
  type Scope = ReturnType<typeof halt.haltScopeFor>;

  const ARROWS: readonly { readonly arrow: string; readonly file: string; readonly scope: Scope }[] = [
    {
      arrow: "the approver chain (the propose plane's halt read)",
      file: "approvals/flow.ts",
      scope: halt.haltScopeFor({ org: ORG, scopeKey: SURFACE, domain: DOMAIN, principalId: "U1" }),
    },
    {
      arrow: "the approval CLICK (the decide plane's halt read)",
      file: "approvals/flow.ts",
      scope: halt.haltScopeFor({ org: ORG, scopeKey: SURFACE, domain: DOMAIN, principalId: "U1" }),
    },
    {
      arrow: "both routine legs",
      file: "routines/fire-halt.ts",
      scope: halt.haltScopeFor({ org: ORG, scopeKey: SURFACE, principalId: "U1" }),
    },
    {
      arrow: "the credential-grant broker",
      file: "access/credential-grant-broker.ts",
      scope: grantCallHaltScope({
        org: ORG,
        platform: "slack",
        workspace: "T1",
        surface: "C-grant",
        scopeKey: GRANT_SESSION,
        requesterPrincipalId: "slack/T1/U1",
        nowMs: 0,
      }),
    },
    {
      arrow: "the open_pull_request session memo",
      file: "tools/open_pull_request.ts",
      scope: halt.haltScopeFor({ org: ORG, scopeKey: SURFACE, principalId: "U1" }),
    },
    {
      arrow: "the egress hook (the sandbox plane)",
      file: "hooks/egress.ts",
      scope: halt.haltScopeFor({ org: ORG, scopeKey: SURFACE, principalId: "U1" }),
    },
  ];

  const AXES = [
    { level: "surface", of: (s: Scope) => s.surfaceKey, unrelated: "slack/T1/C-OTHER" },
    { level: "workspace", of: (s: Scope) => s.workspaceKey, unrelated: "slack/T-OTHER" },
    { level: "domain", of: (s: Scope) => s.domain, unrelated: OTHER_DOMAIN },
    { level: "user", of: (s: Scope) => s.userScopeKey, unrelated: "user:slack/T1/U-OTHER" },
  ] as const;

  const agentSrc = (rel: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", rel), "utf8");

  for (const { arrow, file, scope } of ARROWS) {
    ok(/haltScopeFor(Ctx)?\(/.test(agentSrc(file)), `§2b STRUCTURAL: ${file} derives its halt address through this module — the row below describes a real call site`);
    for (const axis of AXES) {
      const key = axis.of(scope);
      ok(key !== undefined, `🔴 §2b ${arrow} names the ${axis.level} axis — an axis it cannot name is an axis no halt row reaches there`);
      ok(
        halt.haltRowCovers(row({ orgWide: false, level: axis.level, scopeKey: key! }), scope),
        `§2b a ${axis.level} halt COVERS ${arrow}`,
      );
      ok(
        !halt.haltRowCovers(row({ orgWide: false, level: axis.level, scopeKey: axis.unrelated }), scope),
        `🔴 §2b NEGATIVE CONTROL: a ${axis.level} halt at an UNRELATED key does not cover ${arrow}`,
      );
    }
    ok(halt.haltRowCovers(row(ORG_WIDE), scope), `§2b and an org-wide halt covers ${arrow}`);
    ok(!halt.haltRowCovers(row(ORG_WIDE, OTHER_ORG), scope), `§2b NEGATIVE CONTROL: another org's org-wide halt does not cover ${arrow}`);
  }

  const ctxScope = halt.haltScopeForCtx({} as never);
  for (const file of ["access/connector-scope.ts", "access/host-egress.ts", "tools/aws.ts", "instructions/access.ts"]) {
    ok(/haltScopeForCtx\(/.test(agentSrc(file)), `§2b STRUCTURAL: ${file} derives its halt address through haltScopeForCtx — one derivation, four call sites`);
  }
  ok(ctxScope.surfaceKey === CTX_SURFACE && ctxScope.workspaceKey === "local/dev", "§2b the ctx arrows name the surface and the tenant above it");
  ok(ctxScope.domain === DOMAIN, "🔴 §2b THE FIX: the ctx arrows name the DOMAIN axis too — without it a `level: \"domain\"` halt left the connector wall, both egress planes, `aws` and the seat running");
  ok(
    halt.haltRowCovers(row({ orgWide: false, level: "domain", scopeKey: DOMAIN }), ctxScope),
    "§2b so a domain halt COVERS the ctx arrows",
  );
  ok(
    !halt.haltRowCovers(row({ orgWide: false, level: "domain", scopeKey: OTHER_DOMAIN }), ctxScope),
    "🔴 §2b NEGATIVE CONTROL: a domain halt on an unrelated domain does not cover them",
  );
  ok(ctxScope.userScopeKey === undefined, "§2b an identity-less context carries NO person axis — the honest limit of this tier, not a pass");

  const sessionIdScope = halt.haltScopeFor({ org: ORG, scopeKey: GRANT_SESSION, principalKey: "slack/T1/U1" });
  ok(sessionIdScope.surfaceKey === undefined && sessionIdScope.workspaceKey === undefined, "🔴 §2c a SESSION ID names no surface and no tenant — the axes a session-keyed halt address loses");
  ok(sessionIdScope.domain === GRANT_SESSION, "🔴 §2c and it is misread as a bare DOMAIN NAME, so the domain axis matches a session id instead of a domain");
  ok(!halt.haltRowCovers(row({ orgWide: false, level: "domain", scopeKey: DOMAIN }), sessionIdScope), "🔴 §2c so the real domain's halt does NOT cover a session-keyed address — the hole this fix closed");
}

{
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warned.push(args.map((a) => String(a)).join(" "));
  };
  let unreadable: Awaited<ReturnType<typeof halt.resolveHalt>>;
  try {
    unreadable = await halt.resolveHalt({ org: ORG }, { rows: () => Promise.reject(new Error("store is down")) });
  } finally {
    console.warn = realWarn;
  }
  ok(unreadable.halted === true, "🔴 §3 an UNREADABLE store answers HALTED — a reader that failed open could be switched off by breaking the database");
  ok(unreadable.halted === true && unreadable.unreadable !== undefined, "§3 and it says so, so the refusal sentence can distinguish it from an operator's act");
  ok(halt.haltRefusalMessage(unreadable, "this action").includes("could not be read"), "§3 the refusal names the fail-closed case rather than inventing an address");
  ok(
    warned.some((w) => w.includes("[open-everywhere:halt]") && w.includes(ORG) && w.includes("store is down")),
    "🔴 §3 the fail-closed arm WARNS, naming the org and the underlying error — a silent arm leaves a broken store indistinguishable from a halt in every log",
  );

  const warnedOnClear: string[] = [];
  const realWarn2 = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnedOnClear.push(args.map((a) => String(a)).join(" "));
  };
  let clear: Awaited<ReturnType<typeof halt.resolveHalt>>;
  try {
    clear = await halt.resolveHalt({ org: ORG }, { rows: async () => [] });
  } finally {
    console.warn = realWarn2;
  }
  ok(
    !warnedOnClear.some((w) => w.includes("[open-everywhere:halt]")),
    "§3 negative control: a READABLE store warns nothing — the line belongs to the throw, not to every resolve",
  );
  ok(clear.halted === false, "§3 negative control: a readable store with no rows answers NOT halted");
  ok(halt.haltSeatParagraph(clear) === null, "§3 and the seat is told nothing at all — byte-identical prompt on every ordinary turn");
  ok((halt.haltSeatParagraph(unreadable) ?? "").includes("resume"), "§3 a halted seat is told how it ends");
  ok(!/scopeKey|orgWide|slack\//.test(halt.haltSeatParagraph(unreadable) ?? ""), "§3 🔴 the seat's line is PRODUCT COPY — no ids, no level, no scope key");
}

{
  const s = halt.haltScopeFor({ org: ORG, scopeKey: SURFACE, domain: DOMAIN, principalId: "U1" });
  ok(s.surfaceKey === SURFACE && s.workspaceKey === WORKSPACE, "§4 a surface key yields BOTH the surface and the tenant above it");
  ok(s.domain === DOMAIN, "§4 the caller's domain is carried");
  ok(s.userScopeKey === USER, "§4 the person axis is composed against the key's own platform/tenant");
  const bare = halt.haltScopeFor({ org: ORG, scopeKey: DOMAIN, principalId: "U1" });
  ok(bare.domain === DOMAIN, "§4 a BARE NAME is read as a domain — read through the one grammar reader, never a hand-rolled split");
  ok(bare.userScopeKey === undefined, "🔴 §4 and it carries NO person axis: a domain key names no platform, so no `user:` key can be built. Stated, not papered over");
  ok(halt.haltScopeFor({ org: ORG, scopeKey: USER }).userScopeKey === USER, "§4 a principal key IS the person axis");
  ok(halt.haltScopeFor({ org: ORG, principalKey: "slack/T1/U1" }).userScopeKey === USER, "§4 an already-composed principal key needs no platform (the grant broker holds one)");
  ok(halt.haltScopeFor({ org: ORG, scopeKey: "a//b/c/d" }).surfaceKey === undefined, "§4 a malformed key contributes no axis — never a guess");
}

{
  const arrow = TRANSFORM_TABLE.find((t) => t.name === "mode:HALT");
  ok(arrow !== undefined && arrow.stage === "mode", "§5 the halt is an arrow in the SAME stage as mode:DENY_ALL — one question, one answer, two sources");

  const denied = await resolveApproverChain({ tool: "post_message", action: "message.post", unattended: false, halted: true });
  ok(denied.verdict === "deny", "§5 a gated verb is DENIED while halted");
  ok(denied.transforms.some((t) => t.name === "mode:HALT" && t.reason === "halt"), "§5 and the audited reason is `halt`, distinct from `mode-deny-all`");

  const control = await resolveApproverChain({ tool: "post_message", action: "message.post", unattended: false, halted: false });
  ok(control.verdict !== "deny", "🔴 §5 NEGATIVE CONTROL: the same verb with the halt CLEARED is not denied — the deny is the halt's, not the verb's");
  ok(!control.transforms.some((t) => t.name === "mode:HALT"), "§5 and the arrow leaves no transform row when it does not fire");

  const resumed = await resolveApproverChain({ tool: RESUME_TOOL, action: "halt.resume", unattended: false, halted: true });
  ok(resumed.verdict !== "deny", "🔴 §5 `resume` IS EXEMPT — without this a halt denies its own lift and the deployment is bricked");
  ok(!resumed.transforms.some((t) => t.name === "mode:HALT"), "§5 the exemption is in the arrow's own `fires`, so no transform row is written for it either");

  const bypass = await resolveApproverChain({ tool: "post_message", action: "message.post", unattended: false, halted: true, mode: { mode: "DANGEROUSLY_BYPASS" } });
  ok(bypass.verdict === "deny", "🔴 §5 a DANGEROUSLY_BYPASS domain is STILL halted — the bypass lifts ask→allow and the halt arrow, later in the same stage, denies the allow");

  const bypassResume = await resolveApproverChain({ tool: RESUME_TOOL, action: "halt.resume", unattended: false, halted: true, mode: { mode: "DANGEROUSLY_BYPASS" } });
  ok(bypassResume.verdict === "ask", "🔴 §5a `resume` STAYS CARDED in a DANGEROUSLY_BYPASS domain — no domain mode auto-approves the lift of an org-wide stop");
  ok(!bypassResume.transforms.some((t) => t.name === "mode:DANGEROUSLY_BYPASS"), "§5a and the exemption is in the bypass arrow's own `fires`, so it writes no transform row for `resume`");
  const bypassControl = await resolveApproverChain({ tool: "post_message", action: "message.post", unattended: false, halted: false, mode: { mode: "DANGEROUSLY_BYPASS" } });
  ok(bypassControl.verdict === "allow", "🔴 §5a NEGATIVE CONTROL: the bypass still fires for every OTHER verb — the exemption is exactly one name, not a disabled arrow");
  const bypassResumeUnhalted = await resolveApproverChain({ tool: RESUME_TOOL, action: "halt.resume", unattended: false, halted: false, mode: { mode: "DANGEROUSLY_BYPASS" } });
  ok(bypassResumeUnhalted.verdict === "ask", "🔴 §5a and `resume` is carded in a bypass domain whether or not a halt is in force — the rule is about the VERB, not about the incident");

  const aws = await resolveApproverChain({ tool: "aws", unattended: false, halted: true });
  ok(aws.verdict === "deny", "§5b the arrow denies `aws` while halted");
  const mounted = CONTRIBUTIONS.contributions.filter((c) => c.kind === "tool");
  ok(mounted.some((c) => c.name === RESUME_TOOL), "🔴 §5c the name the two arrows EXEMPT is a MOUNTED tool — rename the tool without this constant and both cells exempt a name no tool carries");
  ok(mounted.some((c) => c.name === RESUME_TOOL && c.module === `agent/tools/${RESUME_TOOL}.js`), "🔴 §5c and the mounted name is the module's own slug — the registration and the exemption are one fact");
  const mountedNames: readonly string[] = mounted.map((c) => c.name);
  ok(!mountedNames.includes("resume_renamed_probe"), "🔴 §5c NEGATIVE CONTROL: a name no tool carries is NOT mounted — the two assertions above can fail");
  ok(TOOL_CONSEQUENCE[RESUME_TOOL]?.tier === "gate:admin", "§5c the lift verb is admin-gated — the exemption lets it REACH the chain, it does not uncard it");
  const renamedProbe = await resolveApproverChain({ tool: "resume_renamed_probe", action: "halt.resume", unattended: false, halted: true });
  ok(renamedProbe.verdict === "deny", "🔴 §5c NEGATIVE CONTROL: a verb spelled any OTHER way is denied while halted — the exemption is exactly the one registered name");

  const awsControl = await resolveApproverChain({ tool: "aws", unattended: false, halted: false });
  ok(awsControl.verdict !== "deny", "🔴 §5b NEGATIVE CONTROL: `aws` is `open` and allowed with the halt cleared — the deny above is the halt's");
  ok(
    /halted: \(await resolveHalt/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools", "aws.ts"), "utf8")),
    "§5b STRUCTURAL: tools/aws.ts RESOLVES the halt into its own chain request — the arrow above can only fire on a request that carries the field",
  );
}

{
  const { routineFireHalted } = await import("../agent/routines/fire-halt.js");
  const fireAudit = await import("../agent/routines/fire-audit.js");
  ok(typeof fireAudit.skipThrottleKey("r1", "halted") === "string", "§6 `halted` is a member of the SHARED RoutineSkipReason vocabulary — the throttle keys it like every other reason");

  const r = {
    id: "r1",
    org: ORG,
    surfaceKey: SURFACE,
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "do the thing",
    createdAt: "2026-03-10T16:50:00Z",
    status: "active",
    consecutiveFailures: 0,
    createdBy: "U1",
  } as Parameters<typeof routineFireHalted>[0];

  const skips: string[] = [];
  const auditDeps = {
    audit: async (entry: { detail?: Record<string, unknown> }) => void skips.push(String(entry.detail?.["reason"])),
    markSeen: async () => true,
  };

  ok(
    (await routineFireHalted(r, {}, { halt: { rows: async () => [row(ORG_WIDE)] }, audit: auditDeps })) === true,
    "§6a a covering halt SKIPS the fire",
  );
  ok(skips.includes("halted"), "§6a and it writes `routine.skip` with reason `halted` — the shared vocabulary, not a new one");
  skips.length = 0;
  ok(
    (await routineFireHalted(r, {}, { halt: { rows: async () => [] }, audit: auditDeps })) === false,
    "🔴 §6b NEGATIVE CONTROL: with no covering row the same routine fires",
  );
  ok(skips.length === 0, "§6b and writes no skip row");
  ok(
    (await routineFireHalted(r, {}, { halt: { rows: () => Promise.reject(new Error("down")) }, audit: auditDeps })) === true,
    "§6 an unreadable store skips the fire — fail-closed, like every other arrow (and it costs nothing a broken store was not already costing: both legs read their routines from it)",
  );

  const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent");
  for (const leg of ["schedules/dispatch.ts", "routines/ingress.ts"]) {
    ok(readFileSync(join(agentDir, leg), "utf8").includes("routineFireHalted("), `§6c STRUCTURAL: ${leg} calls the shared predicate — one gate, both legs`);
  }
}

{
  const { HALT_UNRESOLVED_ROOM_NOTE, grantCallRoomUnresolved, runGrantedCall } = await import("../agent/access/credential-grant-broker.js");
  const { credentialGrantRefusalMessage } = await import("../agent/operational/credential-grant-rows.js");
  const store = sqliteOperationalStore;
  await store.addCredentialGrant(ORG, {
    askId: "ask-1",
    connector: "notion",
    createdAt: "2026-03-10T16:50:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    frozenArgs: {},
    id: "g-halt",
    inputSchema: { type: "object", properties: {} },
    mcpTool: "notion-fetch",
    mode: "session",
    ownerPrincipalId: "slack/T1/U-owner",
    ownerSlug: "rowan_hale",
    purpose: "read the launch page",
    requesterPrincipalId: "slack/T1/U1",
    resource: "notion:page/page-A",
    scopeKey: GRANT_SESSION,
    status: "active",
    tier: "read",
    toolName: "grant__rowan_hale_notion__notion_fetch",
    verb: "read_page",
  });
  const ctx = {
    org: ORG,
    platform: "slack",
    workspace: "T1",
    surface: "C-grant",
    scopeKey: GRANT_SESSION,
    requesterPrincipalId: "slack/T1/U1",
    nowMs: Date.parse("2026-03-10T17:50:00Z"),
  };

  await store.setHalt(ORG, ORG_WIDE, { setBy: "U-alice" });
  const refused = await runGrantedCall("g-halt", {}, ctx);
  ok(refused.ok === false && refused.refused === "halted", "§7 a borrowed grant call is refused `halted` — the granted tool never routes through the chain, so this line is its only halt");
  ok(refused.ok === false && refused.message.includes("stays granted"), "§7 and the sentence says the GRANT is untouched — a halt is not an expiry, and must not read like one");

  await store.clearHalt(ORG, ORG_WIDE, { clearedBy: "U-alice" });
  const allowed = await runGrantedCall("g-halt", {}, ctx);
  ok(allowed.ok === false && allowed.refused !== "halted", "🔴 §7 NEGATIVE CONTROL: with the halt cleared the same call gets PAST the halt line (it then refuses for its own reasons — no transport is registered here)");

  const brokerDomainRow: HaltAddress = { orgWide: false, level: "domain", scopeKey: DOMAIN };
  await store.setHalt(ORG, brokerDomainRow, { setBy: "U-alice" });
  const byDomain = await runGrantedCall("g-halt", {}, ctx);
  ok(byDomain.ok === false && byDomain.refused === "halted", "🔴 §7a a `level: \"domain\"` halt refuses the borrowed grant — the broker honours the domain axis");
  await store.clearHalt(ORG, brokerDomainRow, { clearedBy: "U-alice" });
  const otherDomainRow: HaltAddress = { orgWide: false, level: "domain", scopeKey: OTHER_DOMAIN };
  await store.setHalt(ORG, otherDomainRow, { setBy: "U-alice" });
  const unrelated = await runGrantedCall("g-halt", {}, ctx);
  ok(unrelated.ok === false && unrelated.refused !== "halted", "🔴 §7a NEGATIVE CONTROL: a halt on an UNRELATED domain does not refuse it");
  await store.clearHalt(ORG, otherDomainRow, { clearedBy: "U-alice" });
  ok(credentialGrantRefusalMessage({ connector: "notion", mcpTool: "notion-fetch", ownerSlug: "x", resource: "r" }, "halted") !== credentialGrantRefusalMessage({ connector: "notion", mcpTool: "notion-fetch", ownerSlug: "x", resource: "r" }, "expired"), "§7 the halted copy is its own sentence, not a reused one");

  const { surface: _resolvedSurface, ...roomlessCtx } = ctx;
  const unresolvedCtx = { ...roomlessCtx, platform: "unknown", workspace: "unknown" };
  await store.setHalt(ORG, otherDomainRow, { setBy: "U-alice" });
  const unreadableRoom = await runGrantedCall("g-halt", {}, unresolvedCtx);
  ok(unreadableRoom.ok === false && unreadableRoom.refused === "halted", "🔴 §7c an UNRESOLVABLE room is refused under a halt addressed to an UNRELATED domain — a kill switch fails closed on an address it cannot read");
  ok(unreadableRoom.ok === false && unreadableRoom.message.includes(HALT_UNRESOLVED_ROOM_NOTE), "🔴 §7c and the refusal says the room could not be resolved, so the halt was applied to be safe");
  await store.clearHalt(ORG, otherDomainRow, { clearedBy: "U-alice" });
  const unreadableRoomNoHalt = await runGrantedCall("g-halt", {}, unresolvedCtx);
  ok(unreadableRoomNoHalt.ok === false && unreadableRoomNoHalt.refused !== "halted", "🔴 §7c NEGATIVE CONTROL: with NO active halt row the same unresolvable room gets PAST the halt line — the fail-closed arm reads the rows, it does not refuse on the address alone");
  ok(grantCallRoomUnresolved(ctx) === false, "🔴 §7c NEGATIVE CONTROL: a ctx that names its room is NOT unresolved — the addressed path is still the normal one");
}

{
  const { sessionMemoAdmissible } = await import("../agent/tools/open_pull_request.js");
  ok(sessionMemoAdmissible({ sessionId: "s1", tainted: false, halted: false }) === true, "🔴 §7b NEGATIVE CONTROL: a clean session with a live memo still takes the shortcut — the halt is what closes it, not this refactor");
  ok(sessionMemoAdmissible({ sessionId: "s1", tainted: false, halted: true }) === false, "§7b a HALT closes the bypass — the call falls through to the chain, which denies it with the halt arrow's own reason and one audit shape");
  ok(sessionMemoAdmissible({ sessionId: "s1", tainted: true, halted: false }) === false, "§7b the pre-existing taint refusal is untouched");
  ok(sessionMemoAdmissible({ tainted: false, halted: false }) === false, "§7b no session, no memo to read");
}

{
  const { computeEgressPolicy } = await import("../agent/hooks/egress.js");
  const access = { scopeKey: SURFACE, connectors: [], connectorContentOrigin: {}, reachableHosts: [] } as never;
  const compile = async () => ({ allow: { "api.example.com": {} } }) as never;

  const open = await computeEgressPolicy(() => access, compile, async () => false);
  ok(typeof open.policy !== "string", "🔴 §8a NEGATIVE CONTROL: with no halt the compiled policy is returned unchanged");

  const cut = await computeEgressPolicy(() => access, compile, async () => true);
  ok(cut.policy === "deny-all", "§8a a halt forces the SANDBOX policy to deny-all");
  ok(cut.halted === true, "§8a and marks WHY — distinct from `compileError`, so an incident responder is not sent to debug a bundle");
  ok(cut.compileError === undefined, "§8a a halt is not a compile failure and never reports as one");
  ok(cut.reachableHosts.length === 0, "§8a nothing is left attributed as reachable");

  {
    const { enforceEgress } = await import("../agent/hooks/egress.js");
    const stamps: boolean[] = [];
    const baseDeps = {
      compile: async () => "deny-all" as never,
      apply: async () => undefined,
      lastApplied: () => undefined,
      rememberApplied: () => undefined,
      lastConnectors: () => undefined,
      rememberConnectors: () => undefined,
      scope: () => ({ org: ORG, platform: "slack", workspace: "T1", surface: "C1" }),
      audit: async () => undefined,
      stamp: () => undefined,
      halted: async () => false,
      stampHalted: (h: boolean) => void stamps.push(h),
    } as never as Parameters<typeof enforceEgress>[1];

    await enforceEgress("turn.started", { ...baseDeps, resolve: () => access });
    ok(stamps.at(-1) === false, "🔴 §8a-bis NEGATIVE CONTROL: a pass that ASKED and heard 'no halt' stamps false, so the two names stay mounted");

    await enforceEgress("turn.started", {
      ...baseDeps,
      resolve: () => {
        throw new Error("bundle references a secretRef that is not set");
      },
    });
    ok(stamps.at(-1) === true, "§8a-bis a pass that FAILED before the halt question stamps true — unknown fails closed, exactly as the reader does");
  }

  const { assertEgressReach, egressReachDenial } = await import("../agent/access/host-egress.js");
  const hosts = () => [{ host: "api.example.com", viaConnection: null }] as never;
  const fakeCtx = {} as never;
  const reached = await assertEgressReach(fakeCtx, "https://api.example.com/x", { hosts, halted: async () => false });
  ok(reached.hostname === "api.example.com", "🔴 §8b NEGATIVE CONTROL: with no halt an allow-listed host is reachable");
  const denial = await throws(
    () => assertEgressReach(fakeCtx, "https://api.example.com/x", { hosts, halted: async () => true }),
    "§8b a halt refuses a host-side fetch",
  );
  ok(denial.message.includes("break-glass halt"), "§8b and the sentence says it is not about this host — a refusal that blamed the allow-list would send somebody to widen a bundle");
  const offList = await throws(
    () => assertEgressReach(fakeCtx, "https://not-granted.example/x", { hosts, halted: async () => true }),
    "§8b a halt refuses an off-list host too",
  );
  ok(offList.message.includes("break-glass halt"), "🔴 §8b the halt refuses BEFORE the allow-list — an off-list host under a halt is refused for the HALT, not for the list");
  const offListControl = await throws(
    () => assertEgressReach(fakeCtx, "https://not-granted.example/x", { hosts, halted: async () => false }),
    "§8b negative control: the same off-list host with no halt",
  );
  ok(offListControl.message.includes("not on this session's egress allow-list"), "🔴 §8b NEGATIVE CONTROL: with no halt that same host is refused by the ALLOW-LIST — which is what makes the line above an ordering measurement");
  ok(egressReachDenial("web_fetch", "api.example.com", "halted") !== egressReachDenial("web_fetch", "api.example.com", "not-allowlisted"), "§8b the halted refusal is its own sentence");
}

{
  const { assertConnectorGranted } = await import("../agent/access/connector-scope.js");
  const noAuth = {} as never;

  const before = await throws(() => assertConnectorGranted("notion", noAuth), "§9 negative control: an unresolvable surface is refused for its OWN reason");
  ok(/could not resolve the calling surface/.test(before.message), "🔴 §9 NEGATIVE CONTROL: with no halt the refusal is the pre-existing unresolved-surface one");

  await sqliteOperationalStore.setHalt(ORG, ORG_WIDE, { setBy: "U-alice" });
  const during = await throws(() => assertConnectorGranted("notion", noAuth), "§9 a halt refuses a connector op");
  ok(/halted/.test(during.message), "§9 a halt refuses the connector op");
  ok(!/could not resolve the calling surface/.test(during.message), "🔴 §9 and it refuses FIRST — the halt sentence replaces the surface one, it does not follow it");
  await sqliteOperationalStore.clearHalt(ORG, ORG_WIDE, { clearedBy: "U-alice" });

  const DOMAIN_ROW: HaltAddress = { orgWide: false, level: "domain", scopeKey: DOMAIN };
  await sqliteOperationalStore.setHalt(ORG, DOMAIN_ROW, { setBy: "U-alice" });
  const byDomain = await throws(() => assertConnectorGranted("notion", noAuth), "§9b an unresolvable surface is still refused");
  ok(
    /could not resolve the calling surface/.test(byDomain.message),
    "🔴 §9b the NO-CTX branch names only the org, so a domain row does not reach it — an unresolvable surface has no domain, and this call is refused for that instead",
  );
  await sqliteOperationalStore.clearHalt(ORG, DOMAIN_ROW, { clearedBy: "U-alice" });
}

{
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const { HALTED_WITHHELD_TOOLS, projectToolSet } = await import("../agent/access/untrusted-projection.js");
  const { stampHalted } = await import("../agent/access/halt-state.js");

  ok(
    JSON.stringify([...HALTED_WITHHELD_TOOLS].sort()) === JSON.stringify(["web_fetch", "web_search"]),
    "§10 the subtracted set is EXACTLY the two names no arrow can reach — every other consequential verb is REFUSED, which is the stronger control",
  );

  class FakeSession {
    private readonly store = new Map<string, unknown>();
    get<T>(key: { name: string }): T | undefined {
      return this.store.get(key.name) as T | undefined;
    }
    has(key: { name: string }): boolean {
      return this.store.has(key.name);
    }
    require<T>(key: { name: string }): T {
      if (!this.has(key)) throw new Error(`missing ${key.name}`);
      return this.get(key) as T;
    }
    set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
      const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
      this.store.set(key.name, next);
      return next;
    }
    ensure<T>(key: { name: string }, create: () => T): T {
      return this.has(key) ? this.require(key) : this.set(key, create());
    }
    clearVirtualContext(): void {}
    setVirtualContext(): void {}
    *entries(): Generator<readonly [unknown, unknown]> {}
  }
  const g = globalThis as Record<PropertyKey, unknown>;
  const alsKey = Symbol.for("eve.context-storage");
  g[alsKey] ??= new AsyncLocalStorage();
  const als = g[alsKey] as InstanceType<typeof AsyncLocalStorage>;
  const inTurn = <T>(fn: () => T): Promise<T> => als.run(new FakeSession(), fn) as Promise<T>;

  const set = () => ({ web_search: {}, web_fetch: {}, reply: {}, bash: {} }) as Record<string, unknown>;

  const unstamped = await inTurn(() => {
    const s = set();
    projectToolSet(s);
    return s;
  });
  ok("web_search" in unstamped && "web_fetch" in unstamped, "🔴 §10 NEGATIVE CONTROL: with no halt read stamped, NOTHING is subtracted — `null` is not fail-open, it is 'no read happened in this session'");

  const clear = await inTurn(() => {
    stampHalted(false);
    const s = set();
    projectToolSet(s);
    return s;
  });
  ok("web_search" in clear && "web_fetch" in clear, "🔴 §10 NEGATIVE CONTROL: a stamp of NOT-halted leaves both names mounted");

  const halted = await inTurn(() => {
    stampHalted(true);
    const s = set();
    projectToolSet(s);
    return s;
  });
  ok(!("web_search" in halted) && !("web_fetch" in halted), "§10 a halted stamp SUBTRACTS both names — absence, the only control that reaches them");
  ok("reply" in halted, "§10 and it subtracts nothing else: a halted deployment still converses");
}

{
  const haltTool = await import("../agent/tools/halt.js");
  ok(haltTool.chatHaltAddress("org", SURFACE).orgWide === true, "§11 the chat `halt`'s `org` scope is the ORG-WIDE address");
  const surfaceAddr = haltTool.chatHaltAddress("surface", SURFACE);
  ok(surfaceAddr.orgWide === false && surfaceAddr.scopeKey === SURFACE && surfaceAddr.level === "surface", "§11 its `surface` scope is HOST-DERIVED from the seat's own binding");
  ok(haltTool.haltConfirmation("org").includes("resume"), "§11 the room is told how it ends");
  ok(/still read, reply/.test(haltTool.haltConfirmation("org")), "§11 and that the agent is not silenced — a halt stops acts, not conversation");

  const confirmation = haltTool.haltConfirmation("surface");
  const seatParagraph = halt.haltSeatParagraph({ halted: true, row: row(AT_SURFACE) })!;
  const description = haltTool.default.description ?? "";
  const { renderSeatPersona } = await import("../agent/instructions/seat-prompt.js");
  const persona = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } }).replace(/\s+/g, " ");
  const SAYS_READS_WORK: readonly (readonly [string, string, RegExp])[] = [
    ["the room's confirmation", confirmation, /I can still read, reply/],
    ["the seat paragraph", seatParagraph, /\*\*Reading and replying still work/],
    ["the tool description", description, /It does NOT stop reading/],
    ["the seat persona", persona, /reading, replying and handing a read to a worker still work/],
  ];
  for (const [label, text, saysReadsWork] of SAYS_READS_WORK) {
    ok(!/no connector calls/.test(text), `🔴 §11c ${label} does not claim connector calls stopped — the false clause behind the step-31 refusal`);
    ok(!/no fetching from the internet/.test(text), `🔴 §11c ${label} does not claim the internet stopped — it names the sandbox and the two withdrawn verbs instead`);
    ok(!/no outbound (fetch|network)/.test(text), `🔴 §11c ${label} claims no ABSOLUTE network stop — OE's own first-party transports contradict one, and a seat that believes it declines a read`);
    ok(!/do not look for another way round it/.test(text), `🔴 §11c ${label} does not forbid another route — delegating a READ is a legitimate route, and that sentence is what stopped one`);
    ok(saysReadsWork.test(text), `🔴 §11c ${label} says in its own words that READING still works`);
  }
  ok(/connected integration/.test(description), "🔴 §11c the tool description names the connector wall — a read it does refuse");
  ok(/connected integration/.test(seatParagraph) && /image from a URL/.test(seatParagraph), "🔴 §11c the seat paragraph names BOTH reads the pause reaches, so neither refusal surprises the seat");
  ok(/connected integration/.test(persona), "🔴 §11c and the persona names the connector wall too");
  ok(/handing a read to a\nworker|handing a read to a worker/.test(seatParagraph.replace(/\s+/g, " ")) || /delegating one/.test(seatParagraph), "🔴 §11c the seat is told that DELEGATING a read is not a way round the pause — the act it declined at step 31");
  ok(/memory/.test(seatParagraph) && /file into THIS conversation/.test(seatParagraph), "🔴 §11c …and that a same-room file post and a memory write are not paused (OPE-1758 item 3)");

  ok(/ in this conversation/.test(seatParagraph), "🔴 §11d a surface halt tells the seat the pause is IN THIS CONVERSATION");
  ok(/ everywhere in this deployment/.test(halt.haltSeatParagraph({ halted: true, row: row(ORG_WIDE) })!), "🔴 §11d an ORG-WIDE halt says so — the pair is what makes each a measurement");
  ok(!seatParagraph.includes(SURFACE), "🔴 §11d NEGATIVE CONTROL: and the paragraph still carries NO scope key — host-authored, ids and names never");

  const AT_WORKSPACE: HaltAddress = { orgWide: false, level: "workspace", scopeKey: WORKSPACE };
  const bothOrders = [
    [row(AT_SURFACE), row(AT_WORKSPACE)],
    [row(AT_WORKSPACE), row(AT_SURFACE)],
  ];
  for (const rows of bothOrders) {
    const covering = halt.haltCovering(rows, FULL_SCOPE)!;
    const clause = halt.haltSeatParagraph({ halted: true, row: covering })!;
    ok(/ at least (in this conversation|across this workspace)/.test(clause), "🔴 §11d with two covering rows the width is HEDGED, so it cannot under-report the wider pause whichever row the store returned first");
  }
  ok(!/at least/.test(halt.haltSeatParagraph({ halted: true, row: row(ORG_WIDE) })!), "🔴 §11d NEGATIVE CONTROL: an org-wide halt is NOT hedged — nothing is wider for it to under-report");
  ok(halt.haltSeatParagraph({ halted: true, unreadable: "store down" })!.startsWith("**Consequential work is paused right now.**"), "🔴 §11d an UNREADABLE halt names no width at all, because none is known");
  ok(halt.haltSeatParagraph(halt.NOT_HALTED) === null, "§11d NEGATIVE CONTROL: no halt, no paragraph");

  ok(description.includes("A REQUEST TO STOP ONE PIECE OF WORK IS NOT THIS VERB"), "🔴 §11b the description separates a task-scoped stop from the brake");
  ok(description.includes("`task_cancel`"), "🔴 §11b …and names the verb a NAMED piece of work routes to");
  ok(description.includes("`stand_down`"), "🔴 §11b …and the verb 'go quiet' routes to");
  ok(
    !description.includes("the moment someone in the conversation asks you to stop"),
    "🔴 §11b NEGATIVE CONTROL: the sentence that INVITED the escalation is gone — a bare 'stop' no longer points at the brake",
  );
  ok(!/no outbound (fetch|network)/.test(description), "🔴 §11b …and the description claims no absolute network stop, which OE's own first-party transports contradict");

  const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
  ok(TOOL_CONSEQUENCE["halt"]?.tier === "open", "🔴 §11 `halt` is `open` — a card needs an approver present, which during an incident is exactly what is not guaranteed");
  ok(TOOL_CONSEQUENCE["resume"]?.tier === "gate:admin", "🔴 §11 `resume` is `gate:admin` — it WIDENS, and widening is carded");

  const { haltAddressFromParts } = halt;
  assert.throws(() => haltAddressFromParts({ orgWide: true, level: "surface", scopeKey: SURFACE }), /never both/);
  passed++;
  assert.throws(() => haltAddressFromParts({}), /never neither/);
  passed++;
  ok(haltAddressFromParts({ orgWide: true }).orgWide === true, "§11 one address in, one address out");
  ok(JSON.stringify(halt.haltAddressFields(ORG_WIDE)) === JSON.stringify({ orgWide: true }), "§11 the audit fields are ids and names only");

  const { CONTROL_WRITE_TOOL_NAMES } = await import("../agent/control/writes.js");
  ok(CONTROL_WRITE_TOOL_NAMES.includes("halt" as never) && CONTROL_WRITE_TOOL_NAMES.includes("resume" as never), "§11 both control-MCP verbs are registered — the second door that works when the chat door does not");
}

{
  const { announceHalt, haltConfirmation } = await import("../agent/tools/halt.js");
  const { REPLY_DEDUPE_SKIPPED_ID } = await import("../agent/channels/reply-post.js");
  const TARGET = { platform: "slack", channelId: "C1" } as never;
  const posted: string[] = [];
  const record = async (_t: unknown, text: string): Promise<string> => {
    posted.push(text);
    return "1757-0001";
  };

  ok(await announceHalt({} as never, "surface", { resolveTarget: () => TARGET, post: record }), "§12 a halt ANNOUNCES itself through the reply path");
  ok(posted.length === 1, "§12 …exactly once");
  ok(posted[0] === haltConfirmation("surface"), "🔴 §12 …and the bytes are the host's own confirmation, never a paraphrase the turn chose");

  posted.length = 0;
  ok(
    (await announceHalt({} as never, "surface", { resolveTarget: () => null, post: record })) === false,
    "🔴 §12 NEGATIVE CONTROL: a surface with no resolvable reply target is NOT announced",
  );
  ok(posted.length === 0, "§12 …and nothing was posted");
  ok(
    (await announceHalt({} as never, "org", {
      resolveTarget: () => TARGET,
      post: async () => {
        throw new Error("slack is down");
      },
    })) === false,
    "🔴 §12 NEGATIVE CONTROL: a throwing transport is NOT announced — and does not throw out of the brake",
  );
  ok(
    (await announceHalt({} as never, "org", { resolveTarget: () => TARGET, post: async () => REPLY_DEDUPE_SKIPPED_ID })) === false,
    "🔴 §12 NEGATIVE CONTROL: a DEDUPED post is not a delivered one — the sentinel is an id, so 'it did not throw' would record a delivery the room never got (defensive: see §12b on why this path cannot produce one today)",
  );

  const { haltModelMessage } = await import("../agent/tools/halt.js");
  ok(
    haltModelMessage(false, "surface").includes(haltConfirmation("surface")),
    "🔴 §12a a halt the room was NOT told about hands the model the confirmation VERBATIM to say itself",
  );
  ok(!haltModelMessage(true, "surface").includes(haltConfirmation("surface")), "🔴 §12a NEGATIVE CONTROL: an ANNOUNCED halt does not hand it back — a repeat is noise the host already posted");
  ok(/[Dd]o not repeat/.test(haltModelMessage(true, "org")), "§12a …and says so plainly");

  const haltToolSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools", "halt.ts"), "utf8");
  const execute = haltToolSource.slice(haltToolSource.indexOf("async execute("));
  ok(execute.includes("announceHalt("), "§12b STRUCTURAL: the tool's execute calls the announcement — the room is told by the host, not by the turn");
  ok(execute.includes("announced,"), "§12b STRUCTURAL: …and the `admin.halt.set` row carries `announced`, so a brake nobody heard leaves a row");
  ok(execute.includes("const wakeId = currentWakeId(ctx)"), "§12b the halt audit join reads the host-owned wake id");
  ok(execute.includes("const sessionId = currentSessionId(ctx)"), "§12b …and the host-owned session id");
  ok(execute.includes("...(wakeId ? { wakeId } : {})"), "§12b …and records a non-empty wake join without inventing one");
  ok(execute.includes("...(sessionId ? { sessionId } : {})"), "§12b …and records a non-empty session join without inventing one");
  ok(execute.includes("setAt,"), "§12b …and records the exact store set timestamp for cleanup correlation");
  ok(execute.includes("setRef: wakeId"), "§12b …while the stored row owns the host wake, rather than only the human actor");
  ok(execute.includes("haltModelMessage(announced, scope)"), "§12b STRUCTURAL: …and the tool hands the model the arm §12a measured, rather than a second copy of the sentence");

}

await closeAllTestPg();
console.log(`✓ halt — ${passed} assertions (row shape on BOTH adapters, the four-axis union, fail-closed reads, the chain arrow + its one exemption, both routine legs, the grant broker, both egress planes, the connector wall, the absence seam, the announcement, and the two doors)`);
