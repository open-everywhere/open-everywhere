import assert from "node:assert/strict";
import {
  defineDomain,
  windowedSupervisorEnabled,
  windowedDomainFor,
  windowModeFor,
  windowIdFor,
  windowGroupFor,
  assertUnifiedDomainTrust,
  assertWindowGroupExclusivity,
  WINDOW_GROUP_NAME_RE,
} from "../agent/memory/domain.js";
import {
  unifiedSupervisorToken,
  unifiedSupervisorSentinel,
  isUnifiedSupervisorToken,
  unifiedDomainFromToken,
  unifiedWindowFromToken,
  unifiedGenerationFromToken,
  unifiedDomainSessionKey,
  domainFromSessionKey,
  supervisorGrainFor,
  supervisorTokenForGrain,
  mintRotationToken,
  grainUsesUnifiedWindow,
} from "../agent/channels/unified-supervisor.js";
import { classifySessionId } from "../agent/channels/window-key.js";
const githubSupervisorToken = (owner: string, repo: string, generation: number): string =>
  `github:${owner}/${repo}:oe-sup:g${generation}`;
const linearSupervisorToken = (teamId: string, generation: number): string =>
  `linear:${teamId}:oe-sup:g${generation}`;
import { isSupervisorSession } from "../agent/model/routing.js";
import { renderWakeEnvelope, type WakeEnvelopeInput } from "../agent/channels/wake-envelope.js";
import { renderWake, type NormalizedWake } from "../agent/channels/normalized-wake.js";
import {
  definePrincipal,
  resolvePrincipal,
  principalAccounts,
  principalKeys,
  principalLabel,
  principalSurfaces,
  surfaceIdsFromAccounts,
  assertPrincipalsValid,
} from "../agent/identity/principals.js";
import { unionPrincipals } from "../agent/identity/link-resolve.js";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const throws = (fn: () => unknown, label: string) => {
  assert.throws(fn, label);
  n++;
};
const noThrow = (fn: () => unknown, label: string) => {
  assert.doesNotThrow(fn, label);
  n++;
};
const eqJson = (actual: unknown, expected: string, label: string) => {
  assert.strictEqual(JSON.stringify(actual), expected, label);
  n++;
};

const withEnv = <T>(val: boolean | undefined, fn: () => T): T => {
  if (val === undefined) resetSettingsForTest();
  else overrideSettingsForTest({ window: { topology: val } });
  try {
    return fn();
  } finally {
    resetSettingsForTest();
  }
};

const CH = "slack/T1/C_PAY";
const GH = "github/acme/payments-api";
const payments = defineDomain({
  name: "payments",
  reach: [CH, GH],
  ambientSupervisor: true,
  mode: "unified",
});
const orgNoGate = defineDomain({ name: "org", match: "org" });

withEnv(undefined, () => {
  ok(windowedSupervisorEnabled(CH, [payments, orgNoGate]) === false, "gate OFF ⇒ not windowed (byte-identical per-container path)");
});
withEnv(false, () => ok(windowedSupervisorEnabled(CH, [payments, orgNoGate]) === false, "`window.topology: false` does not arm the gate"));
withEnv(true, () => {
  ok(windowedSupervisorEnabled(CH, [payments, orgNoGate]) === true, "gate ON + ambient explicit domain ⇒ windowed");
  ok(windowedSupervisorEnabled(GH, [payments, orgNoGate]) === true, "windowing applies to every channel in the domain");
  const noAmbient = defineDomain({ name: "x", reach: ["slack/T1/C_X"], mode: "unified" });
  ok(windowedSupervisorEnabled("slack/T1/C_X", [noAmbient, orgNoGate]) === true, "a domain WITHOUT ambientSupervisor still seats its channels — the flag decides wakes, never the session's shape");
  ok(windowedSupervisorEnabled("slack/T1/C_ORPHAN", [payments, orgNoGate]) === true, "an UNDECLARED channel seats too, inheriting the org pseudo-domain");
  ok(windowedSupervisorEnabled("slack/T1/C_ORPHAN", [payments]) === false, "…and with NO org pseudo-domain declared, an undeclared channel has no seat at all");
});
withEnv(true, () => ok(windowedSupervisorEnabled(CH, [payments, orgNoGate]) === true, "gate ON via a registered override"));

withEnv(true, () => {
  ok(windowedDomainFor(CH, [payments, orgNoGate])?.name === "payments", "windowedDomainFor returns the domain when windowed");
  ok(windowedDomainFor("slack/T1/C_ORPHAN", [payments, orgNoGate])?.name === "org", "windowedDomainFor answers the ORG pseudo-domain for an undeclared channel (OPE-1695) …");
  ok(windowedDomainFor("slack/T1/C_ORPHAN", [payments]) === undefined, "… and undefined when there is no seat domain to resolve at all");
});
withEnv(undefined, () => ok(windowedDomainFor(CH, [payments, orgNoGate]) === undefined, "windowedDomainFor undefined when the code gate is off"));

const paymentsSolo = defineDomain({
  name: "payments",
  reach: [CH, GH],
  ambientSupervisor: true,
  mode: "solo",
});
ok(windowModeFor(CH, [payments, orgNoGate]) === "unified", "windowModeFor reads a domain's explicit mode (unified)");
ok(windowModeFor(CH, [paymentsSolo, orgNoGate]) === "solo", "windowModeFor reads a domain's explicit mode (solo)");
const noMode = defineDomain({ name: "y", reach: ["slack/T1/C_Y"], ambientSupervisor: true });
ok(windowModeFor("slack/T1/C_Y", [noMode, orgNoGate]) === "solo", "a domain with NO mode defaults to solo (no third topology / no per-platform merge)");
ok(windowModeFor("slack/T1/C_ORPHAN", [payments, orgNoGate]) === "solo", "an unassigned channel resolves the harmless default solo (it cannot window anyway)");

