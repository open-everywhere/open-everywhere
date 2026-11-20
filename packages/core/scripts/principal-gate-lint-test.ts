import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTENDEDNESS_DERIVATION,
  ATTENDEDNESS_DERIVATION_BINDING,
  BINDING_RECEIVERS,
  checkApprovalAuthoritySites,
  DESTRUCTURED_PRINCIPAL_KEYS,
  INTENT_FOR_ACCESSOR,
  PRINCIPAL_GATE_INTENTS,
  checkAttendednessSites,
  checkPrincipalGates,
  checkUnattendedDispatch,
  findAttendednessSites,
  findPrincipalGates,
  findProposeAliasShapeProblems,
  findUnattendedDispatchSites,
  lexicalViews,
  type PrincipalGate,
} from "../agent/access/principal-gate-manifest.js";
import { posixRelative } from "../../../scripts/posix-path.js";
import { parseSync } from "oxc-parser";

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
  const gates = files.flatMap((f) => findPrincipalGates(posixRelative(root, f), readFileSync(f, "utf8")));
  ok(checkPrincipalGates(gates).length === 0, `real: every principal refusal gate in core declares its intent (${checkPrincipalGates(gates).map((d) => `${d.file}:${d.line} ${d.rule}`).join(", ")})`);

  const at = (needle: string) => gates.find((g) => g.file.endsWith(needle));
  ok(at("tools/set_spend_limit.ts")?.intent === "presence", "real: set_spend_limit's gate is SEEN and reads presence (OPE-273) — the detector still matches `actingPrincipalId(binding)` inside a pure planner");
  ok(at("tools/run_routine_now.ts")?.intent === "presence", "real: run_routine_now's loop guard is SEEN and reads presence (OPE-269)");
  ok(at("tools/create_ticket.ts")?.intent === "accountability", "real: create_ticket is SEEN and stays accountability — a routine filing work is the product, and this test is what stops a future 'fences everywhere' sweep converting it");
  ok(at("tools/purge_memory.ts")?.accessor === "bound", "real: purge_memory's `binding.principalId` is SEEN as a BOUND property read — the exact spelling five of OPE-273's seven gates used");
  ok(at("access/analytics-scope.ts")?.accessor === "opaque", "real: analytics-scope's `role.principalId` is SEEN as opaque — the measured case the third accessor value exists for");
  ok(at("connections/aws-identity.ts")?.accessor === "acting", "real: planAwsIdentity's DESTRUCTURED fence is SEEN and reads acting — a fire may not assume a human's AWS SSO identity, and the lint certified this file as gate-free until shape C landed");
  ok(at("connections/connector-auth.ts")?.intent === "presence", "real: the Connect per-user mint's `principalId` refusal is SEEN — destructured off resolveDmPrincipal, which returns the ACTING principal despite the bound-looking spelling");

  const presence = gates.filter((g) => g.intent === "presence").length;
  ok(presence >= 14 && gates.length >= 24, `real: the inventory is the size the three sweeps left behind (${gates.length} gates, ${presence} presence) — a collapse here means the detector stopped seeing, not that the gates went away`);

  const sites = files.flatMap((f) => findUnattendedDispatchSites(posixRelative(root, f), readFileSync(f, "utf8")));
  ok(checkUnattendedDispatch(sites).length === 0, `real: every service-principal dispatch builds its bag through fire-auth (${checkUnattendedDispatch(sites).map((d) => `${d.file}:${d.line}`).join(", ")})`);
  const siteAt = (needle: string) => sites.find((s) => s.file.endsWith(needle));
  ok(siteAt("webhooks/dispatch.ts")?.viaFireAuth === true, "real: the webhook fire's dispatch is SEEN and builds through webhookFireAttributes — the site OPE-278 is about");
  ok(siteAt("routines/ingress.ts")?.viaFireAuth === true, "real: the event fan-out's dispatch is SEEN and builds through routineFireAttributes — the site whose creator-less rows were the third family");
  ok(sites.length >= 2, `real: the site inventory did not collapse (${sites.length}) — zero would mean the detector went blind, not that the dispatches went away`);
}

