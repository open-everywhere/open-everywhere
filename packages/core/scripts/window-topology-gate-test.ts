import assert from "node:assert/strict";
import {
  WINDOW_TOPOLOGY_ENABLED,
  windowTopologyEnabled,
} from "../agent/access/capabilities.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const withTopology = <T>(topology: boolean | undefined, fn: () => T): T => {
  if (topology === undefined) resetSettingsForTest();
  else registerSettings({ window: { topology } });
  try {
    return fn();
  } finally {
    resetSettingsForTest();
  }
};

console.log("1 — the shipped default is OFF (opt-in for every self-hoster):");
eq(
  WINDOW_TOPOLOGY_ENABLED,
  false,
  "[1] WINDOW_TOPOLOGY_ENABLED ships FALSE — a unified window is a wider data blast radius, so every clone inherits the narrow per-container posture and arms per-deployment. Arming one deployment by flipping this constant arms EVERYONE",
);
eq(
  withTopology(undefined, () => windowTopologyEnabled()),
  false,
  "[1] with nothing registered, the resolver returns the shipped default (OFF) — a fresh clone is native per-container",
);

console.log("2 — no environment variable reaches the gate, in either direction:");
{
  const saved = process.env.OE_WINDOW_TOPOLOGY;
  try {
    for (const raw of ["1", "true", "yes", "on", "TRUE", "  On  "]) {
      process.env.OE_WINDOW_TOPOLOGY = raw;
      eq(
        withTopology(undefined, () => windowTopologyEnabled()),
        false,
        `[2] 🔴 OE_WINDOW_TOPOLOGY=${JSON.stringify(raw)} does NOT arm the topology — the mirror is deleted, so arming appears in a diff or not at all`,
      );
    }
    for (const raw of ["0", "false", "no", "off", "OFF", " false "]) {
      process.env.OE_WINDOW_TOPOLOGY = raw;
      eq(
        withTopology(true, () => windowTopologyEnabled()),
        true,
        `[2] 🔴 OE_WINDOW_TOPOLOGY=${JSON.stringify(raw)} does NOT disarm a deployment that registered the topology — a stale variable in an env store is not a wall`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.OE_WINDOW_TOPOLOGY;
    else process.env.OE_WINDOW_TOPOLOGY = saved;
  }
}

console.log("3 — the gate reads the schema, and the schema gives this setting no env path:");
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
    capabilities.includes("SETTINGS.window.topology.shipped"),
    "[3] the constant is the SCHEMA's, not a second copy that could drift from it",
  );
  ok(
    !capabilities.includes("OE_WINDOW_TOPOLOGY_ENV") && !/process\.env\s*[.[]\s*["'`]?OE_WINDOW_TOPOLOGY/u.test(capabilities),
    "[3] 🔴 capabilities.ts neither exports the env-var-name constant nor reads the variable — the deleted route left no stub behind",
  );

  const spec = settings.slice(settings.indexOf("  window: {"));
  const windowSpec = spec.slice(0, spec.indexOf("};"));
  ok(!/env:\s*"OE_WINDOW_TOPOLOGY"/u.test(windowSpec), "[3] 🔴 the schema declares NO ops override for this setting — re-adding one goes red HERE first");
  ok(!/parseEnv/u.test(windowSpec), "[3] …and no parser, which is the structural half: there is nothing for a string to be read by");
  ok(/shipped:\s*false/u.test(windowSpec), "[3] …with the shipped default still FALSE in the schema itself");

  const resolverFrom = settings.slice(settings.indexOf("function resolve<T>"));
  const resolver = resolverFrom.slice(0, resolverFrom.indexOf("\n}") + 2);
  ok(resolver.includes("override ?? spec.shipped"), "[3] the shared resolver falls through to the registered override, then the shipped default");
  ok(
    !/NODE_ENV|isTest|VITEST|JEST|import\.meta\.vitest/.test(resolver) && !/NODE_ENV|isTest|VITEST|JEST/.test(gate),
    "[3] neither the gate nor the shared resolver has a test-mode guard — the resolution production takes is the resolution the tests take",
  );
}

console.log("4 — arming is a reviewed diff, and it works:");
eq(withTopology(true, () => windowTopologyEnabled()), true, "[4] `window: { topology: true }` in the deployment's agent/settings.ts ARMS the apparatus");
eq(withTopology(false, () => windowTopologyEnabled()), false, "[4] …and an explicit `false` disarms it, matching the shipped posture");
eq(windowTopologyEnabled(), false, "[4] …and the registration really is scoped — after the helper restores, the gate is back to the shipped OFF");

console.log("5 — the resolver re-reads on every call:");
{
  const seq = [
    withTopology(true, () => windowTopologyEnabled()),
    withTopology(false, () => windowTopologyEnabled()),
    withTopology(true, () => windowTopologyEnabled()),
    withTopology(undefined, () => windowTopologyEnabled()),
  ];
  eq(seq, [true, false, true, WINDOW_TOPOLOGY_ENABLED], "[5] four calls in one process track the registered value — no module-level cache");
}

console.log(`\nwindow-topology-gate: ${n} assertions passed.`);
