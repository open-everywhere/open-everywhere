import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINDING_RECEIVERS,
  DESTRUCTURED_PRINCIPAL_KEYS,
  INTENT_FOR_ACCESSOR,
  PRINCIPAL_GATE_INTENTS,
  checkPrincipalGates,
  checkUnattendedDispatch,
  findPrincipalGates,
  findUnattendedDispatchSites,
  type PrincipalGate,
} from "../agent/access/principal-gate-manifest.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const gatesIn = (src: string): PrincipalGate[] => findPrincipalGates("fixture.ts", src);
const defectsIn = (src: string) => checkPrincipalGates(gatesIn(src));
const rules = (src: string) => defectsIn(src).map((d) => d.rule);

{
  const naive = `
async function execute(input, ctx) {
  const requestedBy = principalIdOf(ctx);
  if (!requestedBy) {
    throw new Error("needs a verified sender");
  }
}`;
  ok(gatesIn(naive).length === 1, "synthetic: the bound-const-then-refuse shape is SEEN as a gate (shape B)");
  ok(rules(naive).join() === "unmarked", "synthetic: 🔴 …and an unmarked one is RED — writing the idiom with no declared intent is the act that produced OPE-269/272/273");

  const inline = `
function plan(binding) {
  if (!binding.principalId) throw new Error("needs a verified sender");
}`;
  ok(gatesIn(inline).length === 1, "synthetic: the inline `if (!binding.principalId) throw` shape is SEEN as a gate (shape A) — five of OPE-273's seven were written this way");
  ok(rules(inline).join() === "unmarked", "synthetic: …and it is RED unmarked too");

  const mismatched = `
function plan(binding) {
  // principal-gate: presence — a fire must never move a spend cap in its creator's name.
  if (!binding.principalId) throw new Error("needs a verified sender");
}`;
  const md = defectsIn(mismatched);
  ok(md.length === 1 && md[0]!.rule === "mismatched", "synthetic: 🔴 declaring \"presence\" over the BOUND principal is RED — this is the defect itself, caught at the moment it is written");
  ok(/actingPrincipalIdOf\(ctx\) \/ actingPrincipalId\(binding\)/.test(md[0]!.message), "synthetic: …and the message names the accessor to switch to, so the red is a fix and not a puzzle");

  const fixed = mismatched.replace("binding.principalId", "actingPrincipalId(binding)");
  ok(defectsIn(fixed).length === 0, "synthetic: …and the SAME marker over the acting principal is GREEN — the red was about the accessor, not about the annotation");

  const inverted = `
function plan(ctx) {
  // principal-gate: accountability — the card needs somebody nameable on its "asked by" line.
  const who = actingPrincipalIdOf(ctx);
  if (!who) throw new Error("needs a verified sender");
}`;
  ok(rules(inverted).join() === "mismatched", "synthetic: the INVERSE is red too — \"accountability\" over the acting principal drops a name a fire could honestly have supplied");

  ok(rules(`
function plan(binding) {
  // principal-gate: presence
  if (!binding.principalId) throw new Error("x");
}`).join() === "mismatched", "synthetic: a reasonless marker is still checked for accessor agreement FIRST — the accessor is the security property, the prose is the documentation one");
  ok(rules(`
function plan(ctx) {
  // principal-gate: presence —
  const who = actingPrincipalIdOf(ctx);
  if (!who) throw new Error("x");
}`).join() === "no-reason", "synthetic: …and an otherwise-correct marker with nothing after the dash is RED — the word alone is a rubber stamp");

  ok(rules(`
function plan(ctx) {
  // principal-gate: whatever — some words that go on for a while
  const who = actingPrincipalIdOf(ctx);
  if (!who) throw new Error("x");
}`).join() === "unknown-intent", "synthetic: an off-vocabulary intent word is RED rather than silently accepted — two values, no third meaning \"unsure\"");

  ok(gatesIn(`const posted = await requestApproval({ requestedBy: principalIdOf(ctx)!, channelId });`).length === 0, "synthetic: a non-refusing provenance read is NOT a gate — the unit is the refusal, where an identity turns into a permission");
  ok(gatesIn(`
function roleFor(binding) {
  if (!binding.principalId) return NO_ROLE;
}`).length === 0, "synthetic: a fail-SOFT fallback (`return NO_ROLE`) is not a gate — it narrows rather than refusing, and has no message to get wrong");

  ok(rules(`
function plan(binding, ctx) {
  // principal-gate: accountability — the card's asked-by line needs a name.
  const first = principalIdOf(ctx);
  if (!first) throw new Error("x");
  const second = principalIdOf(ctx);
  if (!second) throw new Error("x");
}`).join() === "unmarked", "synthetic: 🔴 a marker is NOT inherited by the next gate down — the second one is red on its own");

  ok(gatesIn(`
// The old shape was: if (!principalIdOf(ctx)) throw new Error("verified sender").
const x = 1;`).length === 0, "synthetic: a gate quoted inside a comment is not a gate — otherwise every file explaining this bug would fail the lint");

  ok(gatesIn(`function f(binding) { if (!binding.principalId) throw new Error("x"); }`)[0]!.accessor === "bound", "synthetic: `binding.principalId` classifies as BOUND — the receiver OPE-273 fixed five gates on");
  ok(gatesIn(`function f(role) { if (!role.principalId) throw new Error("x"); }`)[0]!.accessor === "opaque", "synthetic: 🔴 `role.principalId` classifies as OPAQUE, not bound — Role.principalId is ALREADY the acting principal, so guessing would have demanded a correct gate be broken");
  ok(defectsIn(`
function f(role) {
  // principal-gate: presence — Role.principalId is already the acting principal (roles.ts).
  if (!role.principalId) throw new Error("x");
}`).length === 0, "synthetic: …and an opaque read is checked for a marker + a reason, but never for an accessor match nobody can compute");
}

