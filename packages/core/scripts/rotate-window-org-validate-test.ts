import assert from "node:assert/strict";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { saltSupervisorGeneration, formatWindowToken, parseWindowToken } from "../agent/channels/window-key.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import {
  assertTokenRoundTrips,
  checkOrgAllowed,
  checkWindowTargetResumable,
  orgHasAnySeat,
  WindowTargetRefused,
  parseRotateArgs,
  rotateUnifiedWindow,
} from "./e2e/rotate-window-lib.js";
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
  {
    const r = parseRotateArgs(["e2e-solo", "--window", "slack/T1/C9"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.force === false, "--force defaults to false in the domain branch");
  }
  {
    const r = parseRotateArgs(["e2e-solo", "--force", "--window", "slack/T1/C9"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.force === true && r.target.windowId === "slack/T1/C9", "--force parses in the domain branch and leaves --window alone");
  }
  {
    const r = parseRotateArgs(["e2e-solo", "myorg", "--force"], {});
    ok(r.ok && r.target.kind === "domain" && r.target.org === "myorg" && r.target.domain === "e2e-solo", "🔴 --force does NOT shift the domain branch's positional org — the OPE-827 asymmetry is not reintroduced");
  }
  {
    const r = parseRotateArgs(["--dm", "slack/T1/D1", "--force", "myorg"], {});
    ok(r.ok && r.target.kind === "dm" && r.target.force === true && r.target.org === "myorg", "--force parses in the --dm branch and does not shift ITS positional org either");
  }
}

{
  await store.rotateChannelSession("second-known-org", "oe-domain::slack/T2/C2", mintToken("slack/T2/C2", 1), AT);
  eq(await orgHasAnySeat(store, "second-known-org"), true, "the second seeded org is known");
  eq(await orgHasAnySeat(store, "oe-dom"), false, "…and its existence does not make an UNRELATED unknown org known — org is a real partition, not a global flag");
}

{
  const GUARD_ORG = "guard-org";
  const SOLO_DOMAIN = "e2e-solo";
  const SOLO_SURFACE = "slack/T0EXAMPLE/C0EXCHAN003";
  const SOLO_KEY = unifiedDomainSessionKey(SOLO_SURFACE);
  const liveSoloToken = saltSupervisorGeneration(formatWindowToken({ domain: SOLO_DOMAIN, windowId: SOLO_SURFACE, generation: 3 }));
  await store.rotateChannelSession(GUARD_ORG, SOLO_KEY, liveSoloToken, AT);

  const threw = async (fn: () => Promise<unknown>): Promise<{ message: string; refusal: boolean } | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e), refusal: e instanceof WindowTargetRefused };
    }
  };

  {
    const verdict = checkWindowTargetResumable("slack", SOLO_SURFACE, await store.getChannelSession(GUARD_ORG, SOLO_KEY));
    eq(verdict.ok, false, "🔴 THE FIX: a <domain>/--window pair that disagrees with the row's live token is REFUSED (ok is exactly false, not merely falsy)");
    if (!verdict.ok) {
      ok(verdict.error.includes(SOLO_DOMAIN), "…the refusal names the domain the live token actually addresses");
      ok(verdict.error.includes(`rotate-window.ts ${SOLO_DOMAIN} --window ${SOLO_SURFACE}`), "…and prints the invocation the row's own token says is right");
      ok(verdict.error.includes("--force"), "…and names the override");
    }

    const msg = await threw(() => rotateUnifiedWindow(store, GUARD_ORG, "slack", SOLO_SURFACE));
    ok(msg !== null && msg.message.includes("refusing to rotate"), "🔴 rotateUnifiedWindow THROWS the refusal rather than writing — the end-to-end teeth");
    eq(msg?.refusal, true, "…and throws it as WindowTargetRefused, which is what lets the CLI print a refusal with no stack trace");
    const after = await store.getChannelSession(GUARD_ORG, SOLO_KEY);
    eq(after?.token, liveSoloToken, "🔴 NEGATIVE CONTROL: the row still holds the LIVE token — the refused rotation wrote nothing");
    eq(after?.generation, 1, "…and the row's generation counter did not advance either");
  }

  {
    const r = await rotateUnifiedWindow(store, GUARD_ORG, SOLO_DOMAIN, SOLO_SURFACE);
    eq(r.registryKey, SOLO_KEY, "the correct solo invocation keys the SAME registry row the live path reads");
    ok(r.newRow.token !== liveSoloToken, "…and mints a token the row did not hold before (a never-seen token is what opens a fresh eve session)");
    const back = parseWindowToken(r.newRow.token);
    eq(back?.domain, SOLO_DOMAIN, "…the written token parses back to the domain it was minted for");
    eq(back?.windowId, SOLO_SURFACE, "…and to the windowId it was minted for");
    eq(back?.generation, r.mintedGeneration, "…and to the generation the tool reported");
    const again = checkWindowTargetResumable(SOLO_DOMAIN, SOLO_SURFACE, await store.getChannelSession(GUARD_ORG, SOLO_KEY));
    eq(again.ok, true, "…and a second identical rotation is still allowed (the guard is stable under its own mint)");
  }

  {
    const UNIFIED_DOMAIN = "e2e-unified";
    const NEVER_MINTED = "slack/T0EXAMPLE/C0EXRANDM";
    await store.rotateChannelSession(GUARD_ORG, unifiedDomainSessionKey(UNIFIED_DOMAIN), saltSupervisorGeneration(formatWindowToken({ domain: UNIFIED_DOMAIN, windowId: UNIFIED_DOMAIN, generation: 9 })), AT);

    const verdict = checkWindowTargetResumable(UNIFIED_DOMAIN, NEVER_MINTED, null);
    eq(verdict.ok, false, "🔴 --window against a window the live path has NEVER minted is refused (ok exactly false)");
    if (!verdict.ok) {
      ok(verdict.error.includes(`rotate-window.ts ${UNIFIED_DOMAIN}`), "…and points at the domain's own degenerate window, which is what a \"unified\" domain actually has");
    }
    const msg = await threw(() => rotateUnifiedWindow(store, GUARD_ORG, UNIFIED_DOMAIN, NEVER_MINTED));
    eq(msg?.refusal, true, "…rotateUnifiedWindow throws it too, as a refusal");
    eq(await store.getChannelSession(GUARD_ORG, unifiedDomainSessionKey(NEVER_MINTED)), null, "🔴 NEGATIVE CONTROL: no phantom row was created — the residue class stays closed");
  }

  {
    const before = await store.getChannelSession(GUARD_ORG, SOLO_KEY);
    const r = await rotateUnifiedWindow(store, GUARD_ORG, "slack", SOLO_SURFACE, { force: true });
    ok(r.newRow.token !== before?.token, "--force mints the mismatching pair anyway (the domain-rename escape hatch)");
    eq(parseWindowToken(r.newRow.token)?.domain, "slack", "…and writes exactly the domain the operator asked for");
  }

  {
    const FRESH = "domain-never-seen";
    const r = await rotateUnifiedWindow(store, GUARD_ORG, FRESH);
    eq(r.registryKey, unifiedDomainSessionKey(FRESH), "a degenerate rotate on a domain with NO row is still allowed — this tool's original behaviour");
    eq(parseWindowToken(r.newRow.token)?.windowId, FRESH, "…and mints the degenerate id-equals-domain token");
    const second = await rotateUnifiedWindow(store, GUARD_ORG, FRESH);
    ok(second.newRow.token !== r.newRow.token, "…and a repeat degenerate rotate on the row it just wrote is allowed too");
  }

  {
    const good = formatWindowToken({ domain: SOLO_DOMAIN, windowId: SOLO_SURFACE, generation: 7 });
    assertTokenRoundTrips(good, SOLO_DOMAIN, SOLO_SURFACE, 7);
    passed++;

    const salted = saltSupervisorGeneration(good);
    assertTokenRoundTrips(salted, SOLO_DOMAIN, SOLO_SURFACE, 7);
    passed++;

    const misparsing = "p:win:q";
    const bad = formatWindowToken({ domain: misparsing, windowId: misparsing, generation: 4 });
    let caught: string | null = null;
    try {
      assertTokenRoundTrips(bad, misparsing, misparsing, 4);
    } catch (e) {
      caught = e instanceof Error ? e.message : String(e);
    }
    ok(caught !== null && caught.includes("does not round-trip"), "🔴 a token that parses back to a DIFFERENT (domain, window) pair is refused, not written");

    const msg = await threw(() => rotateUnifiedWindow(store, GUARD_ORG, misparsing));
    ok(msg !== null && msg.message.includes("does not round-trip"), "…and rotateUnifiedWindow refuses it before the store write");
    eq(msg?.refusal, false, "🔴 NEGATIVE CONTROL: an unaddressable mint is NOT a WindowTargetRefused — it is a defect, so the CLI keeps its stack");
    eq(await store.getChannelSession(GUARD_ORG, unifiedDomainSessionKey(misparsing)), null, "🔴 NEGATIVE CONTROL: the unaddressable mint left no row behind");
  }
}

assert.ok(passed > 0, "at least one assertion ran");
console.log(`✓ rotate-window-org-validate: ${passed} assertions passed (unknown org refused, known org allowed, --new-org escape hatch works, --dm/--org grammar pinned including the exact positional asymmetry, OPE-854 resumability guard refuses an unresumable target and writes nothing)`);
await closeAllTestPg();
