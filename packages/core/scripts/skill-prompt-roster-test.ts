process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { registerConfig } from "../agent/access/config.js";
import { defineBundle, defineBinding } from "../agent/access/bundle.js";
import { defineDomain } from "../agent/memory/domain.js";
import { resolveSkillEntries } from "../agent/skills/scoped.js";
import { LEAN_SEAT_TOOLS } from "../agent/access/lean-seat.js";
import { HARNESS_INTERNAL_TOOLS } from "../agent/access/job-posture.js";
import { WORKER_ONLY_TOOLS_STANDING } from "../agent/access/worker-capability-index.generated.js";
import type { BindableContext } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

registerConfig({
  loadBundles: () => [defineBundle({ name: "org-tools", plugins: ["acme-plugin"] })],
  loadBindings: () => [defineBinding({ bundle: "org-tools", scope: { level: "org" } })],
  pluginRegistry: { "acme-plugin": { skills: ["granted-one"] } },
  skillContent: { "granted-one": { description: "A bundle-granted skill.", content: "# Granted\nDo the granted thing." } },
  loadDomains: () => [defineDomain({ name: "eng", reach: ["slack/T1/C_ENG"] }), defineDomain({ name: "org", match: "org" })],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_ENG" ? ["eng"] : []),
});

const leanSeatCtx: BindableContext = {
  channel: { kind: "slack", continuationToken: "oe-dom:eng:oe-sup:g1" },
  session: { auth: { current: { attributes: { oe_grain: "standing", team_id: "T1", channel_id: "C_ENG" }, principalId: "U1", principalType: "slack-user" } } },
} as BindableContext;

const workerCtx: BindableContext = {
  channel: { kind: "slack", continuationToken: "oe-dom:eng:win:t/x:oe-sup:g1" },
  session: { auth: { current: { attributes: { oe_grain: "task", team_id: "T1", channel_id: "C_ENG" }, principalId: "U1", principalType: "slack-user" } } },
} as BindableContext;

{
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const src = readFileSync(join(eveRoot, "dist/src/execution/skills/instructions.js"), "utf8");
  const catalogTools = readFileSync(join(eveRoot, "dist/src/protocol/catalog-tools.js"), "utf8");
  // eve 1.x interpolates the verb: the section says "load it with ${SKILL_TOOL_NAME}({ name }) before
  // proceeding", and SKILL_TOOL_NAME is eve__skill. Both halves are read, so a rename of either reds.
  ok(
    src.includes("load it with ${SKILL_TOOL_NAME}({ name }) before proceeding") && /\bSKILL_TOOL_NAME=`eve__skill`/.test(catalogTools),
    "pin: eve's Available-skills section instructs the model to load a listed skill with eve__skill whenever the request matches one — the ground truth this whole file gates against. If this goes red, eve's wording changed; re-derive the gate before touching anything else.",
  );
}

{
  ok(
    !LEAN_SEAT_TOOLS.has("eve__skill") && !HARNESS_INTERNAL_TOOLS.has("eve__skill"),
    "sanity: eve__skill is not on the lean standing seat's roster (LEAN_SEAT_TOOLS) — this is what makes the §1 instruction dangerous if the seat ever sees it",
  );
  ok(
    WORKER_ONLY_TOOLS_STANDING.includes("eve__skill"),
    "sanity: the GENERATED worker-capability index agrees — eve__skill is worker-only from a standing seat (independent confirmation of the same fact)",
  );
}

{
  const leanEntries = await resolveSkillEntries(leanSeatCtx);
  ok(
    leanEntries.length === 0,
    `OPE-692: a lean standing seat's skill manifest must be EMPTY (got ${JSON.stringify(leanEntries.map((e) => e.name))}) — ` +
      "otherwise eve composes the Available-skills section pinned in §1, telling this seat to call a tool (eve__skill) " +
      "that §2 proves it does not hold. This is the exact defect measured on OPE-692's own live turn.",
  );

  const workerEntries = await resolveSkillEntries(workerCtx);
  ok(
    workerEntries.length === 1 && workerEntries[0]!.name === "granted-one" && workerEntries[0]!.tier === "granted",
    `negative control: a worker (task-grain) seat resolving the SAME bundle/domain still sees "granted-one" (got ${JSON.stringify(workerEntries.map((e) => e.name))}) — proves §3's zero above is the lean-seat suppression firing, not a broken resolver returning empty for everyone`,
  );
}

console.log(`skill-prompt-roster: ${n} assertions passed`);

// proves: TOOL-eve__skill
