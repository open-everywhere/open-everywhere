import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finishedRun, type ChildResult } from "../../../scripts/npm-command.js";
import {
  EVE_PATCH_CARRIERS,
  EVE_PATCH_PARTS,
  _resetEvePatchTurnCheckForTest,
  assertEvePatched,
  assertEvePatchedAtTurn,
  defaultEvePackageRoot,
  evePatchTurnCheckHasPassed,
  evePatchTurnRefusal,
  probeEvePatch,
  type EvePatchPart,
  type MarkerGlobals,
} from "../agent/access/eve-patch-probe.js";
import { EVE_RUNTIME_VERSION } from "../agent/channels/runtime-rotation.js";
import { evePatchPartMarkers } from "../agent/publish/eve-patch-pack.js";
import evePatchGate from "../agent/hooks/eve-patch-gate.js";
import type { RefusableContext } from "../agent/hooks/control-refusal.js";

// Eve 1.x declares NO boot-checked patch part. The one carried part, part 10, changes only eve's
// CLI-side evaluation of authored files. The deployed server never runs that code, and a slow build
// is no reason to refuse a wake, so part 10 plants no `…Patched` marker and has no EVE_PATCH_PARTS
// row. `test:eve-install` checks its bytes at test time.
//
// This leg pins that reality (§1), and it proves the refusal machinery is still live when a part IS
// declared (§2–§5). Each failure arm uses a SYNTHETIC declared part, so the mechanism is not vacuous
// on an empty table.

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(here, "..");
const repoRoot = join(coreRoot, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "oe-eve-patch-refusal-"));

const SYNTHETIC: EvePatchPart = {
  part: 901,
  marker: "__oeSyntheticRefusalProbePatched",
  carrier: "synthetic/absent-carrier.js",
  lost: "synthetic part declared by the refusal-mechanism test",
};
const SYNTHETIC_B: EvePatchPart = {
  part: 902,
  marker: "__oeSyntheticRefusalProbeBPatched",
  carrier: "synthetic/absent-carrier-b.js",
  lost: "second synthetic part declared by the refusal-mechanism test",
};

// Any `__oe…Patched` identifier counts, however it is assigned — the same definition as
// `evePatchPartMarkers`, which `lint:publish` and the applier use for the patch file.
const PLANTED = /__oe[A-Za-z0-9_]*Patched/g;
const plantedIn = (text: string): string[] => [...new Set([...text.matchAll(PLANTED)].map((m) => m[0]))];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(c|m)?js$/u.test(entry.name)) out.push(full);
  }
  return out;
}

