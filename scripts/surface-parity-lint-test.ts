import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SURFACE_CAPABILITIES,
  checkSurfaceParity,
  declarationNote,
  isSupported,
  renderParityTable,
  type CapabilityProbe,
  type SurfaceParityDeclaration,
} from "@open-everywhere/core/agent/adapter-api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(root, "scripts", "surface-parity.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const CONTRACT = join(root, "docs", "extending", "chat-surface-contract.md");

const contractBefore = readFileSync(CONTRACT, "utf8");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
  passed++;
}

function allSupported(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of SURFACE_CAPABILITIES) out[c.id] = "supported";
  return out;
}

function problemsFor(rows: Record<string, unknown>, probes?: CapabilityProbe): readonly string[] {
  return checkSurfaceParity(new Map([["fixture", rows]]), probes).map((p) => `${p.capability ?? "-"}: ${p.message}`);
}

{
  ok(problemsFor(allSupported()).length === 0, "a complete declaration produces no problems");

  for (const c of SURFACE_CAPABILITIES) {
    const rows = allSupported();
    delete rows[c.id];
    const found = problemsFor(rows);
    ok(found.length === 1, `omitting \`${c.id}\` produces exactly one problem (got ${found.length})`);
    ok(found[0]!.startsWith(`${c.id}:`), `the problem for \`${c.id}\` names that capability`);
    ok(found[0]!.includes("does not declare"), `the problem for \`${c.id}\` says the row is unanswered`);
  }

  const extra = { ...allSupported(), "not-a-capability": "supported" };
  ok(
    problemsFor(extra).some((p) => p.startsWith("not-a-capability:")),
    "an id outside SURFACE_CAPABILITIES reds",
  );
}

{
  const reasoned = { ...allSupported(), react: { unsupported: "vendor limit — no outbound reaction write" } };
  ok(problemsFor(reasoned).length === 0, "an `unsupported` WITH a reason is accepted (control)");

  for (const empty of ["", "   ", "\t\n"]) {
    const rows = { ...allSupported(), react: { unsupported: empty } };
    const found = problemsFor(rows);
    ok(found.length === 1, `\`{ unsupported: ${JSON.stringify(empty)} }\` reds`);
    ok(found[0]!.includes("empty reason"), "…and the message says the reason is empty");
  }

  const emptyNote = { ...allSupported(), react: { supported: "  " } };
  ok(problemsFor(emptyNote).some((p) => p.includes("empty note")), "`{ supported: \"\" }` reds too");
  ok(
    problemsFor({ ...allSupported(), react: { supported: "message-level since OPE-987" } }).length === 0,
    "…while a non-empty note is accepted (control)",
  );
}

{
  for (const bad of [true, 42, null, "yes", { supported: true }, { unsupported: 1 }, { supported: "a", unsupported: "b" }, {}]) {
    const rows = { ...allSupported(), react: bad };
    ok(
      problemsFor(rows).some((p) => p.includes("not a capability declaration")),
      `\`${JSON.stringify(bad)}\` is refused as a cell value`,
    );
  }
  ok(
    checkSurfaceParity(new Map([["fixture", "supported"]])).some((p) => p.message.includes("not an object")),
    "a non-object declaration reds",
  );
}

{
  const wired: CapabilityProbe = new Map([["react", new Set(["fixture"])]]);
  const notWired: CapabilityProbe = new Map([["react", new Set<string>()]]);

  ok(problemsFor(allSupported(), wired).length === 0, "a bare `supported` the probe confirms is silent");
  ok(
    problemsFor({ ...allSupported(), react: { unsupported: "vendor limit" } }, notWired).length === 0,
    "an `unsupported` the probe confirms is silent",
  );

  const over = problemsFor(allSupported(), notWired);
  ok(over.length === 1 && over[0]!.includes("the code registers no such arm"), "an unbacked `supported` reds");

  const under = problemsFor({ ...allSupported(), react: { unsupported: "not built yet — OPE-1502" } }, wired);
  ok(under.length === 1 && under[0]!.includes("DOES register that arm"), "a wired capability declared unsupported reds");

  ok(
    problemsFor({ ...allSupported(), react: { supported: "inline — a transport this probe does not read" } }, notWired).length === 0,
    "a qualified `supported` is exempt from the overclaim arm",
  );

  ok(problemsFor(allSupported(), new Map()).length === 0, "a row with no probe is not probed");
}

{
  ok(isSupported("supported") && isSupported({ supported: "x" }), "both supported shapes read as supported");
  ok(!isSupported({ unsupported: "x" }), "an unsupported cell does not read as supported");
  ok(declarationNote("supported") === undefined, "a bare `supported` carries no note");
  ok(declarationNote({ supported: "x" }) === "x" && declarationNote({ unsupported: "y" }) === "y", "the note/reason reads back");
}