{
  const bagGate = `
function plan(input) {
  const { grants, mode, actingPrincipalId, domains, surfaceKey, opts = {} } = input;
  if (grants.length === 0) throw new Error("no grant");
  if (!actingPrincipalId) {
    throw new Error("needs a verified sender");
  }
}`;
  ok(gatesIn(bagGate).length === 1, "shape-c: 🔴 a refusal over a DESTRUCTURED `actingPrincipalId` is SEEN at all — the state before this was a real gate the checker certified as absent");
  ok(gatesIn(bagGate)[0]!.accessor === "acting", "shape-c: …classified from the KEY, which is the only name written — `actingPrincipalId` is a name one thing in this tree has");
  ok(rules(bagGate).join() === "unmarked", "shape-c: …and it is RED unmarked, so the shape is now subject to the same rule as every other gate");
  ok(gatesIn(bagGate)[0]!.line === 5, "shape-c: reported at the REFUSAL, not the six-field destructure — a marker above that line could not say which of the six it meant");

  ok(gatesIn(`
function plan(input) {
  const { opts = {}, actingPrincipalId } = input;
  if (!actingPrincipalId) throw new Error("x");
}`).length === 1, "shape-c: a `{}` default inside the pattern doesn't hide keys after it — the brace match is anchored on the pattern's own close");

  ok(gatesIn(`
function plan(input) {
  const { actingPrincipalId: who } = input;
  if (!who) throw new Error("x");
}`)[0]!.accessor === "acting", "shape-c: a rename is followed — the key still appears, so the classification is unchanged");

  const dmGate = `
async function getToken(auth) {
  const { mode, principalId } = await resolveDmPrincipal(auth);
  if (!principalId) throw new Error("no user identity");
}`;
  ok(gatesIn(dmGate)[0]!.accessor === "opaque", "shape-c: 🔴 destructured `principalId` is OPAQUE — resolveDmPrincipal returns the ACTING principal, so a guess of \"bound\" would call a correct presence gate a mismatch");
  ok(defectsIn(`
async function getToken(auth) {
  const { mode, principalId } = await resolveDmPrincipal(auth);
  // principal-gate: presence — this id becomes the OAuth subject a personal token is minted as.
  if (!principalId) throw new Error("no user identity");
}`).length === 0, "shape-c: …so rule 2 is skipped and the marker's own reason carries the claim, same as any opaque read");

  ok(gatesIn(`
function f(ctx) {
  const { actingPrincipalId } = input;
  const who = actingPrincipalIdOf(ctx);
  if (!who) throw new Error("x");
}`).length === 1, "shape-c: a call-form read in a file that ALSO destructures is counted ONCE — shape C only runs where the accessor matchers found nothing");

  ok(gatesIn(`const { actingPrincipalId } = input; const name = actingPrincipalId ?? "anon";`).length === 0, "shape-c: a destructure with no falsy refusal is not a gate — the unit is still the refusal");
  ok(gatesIn(`
// was: const { actingPrincipalId } = input; if (!actingPrincipalId) throw new Error("x");
const x = 1;`).length === 0, "shape-c: …and the same idiom quoted in a comment is not a gate, so this file can keep explaining itself");
}

