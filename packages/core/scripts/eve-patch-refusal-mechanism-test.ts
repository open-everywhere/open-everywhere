import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVE_PATCH_PARTS, _resetEvePatchTurnCheckForTest, assertEvePatchedAtTurn, type MarkerGlobals } from "../agent/access/eve-patch-probe.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(here, "..");
const repoRoot = join(coreRoot, "..", "..");
const realEve = join(repoRoot, "node_modules", "eve");
const farm = mkdtempSync(join(tmpdir(), "oe-eve-patch-refusal-"));
const farmEve = join(farm, "node_modules", "eve");
const carriers = [...new Set(EVE_PATCH_PARTS.map((p) => p.carrier))];

function mirrorShadow(relDir: string): void {
  const realDir = relDir === "" ? realEve : join(realEve, relDir);
  const outDir = relDir === "" ? farmEve : join(farmEve, relDir);
  mkdirSync(outDir, { recursive: true });
  const onPath = new Set<string>();
  for (const carrier of carriers) {
    const segments = carrier.split("/");
    for (let i = 0; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      if (prefix === relDir) onPath.add(segments[i]!);
    }
  }
  for (const entry of readdirSync(realDir)) {
    if (onPath.has(entry)) {
      if (carriers.some((c) => c === (relDir === "" ? entry : `${relDir}/${entry}`))) continue;
      mirrorShadow(relDir === "" ? entry : `${relDir}/${entry}`);
      continue;
    }
    symlinkSync(join(realDir, entry), join(outDir, entry));
  }
}

function buildFarm(): void {
  mkdirSync(join(farm, "node_modules"), { recursive: true });
  for (const entry of readdirSync(join(repoRoot, "node_modules"))) {
    if (entry === "eve") continue;
    symlinkSync(join(repoRoot, "node_modules", entry), join(farm, "node_modules", entry));
  }
  mirrorShadow("");
  symlinkSync(coreRoot, join(farm, "core"));
}

function writeCarriers(dropMarker: string | null): void {
  for (const carrier of carriers) {
    let source = readFileSync(join(realEve, carrier), "utf8");
    if (dropMarker !== null && source.includes(`globalThis.${dropMarker}=!0;`)) {
      source = source.replace(`globalThis.${dropMarker}=!0;\n`, "");
    }
    writeFileSync(join(farmEve, carrier), source);
  }
}

function bootAgainstFarm(): { status: number; output: string } {
  const entry = join(farm, "core", "agent", "access", "eve-patch-probe-boot.ts");
  try {
    const out = execFileSync("node", ["--preserve-symlinks", "--preserve-symlinks-main", "--import", "tsx", entry], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 120_000,
    });
    return { status: 0, output: String(out) };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { status: typeof e.status === "number" ? e.status : -1, output: `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}` };
  }
}

try {
  buildFarm();

  writeCarriers(null);
  {
    const result = bootAgainstFarm();
    ok(
      result.status === 0,
      `boot: a fixture eve carrying all ${EVE_PATCH_PARTS.length} markers BOOTS through the real boot module ` +
        `(exit ${result.status}) — negative control; a failure here means the farm is broken, not the probe. Output: ${result.output.slice(0, 400)}`,
    );
  }

  for (const part of EVE_PATCH_PARTS) {
    writeCarriers(part.marker);
    const result = bootAgainstFarm();
    ok(result.status !== 0, `boot-${part.part}: a fixture missing ${part.marker} exits NON-ZERO (got ${result.status}) — the real boot module refuses`);
    ok(
      result.output.includes("this eve is UNPATCHED"),
      `boot-${part.part}: the non-zero exit came from the REFUSAL, not from some unrelated load failure. Output: ${result.output.slice(0, 400)}`,
    );
    ok(result.output.includes(`part ${part.part}`), `boot-${part.part}: the refusing process names part ${part.part}`);
    ok(result.output.includes(part.marker), `boot-${part.part}: the refusing process names the missing marker`);
  }
} finally {
  rmSync(farm, { recursive: true, force: true });
}

