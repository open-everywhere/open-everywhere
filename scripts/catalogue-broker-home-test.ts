import assert from "node:assert/strict";

import type { ConnectorCredentials } from "@open-everywhere/core/agent/access/connector-credentials.js";
import { isOperatorSecretName } from "@open-everywhere/core/agent/ops/operator-secret-roster.js";
import { registerDiscordOps } from "@open-everywhere/provider-discord/agent/ops.js";
import { registerGithubOps } from "@open-everywhere/provider-github/agent/ops.js";
import { registerLinearOps } from "@open-everywhere/provider-linear/agent/ops.js";
import { registerSlackOps } from "@open-everywhere/provider-slack/agent/ops.js";
import { loadBaseConnectorCredentials as rootCatalogues } from "../agent/access/connector-credentials.js";
import { loadBaseConnectorCredentials as templateCatalogues } from "../packages/create/template/agent/access/connector-credentials.js";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  passed++;
}

registerSlackOps();
registerDiscordOps();
registerLinearOps();
registerGithubOps();

function misHomed(catalogues: readonly ConnectorCredentials[]): { readonly wrong: readonly string[]; readonly seen: number } {
  const wrong: string[] = [];
  let seen = 0;
  for (const catalogue of catalogues) {
    for (const credential of catalogue.credentials) {
      if (credential.type !== "api-key" || !credential.secretRef || !isOperatorSecretName(credential.secretRef)) continue;
      seen++;
      if (credential.broker !== "db") wrong.push(`${catalogue.connector}/${credential.id} → ${credential.secretRef} (broker "${credential.broker}")`);
    }
  }
  return { wrong, seen };
}

for (const [label, catalogues] of [
  ["root agent/", rootCatalogues()],
  ["create template agent/", templateCatalogues()],
] as const) {
  const { wrong, seen } = misHomed(catalogues);
  ok(seen > 0, `${label}: the catalogue names at least one operator secret (anti-vacuity)`);
  ok(wrong.length === 0, `${label}: every operator-secret ref is stamped broker "db" — mis-homed: ${wrong.join("; ")}`);
}

const teams = rootCatalogues().find((c) => c.connector === "teams");
ok(teams?.credentials.every((c) => c.broker === "env" && !isOperatorSecretName(c.secretRef ?? "")), "root agent/: the Teams credentials stay env-homed (env-only secret, negative control)");

ok(isOperatorSecretName("SLACK_BOT_TOKEN") && isOperatorSecretName("DISCORD_BOT_TOKEN"), "the Slack and Discord bot tokens are registered operator secrets");

console.log(`catalogue-broker-home: ${passed} checks passed`);
