import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeRangeSatisfied } from "../agent/ops/package-info.js";
import {
  CONTRACT_NODE_RANGE,
  CONTRACT_REQUIREMENT_IDS,
  CONTRACT_ROUTES,
  CONTRACT_VERSION,
  DEPLOYMENT_CONTRACT,
  anchoredRequirementIds,
  contractDocument,
  contractJsonText,
  contractProseDrift,
  contractRequirement,
} from "../agent/ops/contract.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

{
  ok(new Set(CONTRACT_REQUIREMENT_IDS).size === CONTRACT_REQUIREMENT_IDS.length, "ids: no duplicates");
  ok(
    CONTRACT_REQUIREMENT_IDS.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)),
    "ids: kebab-case, so a doc anchor and a JSON key are the same string",
  );
  ok(DEPLOYMENT_CONTRACT.length === CONTRACT_REQUIREMENT_IDS.length, "every declared id has exactly one row");
  ok(
    DEPLOYMENT_CONTRACT.every((r, i) => r.id === CONTRACT_REQUIREMENT_IDS[i]),
    "the table is in the declared id order — the payload and the docs read in one order",
  );
  ok(contractRequirement("postgres")?.title === "Postgres", "contractRequirement resolves a row by id");
  ok(contractRequirement("not-a-requirement") === undefined, "contractRequirement returns undefined for an unknown id");
}

{
  for (const r of DEPLOYMENT_CONTRACT) {
    ok(r.title.trim().length > 0, `${r.id}: has a title`);
    ok(r.requirement.trim().length > 20, `${r.id}: states what the host must provide`);
    ok(r.consequence.trim().length > 20, `${r.id}: states what breaks without it`);
    for (const route of CONTRACT_ROUTES) {
      ok((r.routes[route] ?? "").trim().length > 0, `${r.id}: answers the ${route} route`);
    }
  }
  const pg = contractRequirement("postgres");
  ok(pg !== undefined && pg.env?.includes("DATABASE_URL") === true, "postgres: cites DATABASE_URL");
  ok(
    pg !== undefined && !/OE_OPERATIONAL_PROVIDER|OE_MEMORY_PROVIDER/.test(pg.requirement),
    "postgres: the requirement demands no store selector — DATABASE_URL selects both",
  );
  const engines = (p: string): string =>
    (JSON.parse(readFileSync(p, "utf8")) as { engines?: { node?: string } }).engines?.node ?? "";
  ok(CONTRACT_NODE_RANGE === engines(join(REPO_ROOT, "package.json")), "node-24: the declared range equals the deploying app's engines.node (the binding one)");
  ok(nodeRangeSatisfied(engines(join(REPO_ROOT, "packages", "core", "package.json")), "24.0.0") === true, "node-24: …and the lowest version it admits still satisfies @open-everywhere/core's engines.node");
  ok(contractRequirement("node-24")?.requirement.includes(CONTRACT_NODE_RANGE) === true, "node-24: the row's prose names the range it declares");

  const wf = contractRequirement("workflow-storage");
  ok(wf !== undefined && wf.requirement.includes(".eve/.workflow-data"), "workflow-storage: names eve's real data directory");
  ok(wf !== undefined && wf.consequence.includes("WORKFLOW_LOCAL_DATA_DIR"), "workflow-storage: says the env var does NOT move it in a built server");
}

{
  const documented =
    readFileSync(join(REPO_ROOT, ".env.example"), "utf8") +
    readFileSync(join(REPO_ROOT, "docs", "deploy", "configuration-reference.md"), "utf8");
  for (const r of DEPLOYMENT_CONTRACT) {
    for (const name of r.env ?? []) {
      ok(/^[A-Z][A-Z0-9_]*$/.test(name), `${r.id}: ${name} is spelled as an env name`);
      ok(documented.includes(name), `${r.id}: ${name} is documented in .env.example or the configuration reference`);
    }
  }
}

{
  const doc = contractDocument();
  ok(doc.version === CONTRACT_VERSION, "document: carries the contract version");
  ok(doc.routes.length === CONTRACT_ROUTES.length, "document: carries both proven routes");
  const text = contractJsonText();
  ok(text.endsWith("\n"), "json: one trailing newline — the shape the generator writes");
  ok(contractJsonText() === text, "json: rendering is stable, so a byte compare is a real gate");
  const parsed = JSON.parse(text) as { requirements: { id: string }[] };
  ok(
    parsed.requirements.map((r) => r.id).join(",") === CONTRACT_REQUIREMENT_IDS.join(","),
    "json: round-trips to the same ids, in the same order",
  );
  ok(readFileSync(join(REPO_ROOT, "docs", "deploy", "contract.json"), "utf8") === text, "docs/deploy/contract.json holds exactly the rendered bytes");
}

{
  const page = readFileSync(join(REPO_ROOT, "docs", "deploy", "contract.md"), "utf8");
  const live = contractProseDrift(page);
  ok(live.missing.length === 0, `docs/deploy/contract.md has a section for every requirement (missing: ${live.missing.join(", ")})`);
  ok(live.unknown.length === 0, `docs/deploy/contract.md anchors no unknown id (unknown: ${live.unknown.join(", ")})`);
  ok(anchoredRequirementIds(page).length === CONTRACT_REQUIREMENT_IDS.length, "every anchor appears exactly once");

  const dropped = page.replace('<a id="req-postgres"></a>', "");
  ok(contractProseDrift(dropped).missing.includes("postgres"), "drift: a removed section is reported missing");
  const renamed = `${page}\n<a id="req-a-requirement-that-does-not-exist"></a>\n`;
  ok(
    contractProseDrift(renamed).unknown.includes("a-requirement-that-does-not-exist"),
    "drift: a section for an id the table does not define is reported unknown",
  );
}

console.log(`✓ deploy-contract: ${n} assertions passed`);