noThrow(() => assertUnifiedDomainTrust([payments, orgNoGate]), "valid: explicit mode:unified domain + ambientSupervisor");
noThrow(() => assertUnifiedDomainTrust([paymentsSolo, orgNoGate]), "valid: explicit mode:solo domain + ambientSupervisor");
noThrow(() => assertUnifiedDomainTrust([defineDomain({ name: "plain", reach: ["slack/T/C"] })]), "valid: a domain with no mode is unaffected");
noThrow(
  () => assertUnifiedDomainTrust([defineDomain({ name: "u", reach: ["slack/T/C"], mode: "unified" })]),
  "mode WITHOUT ambientSupervisor is VALID — topology and chattiness are independent",
);
noThrow(
  () => assertUnifiedDomainTrust([defineDomain({ name: "s", reach: ["slack/T/C"], mode: "solo" })]),
  "mode:solo WITHOUT ambientSupervisor is valid too",
);
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", ambientSupervisor: true, mode: "unified" })]),
  "mode on the org pseudo-domain ⇒ fail loud (the 'window everything' footgun)",
);
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "public", match: "public", ambientSupervisor: true, mode: "unified" })]),
  "mode on the public pseudo-domain ⇒ fail loud (external surface)",
);
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "dm", match: "dm", ambientSupervisor: true, mode: "solo" })]),
  "mode on the dm pseudo-domain ⇒ fail loud (personal surface)",
);

const TOK = unifiedSupervisorToken("payments", 3);
ok(TOK === "oe-dom:payments:oe-sup:g3", "unified token shape oe-dom:<domain>:oe-sup:g<gen>");
ok(unifiedSupervisorSentinel(3) === "oe-sup:g3", "unified sentinel mirrors the per-container sentinel");
ok(isUnifiedSupervisorToken(TOK), "isUnifiedSupervisorToken true for a unified token");
ok(!isUnifiedSupervisorToken("C_PAY:oe-sup:g3"), "isUnifiedSupervisorToken false for a per-container token");
ok(!isUnifiedSupervisorToken("C_PAY:1720000000.001"), "isUnifiedSupervisorToken false for a thread token");
ok(unifiedDomainFromToken(TOK) === "payments", "domain parses back out of the token");
ok(unifiedGenerationFromToken(TOK) === 3, "generation parses back out of the token");
ok(unifiedDomainFromToken("C_PAY:oe-sup:g3") === undefined, "no domain from a per-container token");
const WEIRD = unifiedSupervisorToken("team:sub", 12);
ok(unifiedDomainFromToken(WEIRD) === "team:sub", "colon-bearing domain round-trips");
ok(unifiedGenerationFromToken(WEIRD) === 12, "generation still parses with a colon-bearing domain");

ok(unifiedWindowFromToken(TOK) === "payments", "windowId parses back out of the degenerate token (=== domain)");
ok(unifiedWindowFromToken("C_PAY:oe-sup:g3") === undefined, "no windowId from a per-container token");
ok(unifiedDomainSessionKey(unifiedWindowFromToken(TOK)!) === unifiedDomainSessionKey("payments"), "a degenerate token's window registry key is byte-identical to the domain key (windowId === domain in step 1)");
const EXPLICIT = "oe-dom:payments:win:chan-hr:oe-sup:g8";
ok(unifiedDomainFromToken(EXPLICIT) === "payments", "explicit-window token still yields the domain (memory/access anchor survives the key split)");
ok(unifiedWindowFromToken(EXPLICIT) === "chan-hr", "explicit-window token yields a windowId distinct from the domain");
ok(unifiedGenerationFromToken(EXPLICIT) === 8, "explicit-window token yields its generation");
ok(isUnifiedSupervisorToken(EXPLICIT), "isUnifiedSupervisorToken true for an explicit-window token too");

const KEY = unifiedDomainSessionKey("payments");
ok(KEY === "oe-domain::payments", "synthetic domain-session registry key shape");
ok(domainFromSessionKey(KEY) === "payments", "domain recovers from the synthetic key");
ok(domainFromSessionKey("slack/T1/C_PAY") === undefined, "a real surfaceKey is not a domain-session key");
ok(!KEY.includes("/"), "synthetic key never collides with a real platform/workspace/surface key");

ok(isSupervisorSession({ channel: { continuationToken: TOK } } as never), "unified token ⇒ isSupervisorSession true (supervisor model role resolves)");
ok(isSupervisorSession({ channel: { continuationToken: "C_PAY:oe-sup:g1" } } as never), "per-container token ⇒ isSupervisorSession true (unchanged)");
ok(!isSupervisorSession({ channel: { continuationToken: "C_PAY:1720000000.001" } } as never), "a thread token is not a supervisor session");
ok(TOK.includes(":oe-sup:g"), "unified token carries the :oe-sup:g infix the spend hook keys on");

withEnv(undefined, () => {
  const g = supervisorGrainFor(CH, [payments, orgNoGate]);
  ok(g.unified === false && g.registryKey === CH && g.domainName === undefined, "flag-off grain: per-container (registryKey === surfaceKey), byte-identical path");
});
withEnv(true, () => {
  const g = supervisorGrainFor(CH, [payments, orgNoGate]);
  ok(g.unified === true && g.registryKey === "oe-domain::payments" && g.domainName === "payments", "flag-on grain: domain-keyed registry row");
  const g2 = supervisorGrainFor(GH, [payments, orgNoGate]);
  ok(g2.unified === true && g2.registryKey === "oe-domain::payments", "a DIFFERENT surface in the same domain resolves the SAME registry row (one team, one session)");
  ok(g.registryKey === g2.registryKey, "slack + github in one domain share the unified registry key");
  const g3 = supervisorGrainFor("slack/T1/C_ORPHAN", [payments, orgNoGate]);
  ok(g3.unified === true && g3.domainName === "org", "an undeclared channel seats on the org pseudo-domain");
  ok(g3.windowId === "slack/T1/C_ORPHAN" && g3.singleWindow === undefined, "…SOLO: its window id is its own surface key, and it is not a cross-surface window");
  const g4 = supervisorGrainFor("slack/T1/C_OTHER", [payments, orgNoGate]);
  ok(g3.registryKey !== g4.registryKey, "…so two undeclared channels never share a registry row (the footgun the pseudo-domain refusals still guard)");
  const g5 = supervisorGrainFor("slack/T1/C_ORPHAN", [payments]);
  ok(g5.unified === false && g5.registryKey === "slack/T1/C_ORPHAN", "no org pseudo-domain ⇒ an undeclared channel stays per-container (fail-closed)");
});

