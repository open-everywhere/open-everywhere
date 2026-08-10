import assert from "node:assert/strict";
import {
  WINDOW_TOPOLOGY_ENABLED,
  OE_WINDOW_TOPOLOGY_ENV,
  windowTopologyEnabled,
} from "../agent/access/capabilities.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const prev = process.env[OE_WINDOW_TOPOLOGY_ENV];
const withEnv = <T>(raw: string | undefined, fn: () => T): T => {
  if (raw === undefined) delete process.env[OE_WINDOW_TOPOLOGY_ENV];
  else process.env[OE_WINDOW_TOPOLOGY_ENV] = raw;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[OE_WINDOW_TOPOLOGY_ENV];
    else process.env[OE_WINDOW_TOPOLOGY_ENV] = prev;
  }
};

console.log("1 — the shipped default is OFF (opt-in for every self-hoster):");
eq(
  WINDOW_TOPOLOGY_ENABLED,
  false,
  "[1] WINDOW_TOPOLOGY_ENABLED ships FALSE — a unified window is a wider data blast radius, so every clone inherits the narrow per-container posture and arms per-deployment. Arming one deployment by flipping this constant arms EVERYONE",
);
eq(
  withEnv(undefined, () => windowTopologyEnabled()),
  false,
  "[1] with no env set, the resolver returns the shipped default (OFF) — a fresh clone is native per-container",
);
eq(OE_WINDOW_TOPOLOGY_ENV, "OE_WINDOW_TOPOLOGY", "[1] the env var's name is stable (docs/deploy/configuration-reference.md and every test names this string)");

console.log("2 — the env var arms/disarms in ANY process (no test-mode guard):");
for (const raw of ["1", "true", "yes", "on", "TRUE", "  On  "]) {
  eq(
    withEnv(raw, () => windowTopologyEnabled()),
    true,
    `[2] ${OE_WINDOW_TOPOLOGY_ENV}=${JSON.stringify(raw)} ARMS the topology — a deployment-level authority that beats the shipped constant (case- and whitespace-insensitive)`,
  );
}
for (const raw of ["0", "false", "no", "off", "OFF", " false "]) {
  eq(
    withEnv(raw, () => windowTopologyEnabled()),
    false,
    `[2] ${OE_WINDOW_TOPOLOGY_ENV}=${JSON.stringify(raw)} DISARMS the topology`,
  );
}

console.log("3 — precedence: the env is consulted BEFORE the shipped default:");
{
  const fs = await import("node:fs");
  const capabilities = fs.readFileSync(new URL("../agent/access/capabilities.ts", import.meta.url), "utf8");
  const settings = fs.readFileSync(new URL("../agent/settings/settings.ts", import.meta.url), "utf8");

  const gate = capabilities.slice(capabilities.indexOf("export function windowTopologyEnabled"));
  ok(
    /getSettings\(\)\.window\.topology/u.test(gate),
    "[3] the gate resolves through getSettings().window.topology — one resolver, shared with every other behaviour switch",
  );
  ok(
    capabilities.includes("SETTINGS.window.topology.shipped") && capabilities.includes("SETTINGS.window.topology.env"),
    "[3] the constant and the env-var name are the SCHEMA's, not second copies that could drift from it",
  );

  const spec = settings.slice(settings.indexOf("  window: {"));
  ok(/env:\s*"OE_WINDOW_TOPOLOGY"/u.test(spec), "[3] the schema still declares OE_WINDOW_TOPOLOGY as this setting's ops override");
  ok(/shipped:\s*false/u.test(spec.slice(0, spec.indexOf("parseEnv"))), "[3] …with the shipped default still FALSE in the schema itself");

  const resolverFrom = settings.slice(settings.indexOf("function resolve<T>"));
  const resolver = resolverFrom.slice(0, resolverFrom.indexOf("\n}") + 2);
  const envAt = resolver.indexOf("env[spec.env]");
  const defaultAt = resolver.indexOf("override ?? spec.shipped");
  ok(envAt >= 0, "[3] the shared resolver still reads the declared env var");
  ok(defaultAt >= 0, "[3] the shared resolver still falls through to the registered override, then the shipped default");
  ok(
    envAt < defaultAt,
    "[3] the env read comes BEFORE the fallback — the shipped value is the DEFAULT, never the sole authority",
  );
  ok(
    !/NODE_ENV|isTest|VITEST|JEST|import\.meta\.vitest/.test(resolver) && !/NODE_ENV|isTest|VITEST|JEST/.test(gate),
    "[3] neither the gate nor the shared resolver has a test-mode guard — if one is added, the comment calling this a deployment switch must be rewritten in the same diff",
  );
}

console.log("4 — unrecognised and blank values defer to the shipped constant:");
for (const raw of ["", "   ", "maybe", "2", "enabled", "null", "undefined"]) {
  eq(
    withEnv(raw, () => windowTopologyEnabled()),
    WINDOW_TOPOLOGY_ENABLED,
    `[4] ${OE_WINDOW_TOPOLOGY_ENV}=${JSON.stringify(raw)} is not in the vocabulary ⇒ falls through to the constant (a typo'd value never silently arms a wider window)`,
  );
}

console.log("5 — the resolver re-reads the env on every call:");
{
  const seq = [
    withEnv("1", () => windowTopologyEnabled()),
    withEnv("0", () => windowTopologyEnabled()),
    withEnv("1", () => windowTopologyEnabled()),
    withEnv(undefined, () => windowTopologyEnabled()),
  ];
  eq(seq, [true, false, true, WINDOW_TOPOLOGY_ENABLED], "[5] four calls in one process track the env value — no module-level cache");
}

console.log(`\nwindow-topology-gate: ${n} assertions passed.`);