try {
  // §1 — the eve 1.x reality.
  {
    ok(EVE_PATCH_PARTS.length === 0, `§1 EVE_PATCH_PARTS is EMPTY on eve ${EVE_RUNTIME_VERSION} (got ${EVE_PATCH_PARTS.map((p) => p.part).join(", ")})`);
    ok(EVE_PATCH_CARRIERS.length === 0, `§1 the carrier list is empty (got ${EVE_PATCH_CARRIERS.join(", ") || "none"})`);
    ok(
      plantedIn('x;globalThis.__oeFooPatched=!0;globalThis["__oeBarPatched"]=!0;y').join() === "__oeFooPatched,__oeBarPatched",
      "§1 scan self-check: the dist scan DOES find a `…Patched` marker, in dot AND bracket form — so a clean scan below means something",
    );
    ok(
      evePatchPartMarkers('+globalThis["__oeFooPatched"]=!0;\n').join() === "__oeFooPatched",
      "§1 scan self-check: evePatchPartMarkers DOES find a `…Patched` marker an added patch line carries",
    );

    for (const patchFile of [join(repoRoot, "patches", `eve+${EVE_RUNTIME_VERSION}.patch`), join(coreRoot, "patches", `eve+${EVE_RUNTIME_VERSION}.patch`)]) {
      const rel = patchFile.slice(repoRoot.length + 1);
      ok(existsSync(patchFile), `§1 ${rel} exists`);
      const patchText = readFileSync(patchFile, "utf8");
      const added = patchText
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .join("\n");
      ok(
        added.includes("__oeResolvesThroughInstalledPackage"),
        `§1 ${rel} carries part 10 (__oeResolvesThroughInstalledPackage) — the scan below reads a real patch, not an empty file`,
      );
      const planted = [...new Set([...evePatchPartMarkers(patchText), ...plantedIn(added)])];
      ok(
        planted.length === 0,
        `§1 🔴 ${rel} plants NO \`__oe…Patched\` boot marker (found ${planted.join(", ") || "none"}). Part 10 is CLI-side only; a marker needs an EVE_PATCH_PARTS row, and that row would turn a slow build into a refused wake`,
      );
    }

    const eveRoot = defaultEvePackageRoot();
    const boundary = join(eveRoot, "dist", "src", "internal", "authored-package-boundary.js");
    ok(
      existsSync(boundary) && readFileSync(boundary, "utf8").includes("__oeResolvesThroughInstalledPackage"),
      "§1 the installed eve carries part 10 — the dist scan below reads a PATCHED tree",
    );
    const dist = walk(join(eveRoot, "dist"));
    ok(dist.length > 0, `§1 the installed eve dist holds JS files (${dist.length})`);
    const plantedDist = dist.flatMap((file) => plantedIn(readFileSync(file, "utf8")).map((m) => `${file.slice(eveRoot.length + 1)}:${m}`));
    ok(plantedDist.length === 0, `§1 🔴 no installed eve module plants a \`__oe…Patched\` marker (found ${plantedDist.join(", ") || "none"})`);

    _resetEvePatchTurnCheckForTest();
    ok(evePatchTurnRefusal({}) === undefined, "§1 the TURN gate passes an empty bag on eve 1.x — no declared part, nothing to miss");
    _resetEvePatchTurnCheckForTest();
    ok((await probeEvePatch(defaultEvePackageRoot, {})).status === "patched", "§1 the BOOT probe passes an empty bag on eve 1.x");
    _resetEvePatchTurnCheckForTest();
  }

  // §2 — the REAL boot module, in a child process: an empty table boots; a declared, absent part refuses.
  {
    const driver = join(scratch, "boot-driver.mjs");
    writeFileSync(
      driver,
      [
        "const [probeUrl, mode, bootUrl, partJson] = process.argv.slice(2);",
        "const probe = await import(probeUrl);",
        'if (mode === "declare") probe.EVE_PATCH_PARTS.push(JSON.parse(partJson));',
        "await import(bootUrl);",
        'console.log("OE-BOOT-PASSED parts=" + probe.EVE_PATCH_PARTS.length);',
        "",
      ].join("\n"),
    );
    const probeUrl = pathToFileURL(join(coreRoot, "agent", "access", "eve-patch-probe.js")).href;
    const bootUrl = pathToFileURL(join(coreRoot, "agent", "access", "eve-patch-probe-boot.js")).href;
    const boot = (mode: "as-is" | "declare"): { status: number; output: string } => {
      try {
        const out = execFileSync("node", ["--import", "tsx", driver, probeUrl, mode, bootUrl, JSON.stringify(SYNTHETIC)], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
          timeout: 120_000,
        });
        return { status: 0, output: String(out) };
      } catch (err) {
        const e = err as ChildResult;
        return { status: finishedRun(e, "the probe boot").status, output: `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}` };
      }
    };

    const asIs = boot("as-is");
    ok(
      asIs.status === 0 && asIs.output.includes("OE-BOOT-PASSED parts=0"),
      `§2 the real boot module BOOTS this tree's eve with an empty table (exit ${asIs.status}). Output: ${asIs.output.slice(0, 400)}`,
    );

    const declared = boot("declare");
    ok(declared.status !== 0, `§2 🔴 with a declared part whose marker is absent, the real boot module exits NON-ZERO (got ${declared.status})`);
    ok(!declared.output.includes("OE-BOOT-PASSED"), "§2 the refusing process never reaches the line after the boot import");
    ok(
      declared.output.includes("this eve is UNPATCHED"),
      `§2 the non-zero exit came from the REFUSAL, not from an unrelated load failure. Output: ${declared.output.slice(0, 400)}`,
    );
    ok(declared.output.includes(`part ${SYNTHETIC.part}`), `§2 the refusing process names part ${SYNTHETIC.part}`);
    ok(declared.output.includes(SYNTHETIC.marker), "§2 the refusing process names the missing marker");
    ok(declared.output.includes(SYNTHETIC.carrier), "§2 the refusing process names the carrier it tried to load");
  }

  // §3 — the boot probe's load-and-read path: it imports the carrier, then reads the marker the carrier planted.
  {
    const g = globalThis as Record<string, unknown>;
    const fakeRoot = join(scratch, "fake-eve");
    const part: EvePatchPart = { ...SYNTHETIC, carrier: "dist/planting-carrier.mjs" };
    const absent: EvePatchPart = { ...SYNTHETIC_B, carrier: "dist/silent-carrier.mjs" };
    mkdirSync(join(fakeRoot, "dist"), { recursive: true });
    writeFileSync(join(fakeRoot, "dist", "planting-carrier.mjs"), `globalThis.${part.marker}=!0;\n`);
    writeFileSync(join(fakeRoot, "dist", "silent-carrier.mjs"), "export {};\n");
    try {
      delete g[part.marker];
      delete g[absent.marker];
      const planted = await probeEvePatch(() => fakeRoot, globalThis as MarkerGlobals, [part]);
      ok(planted.status === "patched", `§3 a carrier that plants its marker probes \`patched\` once loaded (got ${planted.status}) — negative control`);
      ok(g[part.marker] === true, "§3 the probe LOADED the carrier — the marker came from the carrier file, not from the test");

      const silent = await probeEvePatch(() => fakeRoot, globalThis as MarkerGlobals, [absent]);
      ok(silent.status === "unpatched" && silent.missing.length === 1 && silent.missing[0]?.marker === absent.marker, `§3 a carrier that plants nothing probes \`unpatched\` (got ${silent.status})`);
      await assert.rejects(
        async () => await assertEvePatched(() => fakeRoot, globalThis as MarkerGlobals, [part, absent]),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes("this eve is UNPATCHED") &&
          err.message.includes(`part ${absent.part}`) &&
          !err.message.includes(`part ${part.part} `) &&
          err.message.includes("1 of 2 required"),
        "§3 🔴 assertEvePatched THROWS for the one absent part, names it, skips the present one, and counts against the declared total",
      );
      n++;

      const unverifiable = await probeEvePatch(
        () => {
          throw new Error("no eve root");
        },
        {},
        [absent],
      );
      ok(unverifiable.status === "unverifiable", `§3 an unresolvable eve root with a declared, absent part probes \`unverifiable\` (got ${unverifiable.status})`);
    } finally {
      delete g[part.marker];
      delete g[absent.marker];
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// §4 — the turn gate's refusal against declared synthetic parts, and its process memo.
{
  const parts = [SYNTHETIC, SYNTHETIC_B];
  const full = (): MarkerGlobals => Object.fromEntries(parts.map((p) => [p.marker, true]));
  for (const part of parts) {
    _resetEvePatchTurnCheckForTest();
    assert.throws(
      () => assertEvePatchedAtTurn({ ...full(), [part.marker]: undefined }, parts),
      (err: unknown) => err instanceof Error && err.message.includes(`part ${part.part}`) && err.message.includes("1 of 2 required"),
      `§4 turn-${part.part}: the turn gate throws when ${part.marker} is absent, and names that part`,
    );
    n++;
  }
  _resetEvePatchTurnCheckForTest();
  assert.throws(
    () => assertEvePatchedAtTurn({}, parts),
    (err: unknown) => err instanceof Error && err.message.includes("2 of 2 required"),
    "§4 turn: an empty bag names both declared parts",
  );
  n++;
  assert.doesNotThrow(() => assertEvePatchedAtTurn(full(), parts), "§4 turn: a complete bag passes the gate (negative control)");
  n++;
  ok(!evePatchTurnCheckHasPassed(), "§4 🔴 turn: a pass against a list that is NOT the real table never sets the process memo");
  ok(evePatchTurnRefusal({}, parts) !== undefined, "§4 🔴 turn: so a later empty bag against that list is refused again");

  // The memo itself, on the REAL table with a synthetic row pushed into it.
  const table = EVE_PATCH_PARTS as EvePatchPart[];
  const realFull = (): MarkerGlobals => ({ [SYNTHETIC.marker]: true });
  try {
    table.push(SYNTHETIC);
    _resetEvePatchTurnCheckForTest();
    assert.throws(() => assertEvePatchedAtTurn({}), (err: unknown) => err instanceof Error && err.message.includes(`part ${SYNTHETIC.part}`), "§4 memo: the real table refuses an empty bag");
    n++;
    ok(!evePatchTurnCheckHasPassed(), "§4 memo: a refusal leaves the memo UNSET");
    assert.throws(() => assertEvePatchedAtTurn({}), "§4 🔴 memo: a FAILURE is never memoised as a pass — the next empty bag throws again");
    n++;
    assert.doesNotThrow(() => assertEvePatchedAtTurn(realFull()), "§4 memo: a complete bag passes the real table");
    n++;
    ok(evePatchTurnCheckHasPassed(), "§4 memo: a pass on the real table sets the memo");
    assert.doesNotThrow(() => assertEvePatchedAtTurn({}), "§4 memo: after a pass, the memo short-circuits — one proof holds for the process");
    n++;
    _resetEvePatchTurnCheckForTest();
    assert.throws(() => assertEvePatchedAtTurn({}), "§4 memo: after the reset, the empty bag throws again");
    n++;
  } finally {
    const at = table.indexOf(SYNTHETIC);
    if (at >= 0) table.splice(at, 1);
    _resetEvePatchTurnCheckForTest();
  }
}

// §5 — the REAL turn-gate hook cancels a turn once a part is declared in EVE_PATCH_PARTS itself.
{
  const table = EVE_PATCH_PARTS as EvePatchPart[];
  const g = globalThis as Record<string, unknown>;
  const turnStarted = (evePatchGate as unknown as { events: Record<string, (e: unknown, ctx: unknown) => Promise<void>> }).events["turn.started"]!;
  const spyCtx = (): RefusableContext & { cancels: number } => {
    const ctx = { cancels: 0, cancel: (): void => void ctx.cancels++ } as unknown as RefusableContext & { cancels: number };
    return ctx;
  };
  const warn = console.warn;
  console.warn = (): void => {};
  try {
    _resetEvePatchTurnCheckForTest();
    const healthyEmpty = spyCtx();
    await turnStarted({}, healthyEmpty);
    ok(healthyEmpty.cancels === 0, "§5 the real hook does NOT cancel on eve 1.x's empty table — the negative control");

    table.push(SYNTHETIC);
    delete g[SYNTHETIC.marker];
    _resetEvePatchTurnCheckForTest();
    const first = spyCtx();
    const second = spyCtx();
    await turnStarted({}, first);
    await turnStarted({}, second);
    ok(first.cancels === 1, "§5 🔴 with a declared, absent part, the real hook CANCELS the turn at turn.started");
    ok(second.cancels === 1, "§5 🔴 the next turn is cancelled too — a refusal is never memoised as a pass");

    g[SYNTHETIC.marker] = true;
    _resetEvePatchTurnCheckForTest();
    const patched = spyCtx();
    await turnStarted({}, patched);
    ok(patched.cancels === 0, "§5 once the declared marker is present, the real hook lets the turn through");
  } finally {
    console.warn = warn;
    const at = table.indexOf(SYNTHETIC);
    if (at >= 0) table.splice(at, 1);
    delete g[SYNTHETIC.marker];
    _resetEvePatchTurnCheckForTest();
  }
  ok(EVE_PATCH_PARTS.length === 0, "§5 the synthetic row is removed again");
}

// §6 — the wiring that carries the refusal to a real process.
const BOOT_IMPORT = "eve-patch-probe-boot.js";
for (const [file, label] of [
  [join(coreRoot, "agent/channels/unified.ts"), "core's unified wake door"],
  [join(coreRoot, "agent/channels/webhooks.ts"), "core's webhooks wake door"],
  [join(repoRoot, "agent/agent.ts"), "this deployment's agent root"],
] as const) {
  ok(
    existsSync(file) && readFileSync(file, "utf8").includes(BOOT_IMPORT),
    `§6 wiring: ${label} imports ${BOOT_IMPORT} for effect — without that line nothing runs the boot probe once a part is declared`,
  );
}
{
  const boot = readFileSync(join(coreRoot, "agent/access/eve-patch-probe-boot.ts"), "utf8");
  ok(/\n\s*throw err;\n/.test(boot), "§6 wiring: the boot module's catch RE-THROWS. §2 covers this end to end; this row names the line");
}
{
  const gate = readFileSync(join(coreRoot, "agent/hooks/eve-patch-gate.ts"), "utf8");
  const gateCode = gate
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  ok(gateCode.includes("evePatchTurnRefusal()"), "§6 wiring: the turn gate hook READS evePatchTurnRefusal — a hook that reads nothing refuses nothing");
  ok(gateCode.includes("refuseTurn("), "§6 🔴 wiring: the turn gate CALLS refuseTurn — reading the verdict and not acting on it is fail-open");
  ok(!gateCode.includes("assertEvePatchedAtTurn"), "§6 🔴 wiring: the gate does not call the THROWING face of the probe — eve swallows a hook throw, so it would refuse nothing");
  ok(/"turn\.started"/.test(gateCode), "§6 wiring: the turn gate binds `turn.started`");
  ok(!/try\s*\{/.test(gateCode), "§6 wiring: the turn gate's CODE contains no try/catch — a swallowed throw is warn-and-continue");
}
{
  const helper = readFileSync(join(coreRoot, "agent/hooks/control-refusal.ts"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  ok(/ctx\.cancel\(\)/.test(helper), "§6 wiring: refuseTurn calls ctx.cancel() — without that line every OE hook refusal is a log line and nothing else");
}

console.log(
  `\n✓ eve-patch-refusal-mechanism: ${n} assertions passed (eve ${EVE_RUNTIME_VERSION}: no boot-checked part and no planted marker; ` +
    `a synthetic declared part is refused by the REAL boot module in a child process and by the REAL turn-gate hook)\n`,
);