const BOOT_IMPORT = "eve-patch-probe-boot.js";
for (const [file, label] of [
  [join(coreRoot, "agent/channels/unified.ts"), "core's unified wake door"],
  [join(coreRoot, "agent/channels/webhooks.ts"), "core's webhooks wake door"],
  [join(repoRoot, "agent/agent.ts"), "this deployment's agent root"],
] as const) {
  ok(
    existsSync(file) && readFileSync(file, "utf8").includes(BOOT_IMPORT),
    `wiring: ${label} imports ${BOOT_IMPORT} for effect — without that line nothing runs the boot probe and an unpatched tree serves wakes`,
  );
}
{
  const boot = readFileSync(join(coreRoot, "agent/access/eve-patch-probe-boot.ts"), "utf8");
  ok(
    /\n\s*throw err;\n/.test(boot),
    "wiring: the boot module's catch RE-THROWS. §1 covers this end to end; this row names the line, so a deletion reds here too rather than only in a child process",
  );
}
{
  const gate = readFileSync(join(coreRoot, "agent/hooks/eve-patch-gate.ts"), "utf8");
  const gateCode = gate
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  ok(gateCode.includes("evePatchTurnRefusal()"), "wiring: the turn gate hook READS evePatchTurnRefusal — a hook that reads nothing refuses nothing");
  ok(gateCode.includes("refuseTurn("), "🔴 wiring: the turn gate CALLS refuseTurn — reading the verdict and not acting on it is the fail-open shape this ticket removes");
  ok(!gateCode.includes("assertEvePatchedAtTurn"), "🔴 wiring: the gate no longer calls the THROWING face of the probe — eve swallows a hook throw, so it would refuse nothing");
  ok(/"turn\.started"/.test(gateCode), "wiring: the turn gate binds `turn.started`");
  ok(
    !/try\s*\{/.test(gateCode),
    "wiring: the turn gate's CODE contains no try/catch — a swallowed throw is warn-and-continue, which is the behaviour this ticket removes. It reads the verdict as a value precisely so there is no catch here",
  );
}
{
  const helper = readFileSync(join(coreRoot, "agent/hooks/control-refusal.ts"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  ok(/ctx\.cancel\(\)/.test(helper), "wiring: refuseTurn calls ctx.cancel() — without that line every OE hook refusal is a log line and nothing else");
}

const fullBag = (): MarkerGlobals => Object.fromEntries(EVE_PATCH_PARTS.map((p) => [p.marker, true]));
for (const part of EVE_PATCH_PARTS) {
  _resetEvePatchTurnCheckForTest();
  const bag = { ...fullBag(), [part.marker]: undefined };
  assert.throws(
    () => assertEvePatchedAtTurn(bag),
    (err: unknown) => err instanceof Error && err.message.includes(`part ${part.part}`),
    `turn-${part.part}: the turn gate throws when ${part.marker} is absent, and names that part`,
  );
  n++;
}
{
  _resetEvePatchTurnCheckForTest();
  assert.doesNotThrow(() => assertEvePatchedAtTurn(fullBag()), "turn: a complete bag passes the gate (negative control)");
  n++;
  assert.doesNotThrow(() => assertEvePatchedAtTurn({}), "turn: after a pass, the memo short-circuits — one proof holds for the process");
  n++;
  _resetEvePatchTurnCheckForTest();
  assert.throws(() => assertEvePatchedAtTurn({}), "turn: a FAILURE is never memoised as a pass — after the reset the empty bag throws again");
  n++;
}

console.log(`\n✓ eve-patch-refusal-mechanism: ${n} assertions passed (${EVE_PATCH_PARTS.length} parts refused by the REAL boot module in a child process; wiring and turn gate pinned)\n`);
