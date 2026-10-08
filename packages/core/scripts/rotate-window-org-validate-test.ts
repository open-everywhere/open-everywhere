import assert from "node:assert/strict";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { saltSupervisorGeneration, formatWindowToken, parseWindowToken } from "../agent/channels/window-key.js";
import { unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { defineDomain } from "../agent/memory/domain.js";
import {
  assertTokenRoundTrips,
  checkOrgAllowed,
  checkWindowTargetResumable,
  checkWindowTargetAgainstConfig,
  orgHasAnySeat,
  WindowTargetRefused,
  parseRotateArgs,
  rotateUnifiedWindow,
  awaitGenerationIdle,
  generationNotIdleMessage,
  DEFAULT_WAIT_IDLE_SECONDS,
} from "./e2e/rotate-window-lib.js";
import { openTestPg, closeAllTestPg } from "./test-pg-driver.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("rotate-window-org-validate");

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

{
  const CFG_ORG = "config-guard-org";
  const REAL_DOMAIN = "e2e-config-guard-real";
  const REAL_SURFACE = "slack/TCFGGRD1/CCFGGRD01";
  const CORRECT_SURFACE = "slack/TCFGGRD1/CCFGGRD03";
  const OTHER_DOMAIN = "e2e-config-guard-other";
  const OTHER_SURFACE = "slack/TCFGGRD1/CCFGGRD02";
  const FAKE_DOMAIN = "slack";
  const domains = [
    defineDomain({ name: REAL_DOMAIN, reach: [REAL_SURFACE, CORRECT_SURFACE], ambientSupervisor: true, mode: "solo" }),
    defineDomain({ name: OTHER_DOMAIN, reach: [OTHER_SURFACE], ambientSupervisor: true, mode: "solo" }),
  ];

  const threw = async (fn: () => Promise<unknown>): Promise<{ message: string; refusal: boolean } | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e), refusal: e instanceof WindowTargetRefused };
    }
  };

  {
    const fakeKey = unifiedDomainSessionKey(REAL_SURFACE);
    const firstFakeToken = saltSupervisorGeneration(formatWindowToken({ domain: FAKE_DOMAIN, windowId: REAL_SURFACE, generation: 1 }));
    await store.rotateChannelSession(CFG_ORG, fakeKey, firstFakeToken, AT);
    const rowAfterFirstFakeMint = await store.getChannelSession(CFG_ORG, fakeKey);

    const rowOnlyVerdict = checkWindowTargetResumable(FAKE_DOMAIN, REAL_SURFACE, rowAfterFirstFakeMint);
    eq(rowOnlyVerdict.ok, true, "🔴 THE RESIDUAL: the row-only guard passes a SECOND self-consistent mint under a domain that was never real — the witness is the last mint, not the truth");

    const r = await rotateUnifiedWindow(store, CFG_ORG, FAKE_DOMAIN, REAL_SURFACE);
    ok(r.newRow.token !== firstFakeToken, "…and, undefended, rotateUnifiedWindow actually WRITES the second self-consistently-wrong mint");
  }

  {
    const verdict = checkWindowTargetAgainstConfig(FAKE_DOMAIN, REAL_SURFACE, domains);
    eq(verdict.ok, false, "🔴 THE FIX: checkWindowTargetAgainstConfig refuses a domain name the roster never declared (ok is exactly false)");
    if (!verdict.ok) {
      ok(verdict.error.includes(FAKE_DOMAIN), "…the refusal names the offending domain");
      ok(verdict.error.includes("agent/memory/config/domains.ts"), "…and points at the config file that is the source of truth");
      ok(verdict.error.includes("--force"), "…and names the override");
    }

    const msg = await threw(() => rotateUnifiedWindow(store, CFG_ORG, FAKE_DOMAIN, REAL_SURFACE, { domains }));
    ok(msg !== null && msg.message.includes("refusing to rotate"), "…rotateUnifiedWindow (given `domains`) throws the config refusal rather than writing");
    eq(msg?.refusal, true, "…as a WindowTargetRefused, so the CLI prints it with no stack trace");
  }

  {
    const liveToken = saltSupervisorGeneration(formatWindowToken({ domain: REAL_DOMAIN, windowId: CORRECT_SURFACE, generation: 1 }));
    await store.rotateChannelSession(CFG_ORG, unifiedDomainSessionKey(CORRECT_SURFACE), liveToken, AT);

    const r = await rotateUnifiedWindow(store, CFG_ORG, REAL_DOMAIN, CORRECT_SURFACE, { domains });
    const back = parseWindowToken(r.newRow.token);
    eq(back?.domain, REAL_DOMAIN, "the correct invocation still mints — domain round-trips");
    eq(back?.windowId, CORRECT_SURFACE, "…and windowId round-trips");
    ok(r.newRow.token !== liveToken, "…and it is a genuinely FRESH mint, not the seeded row read back unchanged");
  }

  {
    const verdict = checkWindowTargetAgainstConfig(REAL_DOMAIN, OTHER_SURFACE, domains);
    eq(verdict.ok, false, "a real domain requesting ANOTHER real domain's channel is still refused");
    if (!verdict.ok) {
      ok(verdict.error.includes(`rotate-window.ts ${OTHER_DOMAIN} --window ${OTHER_SURFACE}`), "🔴 the refusal prints the CORRECT invocation config actually assigns this channel to");
    }
  }

  {
    const verdict = checkWindowTargetAgainstConfig(REAL_DOMAIN, "slack/TCFGGRD1/CUNCLAIMED", domains);
    eq(verdict.ok, false, "an unclaimed surfaceKey is refused when no criteria domain would seat it");
    if (!verdict.ok) ok(verdict.error.includes("no domain"), "…and says so, rather than naming a wrong owner");
  }

  {
    const ORG_DOMAIN = "e2e-config-guard-org";
    const UNCLAIMED = "slack/TCFGGRD1/CUNCLAIMED";
    const seatedDomains = [...domains, defineDomain({ name: ORG_DOMAIN, match: "org", reach: [], ambientSupervisor: true, mode: "solo" })];
    eq(
      checkWindowTargetAgainstConfig(ORG_DOMAIN, UNCLAIMED, seatedDomains).ok,
      true,
      "🔴 THE FIX: a room no domain claims, targeted at the `org` criteria domain the live path seats it on, is ACCEPTED",
    );
    const wrongDomain = checkWindowTargetAgainstConfig(REAL_DOMAIN, UNCLAIMED, seatedDomains);
    eq(wrongDomain.ok, false, "NEGATIVE CONTROL: the same unclaimed room targeted at ANOTHER domain is still refused");
    if (!wrongDomain.ok) {
      ok(wrongDomain.error.includes(ORG_DOMAIN), "…and the refusal names the domain the live path actually seats it on");
      ok(wrongDomain.error.includes(`rotate-window.ts ${ORG_DOMAIN} --window ${UNCLAIMED}`), "…and prints the invocation that would work");
    }
    eq(checkWindowTargetAgainstConfig(REAL_DOMAIN, REAL_SURFACE, seatedDomains).ok, true, "a room its own domain CLAIMS is still accepted under that domain");
    eq(checkWindowTargetAgainstConfig(ORG_DOMAIN, REAL_SURFACE, seatedDomains).ok, false, "…and the org domain may NOT rotate a room another domain claims — the explicit roster wins");
  }

  {
    const dmDomain = "oe-dm/slack/TCFGGRD1/DCFGDM01";
    const verdict = checkWindowTargetAgainstConfig(dmDomain, undefined, domains);
    eq(verdict.ok, true, "a DM pseudo-domain is skipped by the config guard, not refused for being absent from the roster");
  }

  {
    const GROUPED_DOMAIN = "e2e-config-guard-grouped";
    const GRP_A = "slack/TCFGGRD1/CCFGGRD04";
    const GRP_B = "slack/TCFGGRD1/CCFGGRD05";
    const groupedDomains = [
      ...domains,
      defineDomain({ name: GROUPED_DOMAIN, reach: [GRP_A, GRP_B], ambientSupervisor: true, windows: [{ name: "guard-pair", reach: [GRP_A, GRP_B] }] }),
    ];
    eq(checkWindowTargetAgainstConfig(GROUPED_DOMAIN, "guard-pair", groupedDomains).ok, true, "a declared window GROUP name is an accepted --window target");
    const unknown = checkWindowTargetAgainstConfig(GROUPED_DOMAIN, "no-such-group", groupedDomains);
    eq(unknown.ok, false, "an UNDECLARED group name is still refused");
    if (!unknown.ok) ok(unknown.error.includes("window group declared"), "…and the refusal says a group name is one of the two things it accepts");
    eq(checkWindowTargetAgainstConfig(REAL_DOMAIN, "guard-pair", groupedDomains).ok, false, "another domain may not rotate a group it does not declare");
    eq(checkWindowTargetAgainstConfig(GROUPED_DOMAIN, GRP_A, groupedDomains).ok, true, "a grouped domain's own channel is still an accepted target");
  }

  {
    const before = await store.getChannelSession(CFG_ORG, unifiedDomainSessionKey(REAL_SURFACE));
    const r = await rotateUnifiedWindow(store, CFG_ORG, FAKE_DOMAIN, REAL_SURFACE, { force: true, domains });
    ok(r.newRow.token !== before?.token, "--force mints the config-contradicting pair anyway");
  }
}

