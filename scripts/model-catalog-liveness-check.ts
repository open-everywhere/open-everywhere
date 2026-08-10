import { MODELS } from "../agent/model/models.js";

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
const FETCH_TIMEOUT_MS = 15_000;

interface GatewayCatalogModel {
  readonly id?: string;
}
interface GatewayCatalogResponse {
  readonly data?: readonly GatewayCatalogModel[];
}

function configuredIds(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const [role, spec] of Object.entries(MODELS)) {
    const roles = byId.get(spec.id) ?? [];
    roles.push(role);
    byId.set(spec.id, roles);
  }
  return byId;
}

async function fetchCatalogIds(): Promise<Set<string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as GatewayCatalogResponse;
    const ids = new Set<string>();
    for (const model of body.data ?? []) {
      if (typeof model.id === "string") ids.add(model.id);
    }
    if (ids.size === 0) throw new Error("parsed zero model ids from catalog response");
    return ids;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const configured = configuredIds();

  let liveIds: Set<string>;
  try {
    liveIds = await fetchCatalogIds();
  } catch (err) {
    console.warn(
      `⚠️  SKIPPED — could not reach ${CATALOG_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.warn("   Not a finding: re-checks on the next scheduled run.");
    process.exit(0);
  }

  const missing = [...configured.entries()].filter(([id]) => !liveIds.has(id));

  if (missing.length === 0) {
    console.log(`✓ all ${configured.size} configured model id(s) are listed in the live gateway catalog.`);
    process.exit(0);
  }

  console.error(`✗ ${missing.length} configured model id(s) are NOT in the live gateway catalog:\n`);
  for (const [id, roles] of missing) {
    console.error(`  - ${id}  (agent/model/models.ts role(s): ${roles.join(", ")})`);
  }
  console.error(
    `\nA delisted/renamed id 400s every turn that routes through it — the agent stays up and` +
      ` answers nothing. Re-point the affected role(s) in agent/model/models.ts.`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("✗ model-catalog-liveness-check crashed:", err);
  process.exit(1);
});