withEnv(true, () => {
  const slackGrain = supervisorGrainFor(CH, [payments, orgNoGate]);
  const ghGrain = supervisorGrainFor(GH, [payments, orgNoGate]);
  const tok = unifiedSupervisorToken("payments", 4);
  ok(supervisorTokenForGrain(ghGrain, 4, () => githubSupervisorToken("acme", "payments-api", 4)) === tok, "unified github grain mints the DOMAIN token, not the per-repo one");
  ok(supervisorTokenForGrain(slackGrain, 4, () => "C_PAY:oe-sup:g4") === tok, "unified slack grain mints the SAME domain token — one team, one token per generation");
});
withEnv(undefined, () => {
  const off = supervisorGrainFor(GH, [payments, orgNoGate]);
  ok(supervisorTokenForGrain(off, 2, () => githubSupervisorToken("acme", "payments-api", 2)) === "github:acme/payments-api:oe-sup:g2", "flag-off github grain falls back to the per-repo token (byte-identical)");
  ok(supervisorTokenForGrain(off, 2, () => "linear:team-1:oe-sup:g2") === "linear:team-1:oe-sup:g2", "flag-off linear fallback is the per-team token");
  ok(supervisorTokenForGrain(off, 2, () => "notion:page-1:oe-sup:g2") === "notion:page-1:oe-sup:g2", "flag-off notion fallback is the per-doc token");
});

withEnv(true, () => {
  const g = supervisorGrainFor(CH, [payments, orgNoGate]);
  ok(JSON.stringify(g) === JSON.stringify({ unified: true, registryKey: "oe-domain::payments", domainName: "payments", singleWindow: true }), "mode:unified grain: cross-surface (singleWindow), domain-keyed registry, NO windowId field — byte-identical to the pre-collapse cross-surface grain");
  ok(grainUsesUnifiedWindow(g) === true, "a mode:unified grain USES the unified window (cross-surface divert fires)");
  ok(supervisorTokenForGrain(g, 4, () => "C_PAY:oe-sup:g4") === "oe-dom:payments:oe-sup:g4", "mode:unified supervisorTokenForGrain emits the DEGENERATE (domain-keyed) token verbatim");
});
withEnv(true, () => {
  const g = supervisorGrainFor(CH, [paymentsSolo, orgNoGate]);
  ok(g.unified === true && g.domainName === "payments", "solo grain stays domain-anchored (memory/access unchanged)");
  ok(g.windowId === CH, "solo grain carries windowId === surfaceKey (one window per channel)");
  ok(g.registryKey === `oe-domain::${CH}`, "solo grain keys its OWN registry row on the surfaceKey windowId");
  ok(g.singleWindow === undefined, "solo grain is NOT cross-surface (singleWindow absent)");
  ok(grainUsesUnifiedWindow(g) === true, "a solo grain DOES use the unified window (divert fires)");
  const tok = supervisorTokenForGrain(g, 7, () => supervisorTokenPerContainer());
  ok(tok === `oe-dom:payments:win:${CH}:oe-sup:g7`, "solo supervisorTokenForGrain emits the :win:<surfaceKey>: form");
  ok(unifiedDomainFromToken(tok) === "payments", "the solo token still yields the DOMAIN (memory/access anchor survives)");
  ok(unifiedWindowFromToken(tok) === CH, "the solo token yields the surfaceKey windowId");
  ok(isUnifiedSupervisorToken(tok), "the solo token is recognised as a window supervisor token");
  const g2 = supervisorGrainFor(GH, [paymentsSolo, orgNoGate]);
  ok(g2.windowId === GH && g2.registryKey === `oe-domain::${GH}` && g2.registryKey !== g.registryKey, "each channel gets its OWN solo window + row (unlike cross-surface's shared row)");
});
function supervisorTokenPerContainer(): string {
  throw new Error("perContainer must not be called on a windowed grain");
}

const baseInput: WakeEnvelopeInput = {
  reason: "channel-activity",
  currentTime: "2026-03-15T09:30:00.000Z",
  channel: { id: "C_PAY", type: "channel", memberCount: 5 },
  messages: [{ from: "human", author: "Sarah", id: "1.1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer", trigger: true, body: "hello" }],
};
const noPlatform = renderWakeEnvelope(baseInput);
ok(noPlatform.includes('<channel id="C_PAY" type="channel" member-count="5">'), "the <channel> element carries its opaque id, type and member-count");
ok(!noPlatform.includes("platform="), "no platform attribute — no input can produce one");
ok(!noPlatform.includes(" label="), "no label attribute — no input can produce one");
{
  const full = renderWakeEnvelope({ ...baseInput, channel: { ...baseInput.channel, container: "channel" } });
  const open = /<channel([^>]*)>/u.exec(full)?.[1] ?? "";
  const attrs = [...open.matchAll(/\s([a-z-]+)=/gu)].map((m) => m[1]).sort();
  assert.deepEqual(attrs, ["container", "id", "member-count", "type"], "🔴 the <channel> element emits EXACTLY id/type/container/member-count — every one of them surface-neutral");
  n++;
}

