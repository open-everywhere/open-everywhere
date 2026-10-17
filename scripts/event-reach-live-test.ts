import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-event-reach-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.DATABASE_URL;
const NAMES = ["GITHUB_WEBHOOK_SECRET", "NOTION_WEBHOOK_SECRET"];
for (const name of NAMES) delete process.env[name];

const { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } = await import("../agent/lib/providers.generated.js");
const { declareProviderSelection, overrideSettingsForTest } = await import("@open-everywhere/core/agent/adapter-api.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { registeredEventSources } = await import("@open-everywhere/core/agent/routines/event-model.js");
const { eventReach, registeredEventReachSources } = await import("@open-everywhere/core/agent/routines/event-reach.js");
const { watchableEventSources } = await import("@open-everywhere/core/agent/routines/ask-watch.js");
const { linearEventsReach } = await import("@open-everywhere/provider-linear/agent/channels/linear-event-reach.js");
const { notionEventsReach } = await import("@open-everywhere/provider-notion/agent/channels/notion-event-reach.js");
const { OperatorSecretNotSetError } = await import("@open-everywhere/core/agent/adapter-api.js");
const { removeTempDir } = await import("../packages/core/scripts/_temp-dir.js");

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}

declareProviderSelection(SELECTED_PROVIDER_IDS);
for (const provider of SELECTED_PROVIDERS) provider.register();
await import("@open-everywhere/core/agent/routines/github-normalizer.js");
await import("@open-everywhere/core/agent/webhooks/oe-standard-webhook.js");
registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] });
const noHooks = { hooks: () => [] };

console.log("§1 every vendor normalizer has a reach probe");
{
  const vendors = registeredEventSources().filter((s) => s !== "oe-standard-webhook");
  const probes = new Set(registeredEventReachSources());
  ok(vendors.length >= 3, `fixture: the live normalizers include the vendor ones (${vendors.join(", ")})`);
  const missing = vendors.filter((s) => !probes.has(s));
  ok(missing.length === 0, `🔴 every vendor event normalizer has a reach probe from the bundle that mounts its route (missing: ${missing.join(", ") || "none"})`);
}

console.log("§2 GitHub");
{
  ok((await eventReach("github", noHooks)) === "deaf", "🔴 GitHub with no webhook secret is deaf: its route 401s every delivery");
  process.env.GITHUB_WEBHOOK_SECRET = "placeholder";
  ok((await eventReach("github", noHooks)) === "reaches", "🔴 GitHub with a webhook secret reaches");
  delete process.env.GITHUB_WEBHOOK_SECRET;
  overrideSettingsForTest({ webhooks: { allowUnverifiedGithub: true } });
  ok((await eventReach("github", noHooks)) === "reaches", "GitHub with the dev hatch on reaches: the route then admits an unsigned delivery into the fan-out");
  overrideSettingsForTest({ webhooks: { allowUnverifiedGithub: false } });
  ok((await eventReach("github", noHooks)) === "deaf", "negative control: the hatch off again is deaf again");
}

console.log("§3 Linear");
{
  ok(registeredEventReachSources().includes("linear"), "fixture: the Linear bundle registered its probe");
  ok(linearEventsReach({}) === false, "🔴 Linear with no signing secret is deaf");
  ok(linearEventsReach({ LINEAR_WEBHOOK_SECRET: "placeholder" }) === true, "🔴 Linear with the primary signing secret reaches");
  const app = { LINEAR_APP_B_ORG_ID: "org-b", LINEAR_APP_B_CLIENT_ID: "id", LINEAR_APP_B_CLIENT_SECRET: "placeholder" };
  ok(linearEventsReach(app) === false, "a registered app with no webhook secret is still deaf: its deliveries are refused");
  ok(linearEventsReach({ ...app, LINEAR_APP_B_WEBHOOK_SECRET: "placeholder" }) === true, "🔴 a registered app's own webhook secret reaches");
}

console.log("§4 Notion");
{
  ok((await eventReach("notion", noHooks)) === "deaf", "🔴 Notion with no inbound secret is deaf (the unverified hatch never fires a routine)");
  process.env.NOTION_WEBHOOK_SECRET = "placeholder";
  ok((await eventReach("notion", noHooks)) === "reaches", "🔴 Notion with an inbound secret reaches");
  delete process.env.NOTION_WEBHOOK_SECRET;
  let threw = false;
  try {
    await notionEventsReach(async () => {
      throw new Error("credential key not armed");
    });
  } catch {
    threw = true;
  }
  ok(threw, "🔴 a resolver that fails in any other way than not set throws, so it reads unknown, never deaf");
  ok((await notionEventsReach(async (name) => {
    throw new OperatorSecretNotSetError(name);
  })) === false, "a secret that is set nowhere is a no");
  const twoKeys = { name: "acme", credentials: [{ connector: "notion", credential: "channel-key", use: "acme-key", inboundSecret: "ACME_NOTION_INBOUND" }] };
  registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [twoKeys as never], loadSilos: () => [], domainsForSurface: () => [] });
  const firstBroken = async (name: string) => {
    if (name === "ACME_NOTION_INBOUND") return { value: "placeholder" } as never;
    throw new Error("credential key not armed");
  };
  ok((await notionEventsReach(firstBroken)) === true, "🔴 a broken first key does not hide a second key that resolves");
  let bothBroken = false;
  try {
    await notionEventsReach(async () => {
      throw new Error("credential key not armed");
    });
  } catch {
    bothBroken = true;
  }
  ok(bothBroken, "with every key broken, the probe still throws");
  registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] });
}

console.log("§5 the seat's list follows the probes");
{
  ok(!(await watchableEventSources()).includes("github") && !(await watchableEventSources()).includes("notion"), `🔴 with no webhook configured, neither GitHub nor Notion is offered an event watch`);
  process.env.GITHUB_WEBHOOK_SECRET = "placeholder";
  ok((await watchableEventSources()).includes("github"), "🔴 with GitHub's webhook secret set, GitHub is offered");
  delete process.env.GITHUB_WEBHOOK_SECRET;
}

removeTempDir(tmp);
console.log(`✓ event-reach-live: ${n} assertions`);
