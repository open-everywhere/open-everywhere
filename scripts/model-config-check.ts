import { getConfig } from "@open-everywhere/core/agent/access/config.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { modelTargetFor, resolvableModels } from "@open-everywhere/core/agent/model/targets.js";
import { bareModelFallbacks, bareModelRoutes, bareModelRoutesUnregistered, bareModelVia } from "@open-everywhere/core/agent/model/bare-model-via.js";
import { declaredSubagentModels } from "@open-everywhere/core/agent/ops/sovereignty-facts.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";
import { checkModelConfig, configCheckSummary } from "@open-everywhere/adapters/agent/model/model-config-check.js";
import { targetBaseUrl } from "@open-everywhere/adapters/agent/model/target-url.js";

const APP_ROOT = resolveAppRoot();
await importAppModule("agent/lib/register-config.ts", APP_ROOT);
const { MODELS, TRANSCRIPTION_ROLE } = await importAppModule<typeof import("../agent/model/models.js")>("agent/model/models.ts", APP_ROOT);

const settings = getSettings().models;
const transcription = [TRANSCRIPTION_ROLE.primary, TRANSCRIPTION_ROLE.fallback].flatMap((r) => (r?.via === "gateway" ? [{ id: r.id }] : []));
const routes = bareModelRoutes(Object.values(MODELS));
const unregisteredLeak = bareModelRoutesUnregistered(routes);
const declared = (await declaredSubagentModels(APP_ROOT)) ?? [];
const unloaded = declared.filter((b) => b.id === undefined).map((b) => b.where);
const subagents = declared.flatMap((b) => (b.id === undefined ? [] : [{ where: b.where, id: b.id }]));
const bare = subagents.map((b) => ({ id: b.id, via: bareModelVia(b.id, routes).via }));
const fallbacks = bareModelFallbacks(subagents, routes);
const models = resolvableModels([...Object.values(MODELS), ...transcription, ...bare], getConfig().loadDomains(), getConfig().loadRoles?.() ?? [], settings.force);
const result = await checkModelConfig({
  models,
  targets: settings.targets,
  policy: settings.dataPolicy,
  baseUrlFor: (via) => targetBaseUrl(via, modelTargetFor(via, settings.targets)),
  timeoutMs: 15_000,
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ met: result.met, checked: result.checked, models, findings: result.findings, bareRoutesUnregistered: unregisteredLeak, bareDefaultVia: routes.fallback, bareFallbacks: fallbacks, unloadedSubagents: unloaded }, null, 2));
} else {
  console.log(configCheckSummary(result));
  for (const f of result.findings) console.log(`  ${f.met === "no" ? "✗" : "?"} ${f.detail}`);
  if (unregisteredLeak) {
    console.log("  ✗ agent/model/models.ts does not call registerBareModelRoutes, so every bare id goes via gateway, not the targets below. Add the line from the 0.8.0 template.");
  }
  for (const b of subagents) {
    const r = bareModelVia(b.id, routes);
    console.log(r.source === "role" ? `  · ${b.where}: via ${r.via}, its role's target` : `  · ${b.where}: no role names ${b.id}, so it goes via ${r.via}, the primary role's target`);
  }
  for (const w of unloaded) console.log(`  ? ${w}: model unknown, its module did not load, so it was not checked`);
  console.log(`  · any other bare id (eve evaluate()): via ${routes.fallback}, the primary role's target`);
}
process.exit(result.met === "no" || unregisteredLeak ? 1 : 0);