const rowan = definePrincipal({ name: "Rowan Hale", handle: "rowan", ids: { slack: "U0EXOWNER", github: "example-owner" }, email: "t@example.com" });
const sarah = definePrincipal({ name: "Sarah Kim", ids: { slack: "U_SARAH", linear: "lin-uuid-1" } });
const roster = [rowan, sarah];
ok(resolvePrincipal("slack", "T_ONE", "U0EXOWNER", roster) === rowan, "resolve by slack id");
ok(resolvePrincipal("github", undefined, "example-owner", roster) === rowan, "same human resolves across surfaces");
ok(resolvePrincipal("linear", undefined, "lin-uuid-1", roster) === sarah, "resolve sarah by linear id");
ok(resolvePrincipal("slack", "T_ONE", "U_UNKNOWN", roster) === undefined, "unknown id ⇒ undefined (stays per-surface)");
ok(resolvePrincipal("github", undefined, "Rowan Hale", roster) === undefined, "NEVER matches on display name — a github account named 'Rowan Hale' is not Rowan");
ok(principalLabel(rowan) === "Rowan Hale (@rowan)", "label with handle");
ok(principalLabel(sarah) === "Sarah Kim", "label without handle");
assert.deepEqual(principalSurfaces(rowan), ["github", "slack"], "principalSurfaces lists mapped platforms sorted");
n++;
noThrow(() => assertPrincipalsValid(roster), "valid roster passes assertPrincipalsValid");
noThrow(() => assertPrincipalsValid([]), "empty roster is valid (feature degrades to per-surface)");
throws(
  () => assertPrincipalsValid([rowan, definePrincipal({ name: "Impostor", ids: { slack: "U0EXOWNER" } })]),
  "same (slack, id) claimed by two people ⇒ fail loud (fail-closed on merge)",
);
throws(
  () => assertPrincipalsValid([rowan, definePrincipal({ name: "Rowan Hale", ids: { slack: "U0EXOWNER" } })]),
  "two SAME-NAMED entries double-claiming one (platform, id) ⇒ fail loud (conflicts key by entry index, not by display name)",
);
throws(
  () => assertPrincipalsValid([rowan, definePrincipal({ name: "Rowan Hale", ids: { github: "someone-else" }, email: "T@Example.com" })]),
  "…and the same holds for the email ledger: two same-named entries claiming one email ⇒ fail loud",
);
throws(() => assertPrincipalsValid([definePrincipal({ name: "", ids: { slack: "X" } })]), "empty name ⇒ fail loud");
throws(() => assertPrincipalsValid([definePrincipal({ name: "NoIds", ids: {} })]), "no surface ids ⇒ fail loud");
throws(
  () => assertPrincipalsValid([rowan, definePrincipal({ name: "Other", ids: { github: "other" }, email: "T@Example.com" })]),
  "duplicate email (case-insensitive) ⇒ fail loud",
);

const twoWorkspaces = definePrincipal({
  name: "Rowan Hale",
  handle: "rowan",
  ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_A" }, { tenant: "T9ZYX8W7V", id: "U_B" }], github: "example-owner" },
});
assert.deepEqual(
  principalKeys(twoWorkspaces),
  ["github/example-owner", "slack/T0AB1CD2E/U_A", "slack/T9ZYX8W7V/U_B"],
  "OPE-350: two same-platform accounts compose two DISTINCT, fully-qualified principal keys",
);
n++;
assert.deepEqual(principalSurfaces(twoWorkspaces), ["github", "slack"], "OPE-350: principalSurfaces still reports PLATFORMS, deduped");
n++;
ok(resolvePrincipal("slack", "T0AB1CD2E", "U_A", [twoWorkspaces]) === twoWorkspaces, "OPE-350: the workspace-A account resolves the human");
ok(resolvePrincipal("slack", "T9ZYX8W7V", "U_B", [twoWorkspaces]) === twoWorkspaces, "OPE-350: …and so does the workspace-B account");
ok(resolvePrincipal("slack", "T9ZYX8W7V", "U_A", [twoWorkspaces]) === undefined, "OPE-350: workspace A's id does NOT resolve in workspace B (no cross-tenant aliasing)");
ok(resolvePrincipal("slack", undefined, "U_A", [twoWorkspaces]) === undefined, "OPE-350: a caller that cannot name its workspace matches no QUALIFIED entry (fail closed)");
noThrow(() => assertPrincipalsValid([twoWorkspaces]), "OPE-350: a fully-qualified two-workspace entry is valid");

const legacy = definePrincipal({ name: "Sarah Kim", ids: { slack: "U_SARAH", linear: "lin-uuid-1" } });
ok(resolvePrincipal("slack", "T0AB1CD2E", "U_SARAH", [legacy]) === legacy, "OPE-350: a BARE slack id still answers for this deployment's workspace (pre-350 meaning preserved)");
ok(resolvePrincipal("slack", "T9ZYX8W7V", "U_SARAH", [legacy]) === legacy, "OPE-350: …and for any workspace, because bare means 'whichever one this deployment serves'");
assert.deepEqual(principalSurfaces(legacy), ["linear", "slack"], "OPE-350: an untouched map reports the same surfaces it always did");
n++;
assert.deepEqual(
  surfaceIdsFromAccounts(principalAccounts(legacy)),
  { linear: "lin-uuid-1", slack: "U_SARAH" },
  "OPE-350: a single unqualified account round-trips to the BARE STRING spelling — byte-identical output for an unmigrated map",
);
n++;

