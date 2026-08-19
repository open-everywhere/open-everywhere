import assert from "node:assert/strict";
import {
  declareProviderSelection,
  providerSelection,
  providerSelectionDeclared,
  isProviderSelected,
  admitProviderRegistration,
  admitInboundSurface,
  refusedProviderRegistrations,
  clearProviderSelection,
} from "../agent/access/provider-selection.js";
import { checkProviderSelection, parseProviderManifest, UNGATED_SEAMS, type ProviderSelectionInput } from "../agent/access/provider-selection-check.js";
import { registerIdentityMapper } from "../agent/identity/binding.js";
import { registerCapabilityManifest, capabilitiesForPlatform } from "../agent/identity/capabilities.js";
import { registerPostArm, postArm, registeredPostArmPlatforms, type PostArm } from "../agent/channels/post-arms.js";
import { registerReadAdapter, supportedReadPlatforms, type ReadAdapter } from "../agent/channels/channel-read.js";
import { registerRoutineDispatch, resolveRegisteredRoutineDispatch } from "../agent/schedules/routine-dispatch.js";
import { registerNativeAdminCheck, nativeAdminCheck } from "../agent/access/native-admin.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
function firesWith(problems: string[], needle: string, label: string): void {
  ok(
    problems.some((p) => p.includes(needle)),
    `${label} (got: ${JSON.stringify(problems)})`,
  );
}

const realWarn = console.warn;
let warnings: string[] = [];
const muteWarnings = () => {
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
};
const restoreWarnings = () => {
  console.warn = realWarn;
};

clearProviderSelection();
ok(providerSelectionDeclared() === false, "undeclared: providerSelectionDeclared() is false");
ok(providerSelection() === undefined, "undeclared: providerSelection() is undefined");
ok(isProviderSelected("anything") === true, "undeclared: every provider is 'selected'");
ok(admitProviderRegistration("anything", "post-arm") === true, "undeclared: a registration is admitted");
ok(admitInboundSurface("anything") === true, "undeclared: an inbound wake is admitted");
ok(refusedProviderRegistrations().length === 0, "undeclared: nothing refused");

clearProviderSelection();
const declared = declareProviderSelection(["beta", "alpha", "alpha", "  ", " gamma "]);
ok(providerSelectionDeclared() === true, "declared: providerSelectionDeclared() is true");
assert.deepEqual(declared, ["alpha", "beta", "gamma"], "declared: normalised (trimmed, deduped, sorted)");
assert.deepEqual(providerSelection(), ["alpha", "beta", "gamma"], "declared: providerSelection() reports the same");
ok(isProviderSelected("alpha") === true, "declared: a selected provider is selected");
ok(isProviderSelected("delta") === false, "declared: an unselected provider is NOT selected");

declareProviderSelection([]);
ok(providerSelectionDeclared() === true, "empty declaration is still a declaration");
ok(isProviderSelected("alpha") === false, "empty declaration selects nothing");

declareProviderSelection(["alpha"]);
muteWarnings();
try {

const armFor = (platform: string): PostArm => ({ platform, resolveTarget: () => undefined, dispatchReply: async () => false } as unknown as PostArm);
const readerFor = (platform: string): ReadAdapter => ({ platform, read: async () => [] } as unknown as ReadAdapter);

registerIdentityMapper("alpha", () => ({ workspace: "w", surface: "s" }));
registerIdentityMapper("delta", () => ({ workspace: "leaked", surface: "leaked" }));
registerCapabilityManifest("alpha", { midTurnPost: true, reactions: true });
registerCapabilityManifest("delta", { midTurnPost: true, reactions: true });
registerPostArm(armFor("alpha"));
registerPostArm(armFor("delta"));
registerReadAdapter(readerFor("alpha"));
registerReadAdapter(readerFor("delta"));
registerRoutineDispatch("alpha", { resolveTarget: () => undefined } as never);
registerRoutineDispatch("delta", { resolveTarget: () => undefined } as never);
registerNativeAdminCheck("alpha", async () => true);
registerNativeAdminCheck("delta", async () => true);

} finally {
  restoreWarnings();
}