{
  const parsed = parseRotateArgs(["e2e-unified", "--wait-idle", "600"], {});
  ok(parsed.ok && parsed.target.kind === "domain" && parsed.target.waitIdleMs === 600_000, "§6: --wait-idle 600 parses to a 600 s wait");
  ok(parsed.ok && parsed.target.kind === "domain" && parsed.target.domain === "e2e-unified" && parsed.target.org === "default", "§6: …and shifts no positional");
  const none = parseRotateArgs(["e2e-unified"], {});
  ok(none.ok && none.target.waitIdleMs === DEFAULT_WAIT_IDLE_SECONDS * 1000 && DEFAULT_WAIT_IDLE_SECONDS === 600, "§6: no flag waits the 600 s default — a runner that passes nothing still never rotates under an owed job");
  const noneDm = parseRotateArgs(["--dm", "slack/T1/D1"], {});
  ok(noneDm.ok && noneDm.target.waitIdleMs === 600_000, "§6: …and so does the DM form");
  const zero = parseRotateArgs(["e2e-unified", "--wait-idle", "0"], {});
  ok(zero.ok && zero.target.waitIdleMs === undefined && !("waitIdleMs" in zero.target), "§6: --wait-idle 0 is the one spelling that rotates at once (no wait key at all)");
  ok(!parseRotateArgs(["e2e-unified", "--wait-idle", "ten"], {}).ok, "§6: a non-number is refused");
  ok(!parseRotateArgs(["e2e-unified", "--wait-idle"], {}).ok, "§6: a missing value is refused");
  const dm = parseRotateArgs(["--dm", "slack/T1/D1", "--wait-idle", "30"], {});
  ok(dm.ok && dm.target.kind === "dm" && dm.target.waitIdleMs === 30_000, "§6: the DM form takes the flag too");

  const TOKEN = "oe-dom:e2e-unified:oe-sup:g42";
  const KEY = unifiedDomainSessionKey("e2e-unified");
  let owed: string[] = ["work:req-a", "agent-t1"];
  const fake = {
    getChannelSession: async (_org: string, key: string) => (key === KEY ? ({ token: TOKEN } as never) : null),
    getTaskResult: async (_org: string, key: string) => (key === `oe-gen-owes:${TOKEN}` ? JSON.stringify({ tasks: owed }) : null),
  };
  const { generationOwedTaskIds } = await import("../agent/channels/generation-retirement.js");
  const shapeOk = (await generationOwedTaskIds("default", TOKEN, fake)).length === 2;
  ok(shapeOk, `§6/FIXTURE: the fake ledger row reads back through the product's reader (got ${JSON.stringify(await generationOwedTaskIds("default", TOKEN, fake))})`);

  let clock = 0;
  const timing = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, pollMs: 5_000 };
  const stuck = await awaitGenerationIdle(fake, "default", KEY, { timeoutMs: 20_000, ...timing });
  ok(!stuck.ok && stuck.owed.length === 2 && stuck.waitedMs >= 20_000, `🔴 §6: a generation that still owes a job is NOT idle at the deadline (got ${JSON.stringify(stuck)})`);
  ok(!stuck.ok && generationNotIdleMessage(KEY, stuck).startsWith(`refusing to rotate ${KEY}: the live generation ${TOKEN} still owes 2 job(s)`), "§6: …and the refusal names the key, the token and the count");

  clock = 0;
  let polls = 0;
  const settling = { ...fake, getTaskResult: async (org: string, key: string) => { polls++; if (polls >= 3) owed = []; return fake.getTaskResult(org, key); } };
  const settled = await awaitGenerationIdle(settling, "default", KEY, { timeoutMs: 60_000, ...timing });
  ok(settled.ok && settled.waitedMs === 10_000, `🔴 §6: the wait returns once the ledger empties — after two polls, never at the deadline (got ${JSON.stringify(settled)})`);
  const noRow = await awaitGenerationIdle(fake, "default", "oe-domain::no-such", { timeoutMs: 1, ...timing });
  ok(noRow.ok, "§6: a key with no row owes nothing");
}

assert.ok(passed > 0, "at least one assertion ran");
console.log(
  `✓ rotate-window-org-validate: ${passed} assertions passed (unknown org refused, known org allowed, --new-org escape hatch works, --dm/--org grammar pinned including the exact positional asymmetry, OPE-854 resumability guard refuses an unresumable target and writes nothing, OPE-859 config guard closes the row-only guard's residual and writes nothing either)`,
);
await closeAllTestPg();