throws(
  () => assertPrincipalsValid([twoWorkspaces, definePrincipal({ name: "Sarah Kim", ids: { slack: "U_SARAH" } })]),
  "OPE-350: mixing a workspace-qualified and a bare slack entry in ONE map ⇒ fail loud (the half-migrated state)",
);
noThrow(
  () => assertPrincipalsValid([legacy, definePrincipal({ name: "Ada", ids: { slack: "U_ADA" } })]),
  "OPE-350: …but an ALL-BARE map (every deployment today) is untouched and still valid",
);
throws(
  () => assertPrincipalsValid([definePrincipal({ name: "Ada", ids: { github: [{ tenant: "a", id: "ada" }, { tenant: "b", id: "ada" }] } })]),
  "OPE-350: a tenant on a vendor-global platform ⇒ fail loud (the grammar has no rung there; it would collapse to one key)",
);
throws(
  () => assertPrincipalsValid([definePrincipal({ name: "Ada", ids: { slack: [{ tenant: "dev", id: "U_ADA" }] } })]),
  "OPE-350: the 'dev' unnamed-tenant literal is refused as a workspace rung (it means 'nobody said')",
);
throws(
  () => assertPrincipalsValid([definePrincipal({ name: "Ada", ids: { slack: [{ tenant: "T1/T2", id: "U_ADA" }] } })]),
  "OPE-350: a slash-bearing tenant is refused (it would make the key parse ambiguous)",
);