{
  const decl = {
    ...allSupported(),
    react: { unsupported: "vendor limit — no outbound write" },
    reply: { supported: "over the bundle's own arm" },
  } as unknown as SurfaceParityDeclaration;
  const table = renderParityTable("verb", new Map([["fixture", decl]]), ["fixture"]);
  ok(table.includes("| ❌ vendor limit — no outbound write |"), "an unsupported cell renders ❌ with its reason");
  ok(table.includes("| ✅ over the bundle's own arm |"), "a qualified supported cell renders ✅ with its note");
  ok(table.includes("| `no_reply` §4.4 | ✅ |"), "a bare supported cell renders a plain ✅");

  const hostile = {
    ...allSupported(),
    react: { unsupported: "a | b" },
    reply: { supported: "line one\n  line two" },
  } as unknown as SurfaceParityDeclaration;
  const escaped = renderParityTable("verb", new Map([["fixture", hostile]]), ["fixture"]);
  ok(escaped.includes("❌ a \\| b"), "a pipe in a reason is escaped");
  ok(!escaped.includes("❌ a | b"), "…so it cannot end the cell early");
  ok(escaped.includes("✅ line one line two"), "a newline in a note is collapsed to a space");
  ok(escaped.split("\n").length === 2 + SURFACE_CAPABILITIES.filter((c) => c.group === "verb").length, "…so the row count is unchanged");
  ok(!table.includes("Identity mapper"), "a group's table carries only that group's rows");
  ok(
    renderParityTable("verb", new Map(), ["fixture"]).includes("⚠️ no declaration"),
    "a missing declaration renders a visible warning, never a blank cell",
  );
}

function gate(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, GATE, ...args], { cwd: root, encoding: "utf8", env: { ...process.env } });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const green = gate("--check");
ok(green.code === 0, `the real gate passes on the tracked tree (exit ${green.code})\n${green.out}`);
ok(green.out.includes("ambient-engagement-seam"), "the gate prints the matrix on a green run");
ok(/\d+ capabilities × 8 surfaces/.test(green.out), "…with the cell count (eight since OPE-2442 added Google Chat)");
ok(/12 row\(s\) cross-checked against the live registries/.test(green.out), "the gate reports the registry-probed rows it ran");
ok(
  /4 \(ambient-engagement-seam, owned-thread-ingress, engaged-row-promotion, seat-context-admission\) against the bundle sources/.test(green.out),
  "…and names the four that read the bundle sources, not registries alone",
);
ok(
  /judge-lift notice renders on all 8 post-arm platform\(s\)/.test(green.out),
  "the gate states the judge-lift totality claim it checked, and over all eight post-arm platforms",
);

{
  const scratch = mkdtempSync(join(tmpdir(), "oe-surface-parity-"));
  try {
    const original = readFileSync(CONTRACT, "utf8");
    const copy = join(scratch, "chat-surface-contract.md");

    writeFileSync(copy, original);
    ok(gate("--check", "--contract", copy).code === 0, "the gate passes over an untouched copy (control)");

    const perturbed = original.replace("| Identity mapper §2.1 | ✅ |", "| Identity mapper §2.1 | ❌ gone |");
    ok(perturbed !== original, "the perturbation matched a generated cell");
    writeFileSync(copy, perturbed);
    const red = gate("--check", "--contract", copy);
    ok(red.code === 1, `an edited generated table reds the gate (exit ${red.code})`);
    ok(red.out.includes("out of date with the provider"), "…and the message points at the declarations");

    const renumbered = original.replace("### 7.4 The file-attach finding", "### 7.9 The file-attach finding");
    ok(renumbered !== original, "the heading perturbation matched");
    writeFileSync(copy, renumbered);
    const dangling = gate("--check", "--contract", copy);
    ok(dangling.code === 1, `a roster row pointing at a missing heading reds the gate (exit ${dangling.code})`);
    ok(dangling.out.includes("post_file → §7.4"), "…and names the row and the section it cannot find");

    writeFileSync(copy, original.replace("### 7.4 The file-attach finding", "### 7.4.1 The file-attach finding"));
    const childOnly = gate("--check", "--contract", copy);
    ok(childOnly.code === 1, "a child heading (§7.4.1) does not answer for §7.4");
    ok(childOnly.out.includes("post_file → §7.4"), "…and reds for that row, not for some other cause");

    writeFileSync(copy, original.split("<!-- BEGIN GENERATED: surface-parity-verbs").join("<!-- gone "));
    const noMarker = gate("--check", "--contract", copy);
    ok(noMarker.code === 1, "a missing marker pair reds the gate");
    ok(noMarker.out.includes("surface-parity-verbs` markers"), "…and names the region whose markers went missing");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

ok(readFileSync(CONTRACT, "utf8") === contractBefore, "the tracked contract is byte-identical — this suite wrote only into scratch");

{
  const refused = gate("--contract", join(tmpdir(), "nowhere.md"));
  ok(refused.code === 1, "`--contract` without `--check` is refused");
  ok(refused.out.includes("requires --check"), "…and says why");
}

console.log(`✓ surface-parity-lint: ${passed} assertions`);