{
  const sitesIn = (src: string) => findAttendednessSites("fixture.ts", src);
  const r5 = (src: string) => checkAttendednessSites(sitesIn(src));

  const noBag = `
async function execute(input, ctx) {
  const posted = await requestApproval(
    {
      org: p.org,
      kind: "skill.delete",
      scopeKey: p.surfaceKey,
      postedTo: venue.surfaceKey,
    },
    approvalPostDeps(venue.platform),
  );
}`;
  ok(sitesIn(noBag).length === 1 && sitesIn(noBag)[0]!.shape === "propose", "synthetic-r5: a propose site is SEEN, and seen as a propose");
  ok(sitesIn(noBag)[0]!.expr === undefined, "synthetic-r5: …carrying no attendedness value, which is the whole defect");
  ok(r5(noBag).map((d) => d.rule).join() === "attendedness-missing", "synthetic-r5: 🔴 …and it is RED — the shape fourteen tools shipped with, now caught when it is written");

  const handRolled = noBag.replace("postedTo: venue.surfaceKey,", "postedTo: venue.surfaceKey,\n      chain: { unattended: principalIdOf(ctx) === undefined },");
  ok(sitesIn(handRolled)[0]!.expr === "principalIdOf(ctx) === undefined", "synthetic-r5: a hand-rolled value is SEEN as written");
  ok(r5(handRolled).map((d) => d.rule).join() === "attendedness-hand-rolled", "synthetic-r5: 🔴 …and RED — a fire binds as its attested creator, so this spelling answers \"a human is present\" for every fire");
  ok(new RegExp(ATTENDEDNESS_DERIVATION.replace(/[()]/g, "\\$&")).test(r5(handRolled)[0]!.message), "synthetic-r5: …and the message names the one approved derivation, so the red is a fix and not a puzzle");

  const derived = noBag.replace("postedTo: venue.surfaceKey,", "postedTo: venue.surfaceKey,\n      chain: { unattended: unattendedOf(ctx) },");
  ok(r5(derived).length === 0, "synthetic-r5: the SAME site deriving through unattendedOf(ctx) is GREEN");

  const viaLocal = `
async function execute(input, ctx) {
  const unattended = unattendedOf(ctx);
  const resolution = await resolveApproverChain({
    tool: "aws",
    unattended,
  });
}`;
  ok(sitesIn(viaLocal).length === 1 && sitesIn(viaLocal)[0]!.shape === "chain-literal", "synthetic-r5: an inline chain-request literal is SEEN too, and classified as a literal");
  ok(r5(viaLocal).length === 0, "synthetic-r5: …and a shorthand `unattended,` bound from the derivation is GREEN — provenance is what the rule is about, not the identifier");
  const viaBadLocal = viaLocal.replace("const unattended = unattendedOf(ctx);", "const unattended = principalIdOf(ctx) === undefined;");
  ok(r5(viaBadLocal).map((d) => d.rule).join() === "attendedness-hand-rolled", "synthetic-r5: 🔴 …while the same shorthand bound from the WRONG accessor is RED, so the local cannot launder the spelling");

  const namedLiteral = `
async function execute(input, ctx) {
  const request: ApprovalChainRequest = {
    tool: input.tool,
    unattended: input.unattended ?? unattendedOf(ctx as BindableContext),
  };
}`;
  ok(sitesIn(namedLiteral).length === 1 && r5(namedLiteral).length === 0, "synthetic-r5: a NAMED chain-request literal is seen, and a simulator override that still bottoms out in the derivation is GREEN");

  const exemptOk = `
async function trip(ctx) {
  // approval-chain: exempt — session.checkpoint is a NON_TOOL_ACTION_KIND, so the chain never runs.
  await requestApproval({ org, kind: CHECKPOINT_KIND, postedTo: key }, deps);
}`;
  ok(sitesIn(exemptOk)[0]!.exempt === true && r5(exemptOk).length === 0, "synthetic-r5: an `approval-chain: exempt` marker WITH a reason opts the site out");
  const exemptBare = exemptOk.replace(" — session.checkpoint is a NON_TOOL_ACTION_KIND, so the chain never runs.", "");
  ok(r5(exemptBare).map((d) => d.rule).join() === "attendedness-exempt-no-reason", "synthetic-r5: 🔴 …and a bare marker is RED — this is the one way to opt OUT of a security control");

  const aliased = `
export async function runBudgetRaise(binding, deps = {}) {
  const requestApprovalFn = deps.requestApproval ?? requestApproval;
  const posted = await requestApprovalFn(
    {
      org: plan.args.org,
      kind: plan.kind,
      channelId,
      threadTs: binding.threadTs ?? null,
    },
    approvalPostDeps(binding.platform),
  );
}`;
  ok(sitesIn(aliased).length === 1 && sitesIn(aliased)[0]!.shape === "propose", "synthetic-r5: 🔴 a propose through an ALIAS of requestApproval is SEEN — the shape that hid a whole front door");
  ok(r5(aliased).map((d) => d.rule).join() === "attendedness-missing", "synthetic-r5: …and its missing bag is RED, which is the state commands/core.ts actually shipped in");
  const aliasedFixed = aliased.replace("threadTs: binding.threadTs ?? null,", `threadTs: binding.threadTs ?? null,\n      chain: { unattended: ${ATTENDEDNESS_DERIVATION_BINDING} },`);
  ok(r5(aliasedFixed).length === 0, "synthetic-r5: the binding-taking derivation is GREEN — a caller holding a SurfaceBinding and no ctx has an approved spelling too");
  ok(sitesIn(aliased).filter((x) => x.line === 3).length === 0, "synthetic-r5: 🔴 the ALIAS DECLARATION itself is not counted as a site — it references requestApproval without calling it");
  ok(sitesIn(`
async function f(ctx) {
  const posted = await requestApproval({ org, kind: "a", postedTo: k }, deps);
}`).length === 1, "synthetic-r5: 🔴 …while `const posted = await requestApproval(` IS still a site — the alias matcher requires a reference, never a call");

  {
    const mentionInTemplate = `
async function f(ctx) {
  const failed = new Error(\`requestApproval: failed to post the approval card for "\${kind}"\`);
  if (bad) throw failed;
  failed(release);
}`;
    ok(sitesIn(mentionInTemplate).length === 0, "🔴 OPE-1892: a name mentioned inside a TEMPLATE LITERAL declares no alias, so the unrelated `failed(` call below it is not read as a propose site");
    ok(r5(mentionInTemplate).length === 0, "🔴 OPE-1892: …and the rule is therefore GREEN on the line that cost a gate cycle");
    ok(sitesIn(`
async function f(ctx) {
  const failed = new Error("requestApproval: could not post");
  failed(release);
}`).length === 0, "OPE-1892: a plain STRING mention declares no alias either");
    ok(sitesIn(`
async function f(ctx) {
  const DECL_RE = /\\bfunction\\s+requestApproval\\b/;
  DECL_RE(x);
}`).length === 0, "🔴 OPE-1892: nor does a REGEX literal — principal-gate-manifest.ts holds exactly that declaration, so the rule was mis-reading its own source");

    ok(sitesIn(aliased).length === 1, "🔴 OPE-1892 NEGATIVE CONTROL: the REAL alias (`deps.requestApproval ?? requestApproval`) is still read — the narrowing did not blind the reader to the shape it exists for");
    ok(sitesIn(`
async function f(ctx) {
  const fn = requestApproval;
  fn({ org, kind: "a", postedTo: k }, deps);
}`).length === 1, "OPE-1892 NEGATIVE CONTROL: a bare reference alias is still read");
    ok(sitesIn(`
async function f(ctx) {
  const fn = deps?.approvals.requestApproval ?? requestApproval;
  fn({ org, kind: "a", postedTo: k }, deps);
}`).length === 1, "OPE-1892 NEGATIVE CONTROL: an optional-chained member path is still read");

    const unreadable = `
async function f(ctx) {
  const fn = cond ? noop : requestApproval;
  fn({ org, kind: "a", postedTo: k }, deps);
}`;
    const shapes = findProposeAliasShapeProblems("fixture.ts", unreadable);
    ok(shapes.length === 1 && shapes[0]!.line === 3, "🔴 OPE-1892: a binding the reader cannot classify is REPORTED at its own line — the narrowing cannot go quiet on a propose site it stopped following");
    ok(findProposeAliasShapeProblems("fixture.ts", aliased).length === 0, "OPE-1892: the ordinary reference alias raises no shape problem");
    ok(findProposeAliasShapeProblems("fixture.ts", mentionInTemplate).length === 0, "🔴 OPE-1892: and neither does a mention inside a literal — otherwise the fix would have swapped one false positive for another");

    const collide = `
async function f(ctx) {
  const unclassified = deps.requestApproval ?? requestApproval;
  unclassified({ org, kind: "a", postedTo: k }, deps);
}`;
    ok(sitesIn(collide).length === 1, "🔴 OPE-1892: an alias literally NAMED `unclassified` is still followed — the reader's sentinel cannot be spelled by the code it reads");
    ok(findProposeAliasShapeProblems("fixture.ts", collide).length === 0, "🔴 OPE-1892: …and it raises no false shape problem, so the citation an author reads is never about a line that is fine");
  }

  ok(sitesIn(`// await requestApproval({ postedTo: k }, deps);`).length === 0, "synthetic-r5: the idiom quoted in a COMMENT is not a site, so this tree can keep explaining itself");
  ok(sitesIn(`export async function requestApproval(input, deps) { return null; }`).length === 0, "synthetic-r5: the function's own DECLARATION is not a call site");
  const twoCalls = `
async function f(ctx) {
  await requestApproval(
    { org, kind: "a", postedTo: k },
    deps,
  );
  await requestApproval(
    { org, kind: "b", postedTo: k, chain: { unattended: unattendedOf(ctx) } },
    deps,
  );
}`;
  ok(sitesIn(twoCalls).length === 2 && sitesIn(twoCalls)[0]!.expr === undefined, "synthetic-r5: 🔴 a value-less call does NOT borrow the next call's — the scan stops at its own closer");
  ok(r5(twoCalls).map((d) => d.rule).join() === "attendedness-missing", "synthetic-r5: …so exactly the first one is red");
}

