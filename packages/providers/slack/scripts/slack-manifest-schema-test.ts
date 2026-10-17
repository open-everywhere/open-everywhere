import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { surfaceAppManifest } from "@open-everywhere/core/agent/adapter-api.js";
import { registerSlackOps } from "../agent/ops.js";
import { manifestVariants, pastedManifest, VARIANT_HOST } from "./_manifest-variants.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "slack-manifest-schema");
const SCHEMA_SOURCE = "https://raw.githubusercontent.com/slackapi/manifest-schema/v0.6.0/schemas/manifest.schema.1.0.0.json";
const SCHEMA_SHA256 = "801bb1df2246e72ea012d5feb47fc2877e610b1ecdb58e4a53b79f2c33755e49";

const schemaText = readFileSync(join(SCHEMA_DIR, "manifest.schema.1.0.0.json"), "utf8");
ok(
  createHash("sha256").update(schemaText).digest("hex") === SCHEMA_SHA256,
  `the vendored schema is Slack's own file, unedited (${SCHEMA_SOURCE}). To take a newer Slack schema, copy the file and change the pin in the same diff`,
);
ok(readFileSync(join(SCHEMA_DIR, "LICENSE"), "utf8").includes("Slack Technologies"), "Slack's MIT license ships beside the vendored schema");

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(schemaText) as object);

const schemaErrors = (doc: unknown): string =>
  validate(doc) ? "" : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`).join("; ");

const variants = manifestVariants();
ok(variants.length === 24, `the variant matrix holds 24 manifests (found ${variants.length})`);
for (const v of variants) {
  const errors = schemaErrors(v.manifest);
  ok(errors === "", `Slack's schema accepts the manifest (${v.label})${errors ? ` — ${errors}` : ""}`);
}
const asYou = variants.filter((v) => v.label.includes("with slackAsYou"));
ok(
  asYou.length === 12 && asYou.every((v) => ((v.manifest.oauth_config as { scopes: { user?: string[] } }).scopes.user?.length ?? 0) > 0),
  "the slackAsYou half of the matrix really carries user scopes, so the schema saw them",
);

registerSlackOps();
const served = surfaceAppManifest("slack", { host: VARIANT_HOST });
ok(served !== undefined, "registerSlackOps() serves a slack manifest");
const servedDoc = pastedManifest(String(served?.manifest));
{
  const errors = schemaErrors(servedDoc);
  ok(errors === "", `Slack's schema accepts the manifest surface_manifest serves${errors ? ` — ${errors}` : ""}`);
}
ok(!JSON.stringify(servedDoc).includes("YOUR-DEPLOY-URL"), "the served manifest carries the host, not the placeholder");

const base = (): Record<string, any> => structuredClone(servedDoc) as Record<string, any>;
const mutations: readonly { readonly label: string; readonly mutate: (m: Record<string, any>) => void }[] = [
  { label: "an unknown top-level key", mutate: (m) => void (m.not_a_slack_key = true) },
  { label: "a fifth suggested prompt", mutate: (m) => void (m.features.agent_view.suggested_prompts = Array.from({ length: 5 }, () => ({ title: "t", message: "m" }))) },
  { label: "an agent description past 300 characters", mutate: (m) => void (m.features.agent_view.agent_description = "d".repeat(301)) },
  { label: "a shortcut name past 24 characters", mutate: (m) => void (m.features.shortcuts[0].name = "s".repeat(25)) },
  { label: "a slash command without its slash", mutate: (m) => void (m.features.slash_commands[0].command = "oe") },
  { label: "a misspelt features key (`agent_veiw`)", mutate: (m) => void (m.features.agent_veiw = {}) },
  { label: "no display_information", mutate: (m) => void delete m.display_information },
];
for (const { label, mutate } of mutations) {
  const doc = base();
  mutate(doc);
  ok(schemaErrors(doc) !== "", `negative control: Slack's schema refuses ${label}`);
}

console.log(`✓ slack-manifest-schema: ${n} assertions passed (${variants.length} variants + the served manifest valid under Slack's schema; ${mutations.length} negative controls)`);
