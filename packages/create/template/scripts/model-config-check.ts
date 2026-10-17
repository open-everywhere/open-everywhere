import { getConfig } from "@open-everywhere/core/agent/access/config.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { modelTargetFor, resolvableModels } from "@open-everywhere/core/agent/model/targets.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";
import { checkModelConfig, configCheckSummary } from "@open-everywhere/adapters/agent/model/model-config-check.js";
import { targetBaseUrl } from "@open-everywhere/adapters/agent/model/target-url.js";

const APP_ROOT = resolveAppRoot();
await importAppModule("agent/lib/register-config.ts", APP_ROOT);
const { MODELS, TRANSCRIPTION_ROLE } = await importAppModule<typeof import("../agent/model/models.js")>("agent/model/models.ts", APP_ROOT);

const settings = getSettings().models;
const transcription = [TRANSCRIPTION_ROLE.primary, TRANSCRIPTION_ROLE.fallback].flatMap((r) => (r?.via === "gateway" ? [{ id: r.id }] : []));
const models = resolvableModels([...Object.values(MODELS), ...transcription], getConfig().loadDomains(), getConfig().loadRoles?.() ?? [], settings.force);
const result = await checkModelConfig({
  models,
  targets: settings.targets,
  policy: settings.dataPolicy,
  baseUrlFor: (via) => targetBaseUrl(via, modelTargetFor(via, settings.targets)),
  timeoutMs: 15_000,
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ met: result.met, checked: result.checked, models, findings: result.findings }, null, 2));
} else {
  console.log(configCheckSummary(result));
  for (const f of result.findings) console.log(`  ${f.met === "no" ? "✗" : "?"} ${f.detail}`);
}
process.exit(result.met === "no" ? 1 : 0);