{
  const sitesIn = (src: string) => findAttendednessSites("fixture.ts", src);
  const r5 = (src: string) => checkAttendednessSites(sitesIn(src));
  const naked = `
async function f(ctx) {
  await requestApproval({ org, kind: "a", postedTo: k }, deps);
}`;
  ok(r5(naked).map((d) => d.rule).join() === "attendedness-missing", "OPE-2559 control: the bare propose site with no bag is RED on its own");

  const globAbove = `const GLOB = "src/*";\n${naked}`;
  ok(r5(globAbove).map((d) => d.rule).join() === "attendedness-missing", "🔴 OPE-2559: a `/*` inside a STRING opens no comment — the propose site below it is still seen, and still RED");
  const regexAbove = `const SLASHES = /\\/*/;\n${naked}`;
  ok(r5(regexAbove).map((d) => d.rule).join() === "attendedness-missing", "🔴 OPE-2559: a `/*` inside a REGEX opens no comment either");
  const templateAbove = `const HELP = \`see src/*.ts\`;\n${naked}`;
  ok(r5(templateAbove).map((d) => d.rule).join() === "attendedness-missing", "🔴 OPE-2559: …nor inside a TEMPLATE literal");
  const urlBeside = `
async function f(ctx) {
  const where = "https://example.test"; await requestApproval({ org, kind: "a", postedTo: k }, deps);
}`;
  ok(r5(urlBeside).map((d) => d.rule).join() === "attendedness-missing", "🔴 OPE-2559: a `//` inside a string blanks nothing after it on the line");

  const regexAfterIfHead = `
async function f(ctx) {
  const fn = (() => { if (ready) /'/.test(s); return requestApproval; })();
  fn({ org, kind: "a", postedTo: k }, deps);
}`;
  const shapes = findProposeAliasShapeProblems("fixture.ts", regexAfterIfHead);
  ok(shapes.length === 1 && shapes[0]!.line === 3, "🔴 OPE-2559: a regex after an `if (…)` head is a REGEX — the binding behind it is SEEN and REPORTED, not blanked");
  const regexAfterBlock = `
async function f(ctx) {
  const fn = (() => { if (ready) {} /'/.test(s); return requestApproval; })();
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", regexAfterBlock).length === 1, "🔴 OPE-2559: …and so is a regex after a BLOCK's closing brace");
  const regexAfterKeyword = `
async function f(ctx) {
  const fn = (() => { return /'/.test(s) ? requestApproval : noop; })();
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", regexAfterKeyword).length === 1, "🔴 OPE-2559: …and a regex after `return`");

  const divisionAfterValue = `
async function f(ctx) {
  const fn = (total) / requestApproval / 2;
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", divisionAfterValue).length === 1, "OPE-2559: a division after a parenthesised VALUE stays a division, so the binding is still reported");
  const divisionAfterPostfix = `
async function f(ctx) {
  const fn = i++ / requestApproval / 2;
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", divisionAfterPostfix).length === 1, "🔴 OPE-2559: a division after a POSTFIX `++` stays a division — the old guess read `+` as an operator and opened a regex");
  const divisionAfterObject = `
async function f(ctx) {
  const fn = ({ a: 1 }).a / requestApproval / 2;
  const gn = { a: 1 } / requestApproval / 2;
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", divisionAfterObject).length === 2, "OPE-2559: a division after an OBJECT literal's closing brace stays a division");
  const divisionAfterProperty = `
async function f(ctx) {
  const fn = opts.return / requestApproval / 2;
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", divisionAfterProperty).length === 1, "OPE-2559: a keyword used as a PROPERTY name is a value, so the `/` after it divides");

  const quotedInTemplate = `
const HELP = \`
const fn = requestApproval;
\`;
async function f(ctx) {
  fn(x);
}`;
  ok(sitesIn(quotedInTemplate).length === 0, "OPE-2559: a declaration quoted inside a MULTI-LINE template declares no alias");
  const inHole = `
async function f(ctx) {
  const msg = \`\${await requestApproval({ org, kind: "a", postedTo: k }, deps)}\`;
}`;
  ok(r5(inHole).map((d) => d.rule).join() === "attendedness-missing", "🔴 OPE-2559: a propose call inside a template's `${…}` hole is still a site");
  const strayslash = `
async function f(ctx) {
  const fn = cond ? /requestApproval : noop;
}`;
  ok(findProposeAliasShapeProblems("fixture.ts", strayslash).length === 1, "OPE-2559: an unterminated regex blanks nothing — the scan recovers as a division, the loud direction");

  ok(lexicalViews("const a = function () {} / 2 / 3;").bare[0] === "const a = function () {} /   / 3;", "OPE-2559 LIMIT: a division right after a function EXPRESSION's body reads as a regex");
  ok(lexicalViews("a = b\n++/'/.lastIndex;").bare[1] === "++/'            ", "OPE-2559 LIMIT: a regex after a prefix `++` that ASI moved onto its own line reads as a division");
  const spill = lexicalViews("const w = function () {} / 2; const s = `a/b`;\nconst fn = requestApproval;\nfn(x);\n`");
  ok(spill.bare[1]!.trim() === "", "🔴 OPE-2559 LIMIT: a misread is NOT bounded to its line — the backtick it exposes opens a template, and the alias declaration on the next line is blanked");
  const commentSpill = (head: string) => `${head} const t = '/'; const u = '/*';
async function f(ctx) {
  await requestApproval({ org, kind: "a", postedTo: k }, deps);
}
const z = '*/';`;
  ok(findAttendednessSites("fixture.ts", commentSpill("const w = 1;")).length === 1, "OPE-2559 LIMIT control: with no misread, the propose site below the quoted `/*` is seen");
  ok(findAttendednessSites("fixture.ts", commentSpill("const w = function () {} / a;")).length === 0, "🔴 OPE-2559 LIMIT: a misread that exposes a `/*` opens a comment in the CODE view too — the propose site below it is not seen by any rule");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const providers = join(here, "..", "..", "providers");
  const providerTrees = readdirSync(providers).map((p) => join(providers, p, "agent"));
  const scanned = [join(here, "..", "agent"), join(here, "..", "..", "..", "agent"), ...providerTrees].flatMap((d) => {
    try {
      return statSync(d).isDirectory() ? tsFilesUnder(d) : [];
    } catch {
      return [];
    }
  });
  ok(scanned.length > 100, `real-lex: the parity check read the lints' trees (${scanned.length} files)`);
  type Node = { readonly type?: string; readonly start: number; readonly end: number; readonly value?: unknown; readonly regex?: { readonly pattern: string }; readonly [k: string]: unknown };
  const misses: string[] = [];
  for (const file of scanned) {
    const source = readFileSync(file, "utf8");
    const parsed = parseSync(file, source, { lang: "ts" });
    if (parsed.errors.length > 0) {
      misses.push(`${file}: the parser refused the file`);
      continue;
    }
    const want = source.split("");
    const blank = (from: number, to: number): void => {
      for (let k = from; k < to; k++) if (want[k] !== "\n" && want[k] !== "\r") want[k] = " ";
    };
    for (const c of parsed.comments) blank(c.start, c.end);
    const wantCode = want.join("").split("\n");
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      const n = node as Node;
      if (n.type === "Literal" && typeof n.value === "string") blank(n.start + 1, n.end - 1);
      else if (n.type === "Literal" && n.regex !== undefined) blank(n.start + 1, n.start + 1 + n.regex.pattern.length);
      else if (n.type === "TemplateElement") blank(n.start + 1, n.start + 1 + ((n.value as { raw: string }).raw.length));
      for (const key of Object.keys(n)) if (key !== "parent") walk(n[key]);
    };
    walk(parsed.program);
    const expected = want.join("").split("\n");
    const views = lexicalViews(source);
    const at = expected.findIndex((line, i) => line !== views.bare[i]);
    if (at !== -1 || views.bare.length !== expected.length) misses.push(`${posixRelative(here, file)}:${at + 1} (bare)`);
    const atCode = wantCode.findIndex((line, i) => line !== views.code[i]);
    if (atCode !== -1 || views.code.length !== wantCode.length) misses.push(`${posixRelative(here, file)}:${atCode + 1} (code)`);
  }
  ok(misses.length === 0, `real-lex: 🔴 the lexical scan agrees with the parser on every file the lints read, in both views (${misses.slice(0, 5).join(", ")})`);
}

{
  const sitesIn = (src: string) => findAttendednessSites("fixture.ts", src);
  const r5 = (src: string) => checkAttendednessSites(sitesIn(src));

  const bareTool = `
const approvalPolicy: Approval<PostFileInput> = (approvalCtx) => {
  const files = approvalCtx.toolInput?.files ?? [];
  const willPublish = resolveBlobHosting().enabled && files.some(inputFileIsHtml);
  return willPublish ? "user-approval" : "not-applicable";
};`;
  ok(sitesIn(bareTool).length === 1 && sitesIn(bareTool)[0]!.shape === "eve-approval", "synthetic-r5E: 🔴 an eve `Approval<T>` policy is SEEN, and seen as its own shape — the front door the rule could not reach");
  ok(sitesIn(bareTool)[0]!.derivedInFile === false, "synthetic-r5E: …and the file derives attendedness nowhere, which is the whole defect");
  ok(r5(bareTool).map((d) => d.rule).join() === "attendedness-eve-approval-underived", "synthetic-r5E: 🔴 …so it is RED — this is the state post_file.ts actually shipped in");
  ok(/input_required/.test(r5(bareTool)[0]!.message), "synthetic-r5E: …and the message names the consequence, so the red says why it matters rather than only what to type");

  const derivedTool = bareTool.replace(
    "  const files = approvalCtx.toolInput?.files ?? [];",
    "  if (unattendedOf(ctx)) return { type: \"denied\", reason: \"nobody is attending this run\" };\n  const files = approvalCtx.toolInput?.files ?? [];",
  );
  ok(r5(derivedTool).length === 0, "synthetic-r5E: the same policy deriving through unattendedOf(ctx) is GREEN");
  ok(sitesIn(derivedTool)[0]!.derivedInFile === true, "synthetic-r5E: …and the site records WHERE the derivation was found, so `--list` can say so");

  const returnsPolicy = `
export function connectorApprovalPolicy(): ApprovalPolicy {
  return withDuplicateApprovalGuard(connectorOpApproval());
}`;
  ok(sitesIn(returnsPolicy).length === 1 && sitesIn(returnsPolicy)[0]!.shape === "eve-approval", "synthetic-r5E: a function that RETURNS a policy is a site too — the connection-plane authoring shape");
  ok(r5(returnsPolicy).map((d) => d.rule).join() === "attendedness-eve-approval-underived", "synthetic-r5E: 🔴 …and RED with no derivation in its file");

  ok(sitesIn(`
export function withUnattendedConnectorFence(
  policy: ApprovalPolicy,
  deps: FenceDeps = {},
) {
  return policy;
}`).length === 0, "synthetic-r5E: 🔴 a PARAMETER annotated `policy: ApprovalPolicy` is not a site — it is a wrapper's input, not a policy it authors");
  ok(sitesIn(`
export function withDuplicateApprovalGuard<TInput>(
  policy: ApprovalPolicy<TInput>,
  opts?: Options,
): ApprovalPolicy<TInput>;`).length === 0, "synthetic-r5E: 🔴 an OVERLOAD SIGNATURE is not a site either — it ends in `;`, has no body, and decides nothing");

  const exemptOverloaded = `
export function withDuplicateApprovalGuard<TInput>(
  policy: ApprovalPolicy<TInput>,
  opts?: Options,
): ApprovalPolicy<TInput>;
// approval-chain: exempt — a pass-through guard that authors no verdict of its own.
export function withDuplicateApprovalGuard<TInput>(
  policy: Approval<TInput>,
  opts: Options = {},
): Approval<TInput> {
  return policy;
}`;
  ok(sitesIn(exemptOverloaded).length === 1, "synthetic-r5E: an overloaded policy factory yields exactly ONE site — its implementation, never its signatures");
  ok(sitesIn(exemptOverloaded)[0]!.exempt === true, "synthetic-r5E: 🔴 …and a marker above the DECLARATION is found, though the line above the match is a parameter");
  ok(r5(exemptOverloaded).length === 0, "synthetic-r5E: …so a stated pass-through exemption is GREEN");
  const exemptBareE = exemptOverloaded.replace(" — a pass-through guard that authors no verdict of its own.", "");
  ok(r5(exemptBareE).map((d) => d.rule).join() === "attendedness-exempt-no-reason", "synthetic-r5E: 🔴 …while a BARE marker is RED here too — the opt-out needs a reason on every shape");
  const strayMarker = `
// approval-chain: exempt — this reason belongs to the helper below, not to the policy after it.
function helper() {
  return 1;
}

const approvalPolicy: Approval<Input> = (ctx) => "user-approval";`;
  ok(sitesIn(strayMarker).length === 1 && sitesIn(strayMarker)[0]!.exempt === false, "synthetic-r5E: 🔴 a marker above a DIFFERENT declaration is not inherited — contiguity still decides");
  ok(r5(strayMarker).map((d) => d.rule).join() === "attendedness-eve-approval-underived", "synthetic-r5E: …so the underived policy after it is still RED");
  const methodPolicy = `
// approval-chain: exempt — this reason belongs to the helper, and must not reach the class below.
const helper = 1;

class Policies {
  makePolicy(
    deps: Deps,
  ): ApprovalPolicy {
    return (ctx) => "user-approval";
  }
}`;
  ok(sitesIn(methodPolicy).length === 1 && sitesIn(methodPolicy)[0]!.shape === "eve-approval", "synthetic-r5E: a policy authored as a class METHOD is still seen");
  ok(sitesIn(methodPolicy)[0]!.exempt === false, "synthetic-r5E: 🔴 …and the walk does NOT climb out of its signature to inherit the `const` above it — a laundered exemption is a silent opt-out of a security control");
  ok(r5(methodPolicy).map((d) => d.rule).join() === "attendedness-eve-approval-underived", "synthetic-r5E: …so it is RED, as an underived policy must be");
}

{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const agentDir = join(root, "packages", "core", "agent");
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "generated") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  };
  const attended = walk(agentDir).flatMap((f) => findAttendednessSites(posixRelative(root, f), readFileSync(f, "utf8")));
  const defects = checkAttendednessSites(attended);
  ok(defects.length === 0, `real-r5: every approval site derives attendedness through unattendedOf (${defects.map((d) => `${d.file}:${d.line}`).join(", ")})`);
  const proposes = attended.filter((a) => a.shape === "propose" && !a.exempt);
  ok(proposes.length >= 20, `real-r5: the propose inventory did not collapse (${proposes.length}) — zero would mean the detector went blind, not that the tools stopped proposing`);
  const at = (needle: string) => attended.find((a) => a.file.endsWith(needle));
  ok(at("tools/create_ticket.ts")?.expr === ATTENDEDNESS_DERIVATION, "real-r5: create_ticket — one of the seven that hand-rolled it — now derives through the shared function");
  ok(at("tools/rotate_webhook.ts")?.expr === ATTENDEDNESS_DERIVATION, "real-r5: rotate_webhook — one of the fourteen that passed NO bag — now derives it too");
  ok(at("spend/checkpoint.ts")?.exempt === true && (at("spend/checkpoint.ts")?.exemptReason ?? "").length >= 12, "real-r5: the non-tool checkpoint kind is exempt, and it states why");
  const flowExempt = attended.filter((a) => a.file.endsWith("approvals/flow.ts") && a.exempt);
  ok(
    flowExempt.length === 2 && flowExempt.every((a) => (a.exemptReason ?? "").length >= 12),
    "real-r5: flow.ts carries TWO exempt sites — its own fail-closed default and the routine permission card's propose — and both state why",
  );
  ok(
    at("schedules/routine-attention.ts")?.exempt === true && (at("schedules/routine-attention.ts")?.exemptReason ?? "").length >= 12,
    "real-r5: the routine check-in card's propose is exempt, and it states why",
  );
  ok(
    at("personal-watch/propose.ts")?.exempt === true && (at("personal-watch/propose.ts")?.exemptReason ?? "").length >= 12,
    "real-r5: the workflow-discovery card's propose is exempt, and it states why",
  );
  ok(attended.filter((a) => a.exempt && a.file.endsWith("personal-watch/propose.ts")).length === 2 && attended.filter((a) => a.file.endsWith("personal-watch/propose.ts")).every((a) => (a.exemptReason ?? "").length >= 12), "real-r5: the person's and the room's proposal card are both exempt, and each states why");
  ok(attended.filter((a) => a.exempt).length === 8, "real-r5: exactly eight exemptions exist — the non-tool checkpoint, the routine permission card, the routine check-in card, the person's and the room's routine proposal cards, requestApproval's own default site, the pass-through duplicate guard, and the connector tools' pass-through outbound filter. A ninth is a decision, not a detail");
  ok(
    at("connections/connector-tools.ts")?.exempt === true && (at("connections/connector-tools.ts")?.exemptReason ?? "").length >= 12,
    "real-r5: the connector tools' pass-through outbound filter is exempt, and it states why",
  );
  ok(at("access/approval-dedupe.ts")?.exempt === true && (at("access/approval-dedupe.ts")?.exemptReason ?? "").length >= 12, "real-r5: the pass-through duplicate guard is exempt, and it states why");
  const eveSites = attended.filter((a) => a.shape === "eve-approval");
  ok(eveSites.length >= 4, `real-r5E: the eve ApprovalPolicy inventory is non-empty (${eveSites.length}) — zero would mean the detector went blind, not that the tree stopped authoring policies`);
  ok(eveSites.every((a) => a.exempt || a.derivedInFile === true), `real-r5E: every eve approval site derives attendedness or states why it cannot (${eveSites.filter((a) => !a.exempt && a.derivedInFile !== true).map((a) => `${a.file}:${a.line}`).join(", ")})`);
  ok(!attended.some((a) => a.file.endsWith("tools/post_file.ts")), "real-r5: post_file is no approval site at all — it only attaches files");
  ok(eveSites.filter((a) => a.file.endsWith("connections/connector-auth.ts")).length >= 3, "real-r5E: …and the connection plane's three policy factories are seen too");
  ok(attended.filter((a) => a.file.endsWith("commands/core.ts")).length === 2, "real-r5: 🔴 BOTH slash-command propose sites are seen — they call through an injected alias, and a checker blind to that reported the file clean while both shipped with no bag");
  ok(attended.filter((a) => a.file.endsWith("commands/core.ts")).every((a) => a.expr === ATTENDEDNESS_DERIVATION_BINDING), "real-r5: …and both derive through the binding-taking twin, which is the only spelling available to a caller with no ctx");
}

{
  const sitesIn = (src: string) => findAttendednessSites("fixture.ts", src).filter((site) => site.shape === "propose");
  const defectsIn = (src: string) => checkApprovalAuthoritySites(sitesIn(src));
  const proposal = (deps: string) => `await requestApproval({ chain: { unattended: unattendedOf(ctx) } }, ${deps});`;
  ok(defectsIn(proposal(`approvalPostDeps(binding.platform)`)).some((d) => d.rule === "approval-authority-context-missing"), "real-r6: 🔴 a proposal whose deps omit the live context is RED");
  ok(defectsIn(proposal(`approvalPostDeps(binding.platform, ctx)`)).length === 0, "real-r6: passing the live tool context at the proposal site is GREEN");
  ok(defectsIn(`await requestApproval({ chain: { unattended: unattendedOf(ctx) } }, {});`).some((d) => d.rule === "approval-authority-context-missing"), "real-r6: 🔴 a direct requestApproval call with an empty deps object is SEEN and RED");
  ok(
    defectsIn(`// approval-authority: headless — slash command execution has no model turn or wake envelope.\nawait requestApproval({ chain: { unattended: unattendedFrom(binding) } }, approvalPostDeps(binding.platform));`).length === 0,
    "real-r6: a genuinely headless caller can state why no proposal authority exists",
  );
  ok(
    defectsIn(`// approval-authority: headless\nawait requestApproval({ chain: { unattended: unattendedFrom(binding) } }, approvalPostDeps(binding.platform));`).some((d) => d.rule === "approval-authority-exempt-no-reason"),
    "real-r6: a reasonless headless marker is RED",
  );

  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const agentDir = join(root, "packages", "core", "agent");
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "generated") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  };
  const sites = walk(agentDir).flatMap((f) => findAttendednessSites(posixRelative(root, f), readFileSync(f, "utf8"))).filter((site) => site.shape === "propose");
  const defects = checkApprovalAuthoritySites(sites);
  ok(defects.length === 0, `real-r6: every approvalPostDeps site carries proposal authority or states why it is headless (${defects.map((d) => `${d.file}:${d.line}`).join(", ")})`);
  ok(sites.filter((s) => !s.authorityExempt).length >= 20, `real-r6: model-turn approval inventory did not collapse (${sites.length})`);
  ok(sites.filter((s) => s.authorityExempt).length === 6, "real-r6: exactly the two slash-command callers, the routine permission proposal, the routine check-in card and the person's and the room's routine proposal cards are headless exemptions");
  ok(sites.some((s) => s.authorityExempt && s.file.endsWith("schedules/routine-attention.ts")), "real-r6: …and the check-in card's site is one of them");
  ok(sites.some((s) => s.authorityExempt && s.file.endsWith("personal-watch/propose.ts")), "real-r6: …and so is the proposal card's site");
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

// proves: AP-MOD-core-access-principal-gate-manifest, AP-PGATE-add_routine_rule-123, AP-PGATE-analytics-scope-41
// proves: AP-PGATE-approval-dedupe-88, AP-PGATE-assign-87, AP-PGATE-auth-627, AP-PGATE-auth-657
// proves: AP-PGATE-aws-identity-205, AP-PGATE-cancel_routine-57, AP-PGATE-checkpoint-562
// proves: AP-PGATE-clear_connector_override-51, AP-PGATE-clear_spend_limit-57, AP-PGATE-confirm_link-140
// proves: AP-PGATE-connector-auth-455, AP-PGATE-create_agent-110, AP-PGATE-create_routine-380
// proves: AP-PGATE-create_skill-97, AP-PGATE-create_ticket-91, AP-PGATE-declare_webhook-166, AP-PGATE-delete_skill-60
// proves: AP-PGATE-dispatch-344, AP-PGATE-dm_person-78, AP-PGATE-edit_routine-72, AP-PGATE-enable_routine-74
// proves: AP-PGATE-flow-410, AP-PGATE-flow-910, AP-PGATE-ingress-667, AP-PGATE-link_identity-73
// proves: AP-PGATE-open_pull_request-147, AP-PGATE-post_message-83, AP-PGATE-purge_memory-133
// proves: AP-PGATE-remove_routine_rule-69, AP-PGATE-request_access-206, AP-PGATE-resume-74
// proves: AP-PGATE-revoke_connector-53, AP-PGATE-revoke_credential_grant-61, AP-PGATE-revoke_routine_permissions-34
// proves: AP-PGATE-rotate_webhook-66, AP-PGATE-run_routine_now-58, AP-PGATE-set_dm_delivery-59
// proves: AP-PGATE-set_spend_limit-268, AP-PGATE-set_spend_limit-353, AP-PGATE-set_state-83
// proves: AP-PGATE-unlink_identity-38

// proves: ROSTER-lint-principal-gate