{
  const sitesIn = (src: string) => findUnattendedDispatchSites("fixture.ts", src);
  const r4 = (src: string) => checkUnattendedDispatch(sitesIn(src));

  const inlineBag = `
const auth = {
  authenticator: "webhook",
  principalType: "service",
  principalId: \`webhook:\${hook.id}\`,
  attributes: { team_id: teamId, channel_id: channelId },
};`;
  ok(sitesIn(inlineBag).length === 1 && sitesIn(inlineBag)[0]!.viaFireAuth === false, "synthetic-r4: a service-principal auth with a hand-rolled bag is SEEN, and seen as inline");
  ok(r4(inlineBag).length === 1 && r4(inlineBag)[0]!.rule === "unattended-inline-bag", "synthetic-r4: 🔴 …and it is RED — this is the exact shape the webhook fire shipped with, caught at the moment it is written");
  ok(/FIRE_UNATTENDED_ATTR/.test(r4(inlineBag)[0]!.message) && /fire-auth/.test(r4(inlineBag)[0]!.message), "synthetic-r4: …and the message names both the marker and the module to build the bag in, so the red is a fix and not a puzzle");

  const viaBuilder = inlineBag.replace(
    "attributes: { team_id: teamId, channel_id: channelId },",
    "attributes: { ...webhookFireAttributes(hook.id, teamId, channelId, isDm, internal) },",
  );
  ok(sitesIn(viaBuilder).length === 1 && sitesIn(viaBuilder)[0]!.viaFireAuth === true, "synthetic-r4: the SAME site building through a fire-auth builder is GREEN — the red was about the bag's provenance, not about dispatching at all");
  ok(r4(viaBuilder).length === 0, "synthetic-r4: …no defect");

  ok(r4(`const auth = { authenticator: "webhook", principalType: "service", principalId: "webhook:x" };`).length === 1, "synthetic-r4: a service auth with no attributes at all is red too — no bag means no marker, which is the same hole");

  ok(sitesIn(`const auth = { authenticator: "slack", principalType: "slack-user", principalId: userId, attributes: a };`).length === 0, "synthetic-r4: a human-principal auth is not a site — live ingress must never be pushed toward stamping the marker");

  ok(sitesIn(`// the old shape was principalType: "service" with an inline attributes: bag`).length === 0, "synthetic-r4: a site quoted inside a comment is not a site");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
{
  const files = tsFilesUnder(join(root, "agent"));
  ok(files.length > 100, `real: the scan actually read core's agent tree (${files.length} files) — a green over an empty file list is a green produced by blindness`);
  const gates = files.flatMap((f) => findPrincipalGates(relative(root, f), readFileSync(f, "utf8")));
  ok(checkPrincipalGates(gates).length === 0, `real: every principal refusal gate in core declares its intent (${checkPrincipalGates(gates).map((d) => `${d.file}:${d.line} ${d.rule}`).join(", ")})`);

  const at = (needle: string) => gates.find((g) => g.file.endsWith(needle));
  ok(at("tools/set_spend_limit.ts")?.intent === "presence", "real: set_spend_limit's gate is SEEN and reads presence (OPE-273) — the detector still matches `actingPrincipalId(binding)` inside a pure planner");
  ok(at("tools/run_routine_now.ts")?.intent === "presence", "real: run_routine_now's loop guard is SEEN and reads presence (OPE-269)");
  ok(at("tools/create_ticket.ts")?.intent === "accountability", "real: create_ticket is SEEN and stays accountability — a routine filing work is the product, and this test is what stops a future 'fences everywhere' sweep converting it");
  ok(at("tools/forget.ts")?.accessor === "bound", "real: forget's `binding.principalId` is SEEN as a BOUND property read — the exact spelling five of OPE-273's seven gates used");
  ok(at("access/analytics-scope.ts")?.accessor === "opaque", "real: analytics-scope's `role.principalId` is SEEN as opaque — the measured case the third accessor value exists for");
  ok(at("connections/aws-identity.ts")?.accessor === "acting", "real: planAwsIdentity's DESTRUCTURED fence is SEEN and reads acting — a fire may not assume a human's AWS SSO identity, and the lint certified this file as gate-free until shape C landed");
  ok(at("connections/connector-auth.ts")?.intent === "presence", "real: the Connect per-user mint's `principalId` refusal is SEEN — destructured off resolveDmPrincipal, which returns the ACTING principal despite the bound-looking spelling");
  ok(at("connections/executor-user-oauth.ts")?.intent === "presence", "real: …and its Executor twin too, so the pair cannot drift apart unnoticed");

  const presence = gates.filter((g) => g.intent === "presence").length;
  ok(presence >= 15 && gates.length >= 25, `real: the inventory is the size the three sweeps left behind (${gates.length} gates, ${presence} presence) — a collapse here means the detector stopped seeing, not that the gates went away`);

  const sites = files.flatMap((f) => findUnattendedDispatchSites(relative(root, f), readFileSync(f, "utf8")));
  ok(checkUnattendedDispatch(sites).length === 0, `real: every service-principal dispatch builds its bag through fire-auth (${checkUnattendedDispatch(sites).map((d) => `${d.file}:${d.line}`).join(", ")})`);
  const siteAt = (needle: string) => sites.find((s) => s.file.endsWith(needle));
  ok(siteAt("webhooks/dispatch.ts")?.viaFireAuth === true, "real: the webhook fire's dispatch is SEEN and builds through webhookFireAttributes — the site OPE-278 is about");
  ok(siteAt("routines/ingress.ts")?.viaFireAuth === true, "real: the event fan-out's dispatch is SEEN and builds through routineFireAttributes — the site whose creator-less rows were the third family");
  ok(sites.length >= 2, `real: the site inventory did not collapse (${sites.length}) — zero would mean the detector went blind, not that the dispatches went away`);
}

{
  ok(PRINCIPAL_GATE_INTENTS.length === 2, "vocabulary: exactly two intents — a third meaning \"either\" would give the idiom somewhere to hide");
  ok(INTENT_FOR_ACCESSOR.bound === "accountability" && INTENT_FOR_ACCESSOR.acting === "presence", "vocabulary: each accessor maps to the one intent it can deliver");
  ok(INTENT_FOR_ACCESSOR.opaque === undefined, "vocabulary: 🔴 `opaque` maps to NOTHING — a deliverable for it would be a claim the checker cannot support");
  ok(BINDING_RECEIVERS.includes("binding") && BINDING_RECEIVERS.includes("b"), "vocabulary: the classified receivers are the two evidenced in the tree, not a guess at what a binding might be called");
  ok(DESTRUCTURED_PRINCIPAL_KEYS["actingPrincipalId"] === "acting", "vocabulary: the destructured `actingPrincipalId` key delivers presence — the KEY classifies, because in a pattern the source field's own name is what is written");
  ok(DESTRUCTURED_PRINCIPAL_KEYS["principalId"] === "opaque", "vocabulary: 🔴 …while a destructured `principalId` declines to claim, for the same measured reason `role.principalId` does — the two shipped gates on it are ACTING reads wearing a bound-looking name");
}

console.log(`✓ principal-gate-lint: ${passed} assertions passed`);
