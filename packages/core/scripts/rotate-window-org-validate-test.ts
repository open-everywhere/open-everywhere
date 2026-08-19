import assert from "node:assert/strict";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { saltSupervisorGeneration, formatWindowToken } from "../agent/channels/window-key.js";
import { checkOrgAllowed, orgHasAnySeat, parseRotateArgs } from "./e2e/rotate-window-lib.js";
import { openTestPg, closeAllTestPg } from "./test-pg-driver.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  if (a !== b) {
    console.error(`✗ ${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
    process.exit(1);
  }
  passed++;
}

const pg = await openTestPg();
const client: PgClient = pg.client;
await initOperationalSchema(client);
const store = makeOperationalPostgresStore(client);

const KNOWN_ORG = "default";
const AT = "2026-08-19T00:00:00.000Z";
const mintToken = (domain: string, generation: number): string =>
  saltSupervisorGeneration(formatWindowToken({ domain, windowId: domain, generation }));

await store.rotateChannelSession(KNOWN_ORG, "oe-domain::slack/T1/C1", mintToken("slack/T1/C1", 1), AT);

{
  eq(await orgHasAnySeat(store, KNOWN_ORG), true, "a seeded org reports as having a seat");
  eq(await orgHasAnySeat(store, "oe-dom"), false, "🔴 an org with NO rows — the exact OPE-827 typo — reports as having none");
  eq(await orgHasAnySeat(store, "typo-org-nobody-created"), false, "an arbitrary unseen org string also reports false");
}

{
  const knownResult = await checkOrgAllowed(store, KNOWN_ORG, false);
  ok(knownResult.ok, "a KNOWN org is allowed without --new-org");

  const unknownResult = await checkOrgAllowed(store, "oe-dom", false);
  ok(!unknownResult.ok, "🔴 THE FIX: an unrecognised org is REFUSED, not silently minted");
  if (!unknownResult.ok) {
    ok(unknownResult.error.includes("oe-dom"), "…and the refusal names the offending org");
    ok(unknownResult.error.includes("--new-org"), "…and tells the operator the escape hatch");
  }

  const escapeHatch = await checkOrgAllowed(store, "genuinely-new-org", true);
  ok(escapeHatch.ok, "--new-org (allowNewOrg=true) is the explicit override that still permits a first seat");

  eq(unknownResult.ok, false, "negative control: ok is exactly false for an unknown org, not merely falsy/absent");
}

{
  {
    const r = parseRotateArgs(["e2e-unified"], {});
    ok(r.ok, "domain-only positional parses");
    if (r.ok && r.target.kind === "domain") {
      eq(r.target.domain, "e2e-unified", "…domain from argv[0]");
      eq(r.target.org, "default", "…org falls back to \"default\" with no env override");
      eq(r.target.allowNewOrg, false, "…--new-org defaults to false");
    }
  }
  {
    const r = parseRotateArgs(["e2e-unified", "myorg"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.org === "myorg", "domain branch: bare positional[1] IS the org (pre-existing grammar, unchanged)");
  }
  {
    const r = parseRotateArgs(["e2e-unified"], { E2E_ORG: "env-org" });
    ok(r.ok && r.target.kind === "domain" && r.target.org === "env-org", "domain branch: E2E_ORG env fallback still applies when no positional/flag org given");
  }
  {
    const r = parseRotateArgs(["e2e-unified", "--window", "slack/T1/C9"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.windowId === "slack/T1/C9" && r.target.domain === "e2e-unified", "--window is stripped and the domain positional is unaffected");
  }
  {
    const r = parseRotateArgs(["e2e-unified", "posOrg", "--org", "flagOrg"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.org === "flagOrg", "🔴 --org is EXPLICIT and wins over a conflicting positional org — the unambiguous spelling");
  }
  {
    const r = parseRotateArgs([], {});
    ok(!r.ok, "no domain and no --dm is a usage error");
  }

  {
    const r = parseRotateArgs(["--dm", "slack/T1/D1"], {});
    ok(r.ok && r.target.kind === "dm" && r.target.dmSurfaceKey === "slack/T1/D1" && r.target.org === "default", "--dm alone: org falls back to default");
  }
  {
    const r = parseRotateArgs(["--dm", "slack/T1/D1", "myorg"], {});
    ok(r.ok && r.target.kind === "dm" && r.target.org === "myorg", "🔴 --dm branch: bare positional[0] (AFTER --dm's pair is stripped) IS the org — the asymmetry pinned as a fact, not fixed away, since the ticket keeps the positional form working");
  }
  {
    const r = parseRotateArgs(["--dm", "slack/T1/D1", "--org", "flagOrg"], {});
    ok(r.ok && r.target.kind === "dm" && r.target.org === "flagOrg", "🔴 THE FIX: --org means the SAME thing in the --dm branch as the plain branch — no need to know the positional asymmetry");
  }
  {
    const r = parseRotateArgs(["--dm"], {});
    ok(!r.ok, "--dm with no surface key is a usage error");
  }
  {
    const r = parseRotateArgs(["--dm", "C12345"], {});
    ok(!r.ok, "--dm with a bare channel id (no slashes) is refused — the OPE-344 defect stays fixed");
  }
  {
    const r = parseRotateArgs(["e2e-unified", "myorg", "--new-org"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.allowNewOrg === true, "--new-org parses to allowNewOrg=true in the domain branch");
  }
  {
    const r = parseRotateArgs(["--dm", "slack/T1/D1", "--new-org"], {});
    ok(r.ok && r.target.kind === "dm" && r.target.allowNewOrg === true, "--new-org parses to allowNewOrg=true in the --dm branch too");
  }
}

{
  await store.rotateChannelSession("second-known-org", "oe-domain::slack/T2/C2", mintToken("slack/T2/C2", 1), AT);
  eq(await orgHasAnySeat(store, "second-known-org"), true, "the second seeded org is known");
  eq(await orgHasAnySeat(store, "oe-dom"), false, "…and its existence does not make an UNRELATED unknown org known — org is a real partition, not a global flag");
}

assert.ok(passed > 0, "at least one assertion ran");
console.log(`✓ rotate-window-org-validate: ${passed} assertions passed (unknown org refused, known org allowed, --new-org escape hatch works, --dm/--org grammar pinned including the exact positional asymmetry)`);
await closeAllTestPg();