ok(capabilitiesForPlatform("alpha").midTurnPost === true, "selected: the capability manifest took");
ok(capabilitiesForPlatform("delta").midTurnPost === false, "UNSELECTED: no manifest row ⇒ the all-false fail-closed default");
ok(postArm("alpha") !== undefined, "selected: the post arm took");
ok(postArm("delta") === undefined, "UNSELECTED: no post arm ⇒ the reply spine refuses");
ok(registeredPostArmPlatforms().includes("delta") === false, "UNSELECTED: absent from the post-arm registry, not present-and-inert");
ok(supportedReadPlatforms().includes("alpha"), "selected: the read adapter took");
ok(supportedReadPlatforms().includes("delta") === false, "UNSELECTED: no read adapter ⇒ a read fails loud (unsupported surface)");
ok(resolveRegisteredRoutineDispatch("alpha") !== undefined, "selected: the routine dispatcher took");
ok(resolveRegisteredRoutineDispatch("delta") === undefined, "UNSELECTED: no routine dispatcher ⇒ a fire dry-runs");
ok(nativeAdminCheck("alpha") !== undefined, "selected: the native-admin check took");
ok(nativeAdminCheck("delta") === undefined, "UNSELECTED: no native-admin check ⇒ the roster verdict alone");

const refusals = refusedProviderRegistrations();
ok(
  refusals.length === 6 && refusals.every((r) => r.provider === "delta"),
  `six refusals, all for the unselected provider (got ${JSON.stringify(refusals)})`,
);
assert.deepEqual(
  [...new Set(refusals.map((r) => r.seam))].sort(),
  ["capability-manifest", "identity-mapper", "native-admin-check", "post-arm", "read-adapter", "routine-dispatch"],
  "each refusal names its seam",
);
ok(
  warnings.filter((w) => w.includes("REFUSED") && w.includes('"delta"')).length === 6,
  `each refusal warned loudly (got ${warnings.length} warning(s))`,
);

muteWarnings();
try {
ok(admitInboundSurface("alpha") === true, "inbound: a selected surface is admitted");
ok(admitInboundSurface("delta") === false, "inbound: an UNSELECTED surface is refused");
ok(admitInboundSurface("delta") === false, "inbound: still refused on a repeat");
} finally {
  restoreWarnings();
}
ok(
  warnings.filter((w) => w.includes("REFUSED an inbound wake")).length === 1,
  "inbound: the warning is deduped per provider (one loud line, not one per event)",
);

clearProviderSelection();
admitProviderRegistration("early", "entity-action-adapter");
muteWarnings();
try {
declareProviderSelection(["alpha"]);
} finally {
  restoreWarnings();
}
ok(
  warnings.some((w) => w.includes('"early"') && w.includes("BEFORE the selection was declared")),
  "ordering: a pre-declaration row for an unselected provider is reported as unretractable",
);
clearProviderSelection();
admitProviderRegistration("alpha", "entity-action-adapter");
muteWarnings();
try {
declareProviderSelection(["alpha"]);
} finally {
  restoreWarnings();
}
ok(warnings.length === 0, "ordering: a pre-declaration row for a SELECTED provider is normal ESM order, and silent");

clearProviderSelection();

const Q = '"';
const providerSpec = (id: string, rest: string) => `${Q}@open-everywhere/provider-${id}/${rest}${Q}`;
const importLine = (id: string) => `import { register${id}Provider } from ${providerSpec(id, "agent/register.js")};`;
const MANIFEST = (...ids: string[]) =>
  ids.map(importLine).join("\n") +
  "\nexport const SELECTED_PROVIDERS = [\n" +
  ids.map((id) => `  { id: "${id}", register: register${id}Provider },`).join("\n") +
  "\n];\n";
