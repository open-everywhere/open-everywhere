import { OPERATOR_BOX_BACKENDS, registerOperatorHolders } from "../agent/operator-holders.js";

let n = 0;
function ok(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

const g = globalThis as { [k: symbol]: unknown };
const hooks = () => g[Symbol.for("open-everywhere.credential-purge.v1")] as Map<string, unknown> | undefined;
const box = () => (g[Symbol.for("open-everywhere.long-lived-box.v1")] as { oeSlot: { backend: string } | null } | undefined)?.oeSlot ?? null;

ok(JSON.stringify(OPERATOR_BOX_BACKENDS) === JSON.stringify(["vercel", "docker"]), "the operator names one of the two backends that run a box");

const none = registerOperatorHolders();
ok(hooks()?.has("oe-oauth") && hooks()?.has("aws-sso"), "both purge hooks register in the registry core's purge reads");
ok(none.boxBackend === undefined && box() === null, "🔴 with no backend named, NO box backend registers (a guess could forget on the wrong backend)");

const docker = registerOperatorHolders({ boxBackend: "docker" });
ok(docker.boxBackend === "docker" && box()?.backend === "docker", "a named docker backend registers in the slot core's forget reads");

const vercel = registerOperatorHolders({ boxBackend: "vercel" });
ok(vercel.boxBackend === "vercel" && box()?.backend === "vercel", "a named vercel backend replaces it");

console.log(`✓ operator-holders: ${n} assertions passed`);