throws(
  () => assertPrincipalsValid([twoWorkspaces, definePrincipal({ name: "Impostor", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_A" }] } })]),
  "OPE-350: the SAME (platform, tenant, id) claimed by two entries ⇒ fail loud (an account is exactly one person)",
);
noThrow(
  () => assertPrincipalsValid([twoWorkspaces, definePrincipal({ name: "Someone Else", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_OTHER" }] } })]),
  "OPE-350: two people in the SAME workspace with different ids are not a conflict",
);
noThrow(
  () => assertPrincipalsValid([definePrincipal({ name: "Ada", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_SAME" }] } }), definePrincipal({ name: "Grace", ids: { slack: [{ tenant: "T9ZYX8W7V", id: "U_SAME" }] } })]),
  "OPE-350: one id string issued by TWO workspaces is two people, and the map can now say so",
);

const bothWorkspaces = unionPrincipals(
  [],
  [{ linkSetId: "set-1", handle: "rowan", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_A" }, { tenant: "T9ZYX8W7V", id: "U_B" }] } }],
);
assert.deepEqual(
  principalKeys(bothWorkspaces.principals[0]!),
  ["slack/T0AB1CD2E/U_A", "slack/T9ZYX8W7V/U_B"],
  "OPE-350: unionPrincipals carries BOTH same-platform accounts through (the projection is no longer lossy)",
);
n++;
const conflict = unionPrincipals(
  [definePrincipal({ name: "Rowan Hale", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_A" }], github: "example-owner" } })],
  [
    { linkSetId: "set-a", handle: "someone", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_A" }] } },
    { linkSetId: "set-b", handle: "other", ids: { github: "example-owner" } },
  ],
);
ok(
  conflict.warnings.some((w) => w.key === "slack/T0AB1CD2E/U_A"),
  "OPE-350: the union's conflict warning names the COMPOSED per-tenant principal key, not prose",
);
ok(
  conflict.warnings.every((w) => !w.key.includes("account \"")),
  "OPE-350: …and no warning falls back to the prose form when a tenant is available",
);
ok(
  principalKeys(conflict.principals[0]!).length === 0,
  "OPE-350: a conflicted account is dropped from the config entry too (fail-closed on merge, both sides)",
);
const unqualifiedConflict = unionPrincipals(
  [definePrincipal({ name: "A", ids: { slack: "U_X" } }), definePrincipal({ name: "B", ids: { slack: "U_Y" } })],
  [{ linkSetId: "set-1", handle: "one", ids: { slack: ["U_X", "U_Y"] } }],
);
ok(
  unqualifiedConflict.warnings.length > 0 && unqualifiedConflict.warnings.every((w) => w.key.includes("workspace unnamed")),
  "OPE-350: an UNQUALIFIED account still warns in honest prose — never a key-shaped string that addresses nobody",
);
const healed = unionPrincipals(
  [definePrincipal({ name: "Rowan Hale", handle: "rowan", ids: { slack: "U_A" } })],
  [{ linkSetId: "set-1", handle: "rowan", ids: { slack: [{ tenant: "T0AB1CD2E", id: "U_A" }] } }],
);
ok(healed.principals.length === 1 && healed.principals[0]!.name === "Rowan Hale", "OPE-350: a bare config entry still JOINS its own workspace-qualified link-set (no split)");
assert.deepEqual(principalKeys(healed.principals[0]!), ["slack/T0AB1CD2E/U_A"], "OPE-350: …and the merged entry keeps the QUALIFIED spelling, so it composes a key");
n++;

const cw = (unifiedDisclosure?: boolean): NormalizedWake => ({
  platform: "slack",
  reason: "channel-activity",
  addressing: "channel-watch",
  ...(unifiedDisclosure ? { unifiedDisclosure } : {}),
  locus: { channel: { id: "C_PAY", type: "channel" } },
  trigger: { kind: "message", message: { from: "human", author: "Sarah", id: "1.1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer", trigger: true, body: "hi" } },
});
const clock = () => "2026-03-15T09:30:00.000Z";
const plain = renderWake(cw(), clock).message;
const disclosed = renderWake(cw(true), clock).message;
assert.equal(disclosed, plain, "🔴 unifiedDisclosure reaches NO rendered byte — setting it changes nothing");
n++;
ok(!disclosed.includes("Cross-surface disclosure"), "…and the deleted advisory sentence appears in neither render");
ok(disclosed.startsWith("<wake ") && disclosed.endsWith("</wake>"), "a channel-watch wake is its envelope and nothing else (OPE-753)");
ok(disclosed.includes('addressing="channel-watch"'), "…and the ambient addressing is the attribute the standing block keys the high silence bar to");

withEnv(true, () => {
  const ghGrain = supervisorGrainFor(GH, [payments, orgNoGate]);
  const bare = unifiedSupervisorToken("payments", 4);
  const minted = mintRotationToken(ghGrain, 4, () => githubSupervisorToken("acme", "payments-api", 4));

  ok(minted !== bare, "mintRotationToken output is NOT byte-identical to the bare supervisorTokenForGrain output (it's salted)");
  ok(minted.startsWith(`${bare}-`), "mintRotationToken appends -<salt> after the bare token");
  ok(/^oe-dom:payments:oe-sup:g4-[0-9a-f]{6}$/.test(minted), `mintRotationToken (unified branch) shape: ${JSON.stringify(minted)}`);

  const sid = classifySessionId(minted);
  ok(sid.kind === "window" && sid.key.domain === "payments" && sid.key.generation === 4, "mintRotationToken's output still classifies to domain=payments, generation=4");
  ok(isUnifiedSupervisorToken(minted), "mintRotationToken's output is still recognised as a window supervisor token");

  const mintedAgain = mintRotationToken(ghGrain, 4, () => githubSupervisorToken("acme", "payments-api", 4));
  ok(minted !== mintedAgain, "mintRotationToken: two mints at the SAME generation (simulated counter reset) produce DIFFERENT tokens");
  const sidAgain = classifySessionId(mintedAgain);
  ok(sidAgain.kind === "window" && sidAgain.key.domain === "payments" && sidAgain.key.generation === 4, "the re-mint parses to the SAME logical generation too");

  withEnv(undefined, () => {
    const off = supervisorGrainFor(GH, [payments, orgNoGate]);
    const mintedOff = mintRotationToken(off, 2, () => githubSupervisorToken("acme", "payments-api", 2));
    ok(/^github:acme\/payments-api:oe-sup:g2-[0-9a-f]{6}$/.test(mintedOff), `mintRotationToken (per-container branch) shape: ${JSON.stringify(mintedOff)}`);
    const sidOff = classifySessionId(mintedOff);
    ok(sidOff.kind === "container-supervisor" && sidOff.containerKey === "github:acme/payments-api" && sidOff.generation === 2, "per-container mint still classifies with the right containerKey + generation");
  });
});

{
  const { completeWakeAuth } = await import("../agent/channels/unified.js");
  const filled = completeWakeAuth({ attributes: { oe_x: "1" } }) as unknown as Record<string, unknown>;
  ok(filled.authenticator === "" && filled.principalId === "" && filled.principalType === "", "a host wake with only attributes gains the ABSENT-sentinel triple, never an invented identity");
  ok(JSON.stringify(filled.attributes) === JSON.stringify({ oe_x: "1" }), "attributes pass through byte-identical");

  const bare = completeWakeAuth(null) as unknown as Record<string, unknown>;
  ok(JSON.stringify(bare.attributes) === JSON.stringify({}), "a null auth still materialises the REQUIRED attributes record");
  ok(bare.authenticator === "" && bare.principalId === "", "…and the sentinel triple");

  const member = completeWakeAuth({ attributes: { team_id: "T1" }, principalId: "U123", principalType: "slack-user" }) as unknown as Record<string, unknown>;
  ok(member.principalId === "U123" && member.principalType === "slack-user", "a provider-supplied member identity is preserved, never overwritten");
  ok(member.authenticator === "", "only the ABSENT field (authenticator) is filled on a member divert");
}

{
  const A = "slack/T9/C_A";
  const B = "discord/G9/CH_B";
  const C = "slack/T9/C_C";
  const grouped = defineDomain({
    name: "chatter-dom",
    reach: [A, B, C],
    ambientSupervisor: true,
    windows: [{ name: "chatter", reach: [A, B] }],
  });
  const orgGate = defineDomain({ name: "org", match: "org" });

  ok(windowGroupFor(A, grouped)?.name === "chatter", "windowGroupFor: a roster member of the group elects it");
  ok(windowGroupFor(C, grouped) === undefined, "windowGroupFor: a domain member no group lists elects nothing (the residue answers)");
  ok(windowIdFor(A, [grouped, orgGate]) === "chatter", "windowIdFor: the group NAME is the window id");
  ok(windowIdFor(C, [grouped, orgGate]) === undefined, "windowIdFor: undefined when no group speaks — the caller keeps the `mode` residue");
  ok(windowIdFor("slack/T9/C_NOWHERE", [grouped, orgGate]) === undefined, "windowIdFor: a channel in no domain elects no group");
  ok(windowIdFor(CH, [payments, orgNoGate]) === undefined, "windowIdFor: a domain that declares NO windows returns undefined for every channel");

  const twoGroups = defineDomain({
    name: "claims-dom",
    reach: ["github/acme-multi"],
    ambientSupervisor: true,
    windows: [
      { name: "front", reach: ["github/acme-multi/web-*"], exclude: ["github/acme-multi/web-legacy"] },
      { name: "back", reach: ["github/acme-multi"] },
    ],
  });
  ok(windowGroupFor("github/acme-multi/web-shop", twoGroups)?.name === "front", "election: the first group whose claim admits the key wins");
  ok(
    windowGroupFor("github/acme-multi/web-legacy", twoGroups)?.name === "back",
    "election: a group that admits then EXCLUDES a key does not capture it — the sweep continues to the next group",
  );
  ok(windowGroupFor("github/acme-multi/api", twoGroups)?.name === "back", "election: a broader later group takes what the narrower earlier one does not");

  const PINNED = "github/acme-multi/pay-core";
  const broad = { name: "broad", reach: ["github/acme-multi/pay-*"] } as const;
  const focus = { name: "focus", reach: [PINNED] } as const;
  const claimFirst = defineDomain({ name: "tier-a", reach: [PINNED, "github/acme-multi"], ambientSupervisor: true, windows: [broad, focus] });
  const rosterFirst = defineDomain({ name: "tier-b", reach: [PINNED, "github/acme-multi"], ambientSupervisor: true, windows: [focus, broad] });
  ok(windowGroupFor(PINNED, claimFirst)?.name === "focus", "tier order: an exact roster entry beats another group's glob even when the glob is declared FIRST");
  ok(windowGroupFor(PINNED, rosterFirst)?.name === "focus", "tier order: …and the answer is the same when the roster group is declared first — array order cannot change it");
  ok(windowGroupFor("github/acme-multi/pay-edge", claimFirst)?.name === "broad", "tier order: a key no roster lists still falls to the claim tier");

  withEnv(true, () => {
    const g = supervisorGrainFor(A, [grouped, orgGate]);
    ok(g.unified === true && g.windowId === "chatter", "grain: a grouped channel keys on the GROUP name, not its surfaceKey");
    ok(g.domainName === "chatter-dom", "grain: memory/trust stay DOMAIN-anchored — the group slices context only");
    ok(g.registryKey === unifiedDomainSessionKey("chatter"), "grain: the channel_session row keys on the group window id");
    ok(g.singleWindow === undefined, "grain: a group is NOT `singleWindow` — that word means the WHOLE domain in one window");
    ok(grainUsesUnifiedWindow(g) === true, "grain: a group still takes the unified-window divert (windowId set)");
    const gb = supervisorGrainFor(B, [grouped, orgGate]);
    ok(gb.windowId === "chatter" && gb.registryKey === g.registryKey, "grain: both members of a group share ONE window id and ONE registry row");
    const gc = supervisorGrainFor(C, [grouped, orgGate]);
    ok(gc.windowId === C, "grain: the ungrouped member falls through to the `mode` residue (solo ⇒ its own surfaceKey window)");
    const tok = supervisorTokenForGrain(g, 3, () => "never");
    ok(tok === "oe-dom:chatter-dom:win:chatter:oe-sup:g3", "token: a group window mints the explicit :win:<group>: form");
    ok(unifiedWindowFromToken(tok) === "chatter" && unifiedDomainFromToken(tok) === "chatter-dom", "token: it round-trips to (domain, group) through the live codec");
  });

  const carved = defineDomain({
    name: "carved-dom",
    reach: [A, B, C],
    ambientSupervisor: true,
    mode: "unified",
    windows: [{ name: "carve", reach: [A] }],
  });
  withEnv(true, () => {
    const ga = supervisorGrainFor(A, [carved, orgGate]);
    ok(ga.windowId === "carve" && ga.singleWindow === undefined, "residue: the carved member leaves the domain window for its group");
    const gb = supervisorGrainFor(B, [carved, orgGate]);
    ok(gb.singleWindow === true && gb.windowId === undefined, "residue: an ungrouped member of a mode:unified domain keeps the DEGENERATE domain window");
  });

  withEnv(true, () => {
    eqJson(
      supervisorGrainFor(CH, [payments, orgNoGate]),
      `{"unified":true,"registryKey":"${unifiedDomainSessionKey("payments")}","domainName":"payments","singleWindow":true}`,
      "GOLDEN: mode:unified grain is byte-identical when `windows` is absent",
    );
    eqJson(
      supervisorGrainFor(CH, [paymentsSolo, orgNoGate]),
      `{"unified":true,"registryKey":"${unifiedDomainSessionKey(CH)}","domainName":"payments","windowId":"${CH}"}`,
      "GOLDEN: mode:solo grain is byte-identical when `windows` is absent",
    );
    eqJson(
      supervisorGrainFor("slack/T1/C_ORPHAN", [payments, orgNoGate]),
      `{"unified":true,"registryKey":"${unifiedDomainSessionKey("slack/T1/C_ORPHAN")}","domainName":"org","windowId":"slack/T1/C_ORPHAN"}`,
      "GOLDEN: an undeclared channel's grain is its OWN solo seat on the org pseudo-domain",
    );
    eqJson(
      supervisorGrainFor("slack/T1/C_ORPHAN", [payments]),
      `{"unified":false,"registryKey":"slack/T1/C_ORPHAN"}`,
      "GOLDEN: the native per-container grain is untouched where there is no seat domain to inherit",
    );
  });
  withEnv(undefined, () => {
    eqJson(
      supervisorGrainFor(A, [grouped, orgGate]),
      `{"unified":false,"registryKey":"${A}"}`,
      "GOLDEN: gate OFF ⇒ even a GROUPED domain resolves the native per-container grain",
    );
  });

  noThrow(() => assertUnifiedDomainTrust([grouped, orgGate]), "valid: an explicit ambient domain may declare windows");
  noThrow(() => assertUnifiedDomainTrust([payments, orgNoGate]), "valid: a domain with no windows is unaffected by the new rules");
  noThrow(
    () => assertUnifiedDomainTrust([defineDomain({ name: "np", reach: [A], windows: [{ name: "w", reach: [A] }] })]),
    "valid: windows WITHOUT ambientSupervisor — topology and chattiness are independent",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", ambientSupervisor: true, windows: [{ name: "w", reach: [A] }] })]),
    "refused: windows on an org/public/dm pseudo-domain (the 'window everything' footgun)",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "e", reach: [A], ambientSupervisor: true, windows: [] })]),
    "refused: an EMPTY windows list (grants nothing, reads as if it did)",
  );
  for (const badName of ["Chatter", "chat/ter", "chat:ter", "-chat", "chat-", "chat--ter", "", "chat ter", "a".repeat(65)]) {
    throws(
      () => assertUnifiedDomainTrust([defineDomain({ name: "n", reach: [A], ambientSupervisor: true, windows: [{ name: badName, reach: [A] }] })]),
      `refused: the illegal window-group name ${JSON.stringify(badName)} (a name travels as a windowId through two colon/slash grammars)`,
    );
  }
  ok(WINDOW_GROUP_NAME_RE.test("chatter-2"), "the name regex admits lowercase kebab");
  ok(WINDOW_GROUP_NAME_RE.test("a".repeat(64)) && !WINDOW_GROUP_NAME_RE.test("a".repeat(65)), "the length cap is exactly 64 — a 64-char name passes, 65 does not");
  ok(!WINDOW_GROUP_NAME_RE.test("chat-") && !WINDOW_GROUP_NAME_RE.test("chat--ter"), "kebab means kebab: no trailing hyphen, no doubled hyphen");
  throws(
    () =>
      assertUnifiedDomainTrust([
        defineDomain({ name: "d", reach: [A, B], ambientSupervisor: true, windows: [{ name: "dup", reach: [A] }, { name: "dup", reach: [B] }] }),
      ]),
    "refused: the same group name declared TWICE in one domain (the second could never be elected)",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: [A], ambientSupervisor: true, windows: [{ name: "empty" }] })]),
    "refused: a group that names no members",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: [A], ambientSupervisor: true, windows: [{ name: "x", exclude: ["github/a/b"] }] })]),
    "refused: a group with an exclude and no reach (dead config — an exclusion carves out of a REACH)",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: [A], ambientSupervisor: true, windows: [{ name: "x", reach: [A], exclude: [A] }] })]),
    "refused: a group excluding a key its own reach names outright",
  );
  noThrow(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: ["github/acme-a"], ambientSupervisor: true, windows: [{ name: "x", reach: ["github/acme-a/pay-*"], exclude: ["github/acme-a/pay-secrets"] }] })]),
    "valid: an exclusion carving a key out of the group's own CONTAINER — the negative control for the line above",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: ["github/acme-a"], ambientSupervisor: true, windows: [{ name: "x", reach: ["github/other-b"] }] })]),
    "refused: a group claiming containers outside its domain's own claim",
  );
  noThrow(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: ["github/acme-a"], ambientSupervisor: true, windows: [{ name: "x", reach: ["github/acme-a/pay-*"] }] })]),
    "valid: a group narrows WITHIN its domain's own claim",
  );
  noThrow(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: ["github/acme-a"], ambientSupervisor: true, windows: [{ name: "x", reach: ["github/acme-a/exact-repo"] }] })]),
    "valid: a group naming ONE exact surface — the enumerable half of the same one list",
  );
  throws(
    () => assertUnifiedDomainTrust([defineDomain({ name: "d", reach: ["teams/tenant-a"], ambientSupervisor: true, windows: [{ name: "x", reach: ["teams/tenant-a/team:abc"] }] })]),
    "refused: a group claiming the TRUST-plane group rung (`<marker>:<id>`), which no memory key carries",
  );
  throws(
    () =>
      assertUnifiedDomainTrust([
        defineDomain({ name: "d", reach: ["github/acme-a"], ambientSupervisor: true, windows: [{ name: "x", reach: ["github/acme-a/pay-*"], exclude: ["github/acme-a"] }] }),
      ]),
    "refused: a whole-tenant exclusion inside a group (it cancels the claim outright or means nothing)",
  );

  noThrow(() => assertWindowGroupExclusivity([grouped, orgGate]), "valid: one domain, one group name");
  noThrow(() => assertWindowGroupExclusivity([payments, orgNoGate]), "valid: a roster with no windows is a no-op");
  throws(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({ name: "d1", reach: [A], ambientSupervisor: true, windows: [{ name: "ops", reach: [A] }] }),
        defineDomain({ name: "d2", reach: [B], ambientSupervisor: true, windows: [{ name: "ops", reach: [B] }] }),
      ]),
    "refused: two domains declaring the SAME group name (they would share one channel_session row)",
  );
  throws(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({ name: "payments", reach: [A], ambientSupervisor: true, mode: "unified" }),
        defineDomain({ name: "d2", reach: [B], ambientSupervisor: true, windows: [{ name: "payments", reach: [B] }] }),
      ]),
    "refused: a group name that equals a DOMAIN name (the same registry row, reached from the other side)",
  );
  throws(
    () => assertWindowGroupExclusivity([defineDomain({ name: "self", reach: [A], ambientSupervisor: true, windows: [{ name: "self", reach: [A] }] })]),
    "refused: a group named after its OWN domain",
  );
  throws(
    () => assertWindowGroupExclusivity([defineDomain({ name: "d", reach: [A], ambientSupervisor: true, windows: [{ name: "x", reach: ["slack/T9/C_ELSEWHERE"] }] })]),
    "refused: a group listing a channel in no domain at all",
  );
  throws(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({ name: "claimer", reach: ["github/shared-org"], ambientSupervisor: true, windows: [{ name: "mine", reach: ["github/shared-org/repo"] }] }),
        defineDomain({ name: "rosterer", reach: ["github/shared-org/repo"], ambientSupervisor: true }),
      ]),
    "refused: a group listing a key its domain merely CLAIMS while another domain rosters it",
  );
  noThrow(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({ name: "claimer", reach: ["github/solo-org"], ambientSupervisor: true, windows: [{ name: "mine", reach: ["github/solo-org/repo"] }] }),
      ]),
    "valid: a group listing a key its domain claims and nobody else rosters",
  );
  throws(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({ name: "d", reach: [A], ambientSupervisor: true, windows: [{ name: "g1", reach: [A] }, { name: "g2", reach: [A] }] }),
      ]),
    "refused: one channel listed by two groups of the same domain",
  );
  noThrow(() => assertWindowGroupExclusivity([twoGroups]), "valid: a group's glob nested inside another group's tenant is ordered, not ambiguous");
  noThrow(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({
          name: "d",
          reach: ["github/acme-multi"],
          ambientSupervisor: true,
          windows: [
            { name: "front", reach: ["github/acme-multi/web-*"] },
            { name: "back", reach: ["github/acme-multi"], exclude: ["github/acme-multi/web-*"] },
          ],
        }),
      ]),
    "valid: an overlap the other group excludes ENTIRELY is the legal hand-over",
  );
  noThrow(
    () =>
      assertWindowGroupExclusivity([
        defineDomain({ name: "d1", reach: [A], ambientSupervisor: true, windows: [{ name: "g1", reach: [A] }] }),
        defineDomain({ name: "d2", reach: [B], ambientSupervisor: true, windows: [{ name: "g2", reach: [B] }] }),
      ]),
    "valid: distinct group names in distinct domains",
  );
}

console.log(`unified-supervisor-test: ${n} assertions passed`);
