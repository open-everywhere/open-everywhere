import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTranscriptionRole, roleDisclosure, type TranscriptionRouteSpec } from "@open-everywhere/adapters/agent/model/transcription-routes.js";
import { LOCAL_TRANSCRIPTION, STACK_ALIASES, TRANSCRIPTION, resolveTranscription } from "../agent/model/stacks.js";
import { MODEL_STACK, TRANSCRIPTION_ROLE } from "../agent/model/models.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const catalogue = JSON.parse(readFileSync(new URL("./fixtures/stt-bakeoff/catalogue.json", import.meta.url), "utf8")) as {
  gateway: { id: string; type: string; zdr: string }[];
  deepinfra: { id: string; retention: string }[];
};

function provider(r: TranscriptionRouteSpec): string {
  if (r.via === "gateway") return `gateway:${r.id.split("/")[0]}`;
  if (r.via === "deepinfra") return "deepinfra";
  return `self-hosted:${new URL(r.baseUrl!).host}`;
}

function zdrRoute(r: TranscriptionRouteSpec): boolean {
  if (r.via === "gateway") {
    const row = catalogue.gateway.find((g) => g.id === r.id);
    return row !== undefined && row.type === "transcription" && row.zdr === "all";
  }
  if (r.via === "deepinfra") return catalogue.deepinfra.some((d) => d.id === r.id && /zero retention/i.test(d.retention));
  return true;
}

for (const alias of STACK_ALIASES) {
  const role = TRANSCRIPTION[alias];
  ok(role !== undefined && role.fallback !== undefined, `${alias}: the transcription role has a primary and a fallback route`);
  assertTranscriptionRole(role);
  ok(provider(role.primary) !== provider(role.fallback), `${alias}: primary and fallback reach different providers (${provider(role.primary)} vs ${provider(role.fallback)})`);
  for (const r of [role.primary, role.fallback]) ok(zdrRoute(r), `${alias}: ${r.via}:${r.id} is a zero-retention route in the committed catalogue rows`);
  const d = roleDisclosure(role);
  ok(d.includes(role.primary.id) && d.includes(role.fallback.id), `${alias}: the approval card's sentence names both routes`);
  ok(resolveTranscription(alias, "stack") === role, `${alias}: the resolver returns the stack's own role`);
}

{
  const routes = [LOCAL_TRANSCRIPTION.primary, ...("fallback" in LOCAL_TRANSCRIPTION ? [LOCAL_TRANSCRIPTION.fallback as TranscriptionRouteSpec] : [])];
  ok(routes.every((r) => r.via === "self-hosted"), "fully local: every route is the deployer's own server");
  assertTranscriptionRole(LOCAL_TRANSCRIPTION);
  for (const alias of STACK_ALIASES) ok(resolveTranscription(alias, "local") === LOCAL_TRANSCRIPTION, `fully local wins over ${alias}`);
}

assert.throws(() => resolveTranscription("no-such-stack", "stack"), /unknown model stack/);
passed++;
ok(TRANSCRIPTION_ROLE === resolveTranscription(MODEL_STACK), "the process's TRANSCRIPTION_ROLE follows models.stack");

const roleIds = new Set<string>(STACK_ALIASES.flatMap((a) => [TRANSCRIPTION[a].primary.id, TRANSCRIPTION[a].fallback.id]));
for (const row of catalogue.gateway) if (row.zdr !== "all") ok(!roleIds.has(row.id), `${row.id} (zdr: ${row.zdr}) is a baseline, not a route`);

console.log(`✓ transcription-role: ${passed} assertions across ${STACK_ALIASES.length} stack(s)`);
