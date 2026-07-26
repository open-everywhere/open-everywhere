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

console.log("3 — precedence: the env is consulted BEFORE the constant:");
{
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../agent/access/capabilities.ts", import.meta.url), "utf8"),
  );
  const body = src.slice(src.indexOf("export function windowTopologyEnabled"));
  const envAt = body.indexOf("process.env[OE_WINDOW_TOPOLOGY_ENV]");
  const constAt = body.indexOf("return WINDOW_TOPOLOGY_ENABLED");
  ok(envAt >= 0, "[3] the resolver still reads process.env[OE_WINDOW_TOPOLOGY_ENV]");
  ok(constAt >= 0, "[3] the resolver still falls through to `return WINDOW_TOPOLOGY_ENABLED`");
  ok(
    envAt < constAt,
    "[3] the env read comes BEFORE the constant fallback — the constant is the DEFAULT, never the sole authority",
  );
  ok(
    !/NODE_ENV|isTest|VITEST|JEST|import\.meta\.vitest/.test(body),
    "[3] the resolver has NO test-mode guard — if one is added, the comment calling this a deployment switch must be rewritten in the same diff",
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