const WIRING = `declareProviderSelection(SELECTED_PROVIDER_IDS);\nfor (const p of SELECTED_PROVIDERS) { p.register(); }\n`;
const GATED_SEAM = `export function registerThing(platform: string, x: T): void {\n  if (!admitProviderRegistration(platform, "thing")) return;\n  R.set(platform, x);\n}\n`;
const UNGATED_SEAM = `export function registerThing(platform: string, x: T): void {\n  R.set(platform, x);\n}\n`;
const NEUTRAL_SEAM = `export function registerThing(fn: Fn): void {\n  R = fn;\n}\n`;

const base = (over: Partial<ProviderSelectionInput> = {}): ProviderSelectionInput => ({
  manifestSource: MANIFEST("alpha"),
  wiringSource: WIRING,
  appDependencies: ["@open-everywhere/provider-alpha"],
  coreSeams: [{ path: "channels/thing.ts", source: GATED_SEAM }],
  ...over,
});

assert.deepEqual(checkProviderSelection(base()), [], "checker: the happy shape is clean");
n++;

assert.deepEqual(
  parseProviderManifest(MANIFEST("alpha", "beta")),
  [
    { id: "alpha", registerFn: "registeralphaProvider", importedFrom: "alpha" },
    { id: "beta", registerFn: "registerbetaProvider", importedFrom: "beta" },
  ],
  "checker: the manifest parser reads rows + their imports",
);
n++;

firesWith(
  checkProviderSelection(base({ appDependencies: [] })),
  "package.json does not depend on @open-everywhere/provider-alpha",
  "checker: a selected provider must be a declared dependency",
);
firesWith(
  checkProviderSelection(base({ appDependencies: ["@open-everywhere/provider-alpha", "@open-everywhere/provider-beta"] })),
  "but roster.config.ts does not select it",
  "checker: a dependency on an unselected provider fails",
);
firesWith(
  checkProviderSelection(base({ manifestSource: "export const SELECTED_PROVIDERS = [];\n", appDependencies: [] })),
  "declares NO providers",
  "checker: an empty selection fails — an instance with no bundle can never wake on any surface",
);
firesWith(
  checkProviderSelection(base({ wiringSource: "for (const p of SELECTED_PROVIDERS) { p.register(); }\n" })),
  "never calls declareProviderSelection",
  "checker: wiring that never declares leaves core in library mode — fails",
);
firesWith(
  checkProviderSelection(base({ wiringSource: "p.register();\ndeclareProviderSelection(SELECTED_PROVIDER_IDS);\n" })),
  "registers a provider BEFORE declareProviderSelection",
  "checker: declaring after the first registration fails",
);
firesWith(
  checkProviderSelection(base({ wiringSource: `${WIRING}import x from ${providerSpec("beta", "agent/register.js")};\n` })),
  "references @open-everywhere/provider-beta directly",
  "checker: a second selection list in the wiring fails",
);

firesWith(
  checkProviderSelection(base({ coreSeams: [{ path: "channels/thing.ts", source: UNGATED_SEAM }] })),
  "never calls admitProviderRegistration",
  "checker: a provider-plane seam without the gate fails",
);
assert.deepEqual(
  checkProviderSelection(base({ coreSeams: [{ path: "channels/thing.ts", source: NEUTRAL_SEAM }] })),
  [],
  "checker: a seam that is NOT platform-keyed needs no gate",
);
n++;
firesWith(
  checkProviderSelection(
    base({ coreSeams: [{ path: "channels/thing.ts", source: `export function registerThing(impl: T): void {\n  R.set(impl.platform, impl);\n}\n` }] }),
  ),
  "never calls admitProviderRegistration",
  "checker: an object-shaped (.platform-keyed) seam without the gate fails",
);
firesWith(
  checkProviderSelection({ ...base({ coreSeams: [] }), fullCoreSweep: true }),
  `UNGATED_SEAMS names "${Object.keys(UNGATED_SEAMS)[0]}"`,
  "checker: a stale UNGATED_SEAMS row fails on a full sweep",
);
assert.deepEqual(
  checkProviderSelection(base({ coreSeams: [] })),
  [],
  "checker: a CRAFTED surface never reports the exemption table as stale",
);
n++;

console.log(`✓ provider-selection: ${n} assertions (runtime gate + fail-closed seams + inbound refusal + every checker rule)`);
