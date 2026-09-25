import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EVE_PATCH_PARTS } from "../agent/access/eve-patch-probe.js";
import {
  EVE_APPLIER_BIN,
  EVE_PATCH_DIR,
  checkEveApplierPacking,
  checkEvePatchPartTable,
  checkEveResolution,
  checkPackedEvePatchDir,
  declaresEveApplier,
  evePatchFileName,
  evePatchPartMarkers,
  evePatchSharedTargets,
  evePatchTargets,
  missingEveMarkers,
  parseEvePatchMarkers,
  parseEvePatchParts,
  patchDirArgument,
} from "../agent/publish/eve-patch-pack.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = <T>(actual: T, expected: T, label: string): void => {
  assert.deepEqual(actual, expected, label);
  n++;
};

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PIN = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { peerDependencies: { eve: string } })
  .peerDependencies.eve;
const PACKED_PATCH_DIR = join(PACKAGE_ROOT, "patches");
const PATCH_FILE = evePatchFileName(PIN);
const PATCH_BODY = readFileSync(join(PACKED_PATCH_DIR, PATCH_FILE), "utf8");

eq(evePatchFileName("1.2.3"), "eve+1.2.3.patch", "§1 the filename is `eve+<version>.patch`");
eq(PATCH_FILE, `eve+${PIN}.patch`, "§1 the packed patch is named for the eve peer pin");

const realTargets = evePatchTargets(PATCH_BODY);
ok(realTargets.length > 0, "§2 the committed patch declares at least one target file");
const realParts = realTargets.flatMap((t) => t.parts);
ok(realParts.length >= 5, `§2 the committed patch declares at least five named parts (found ${realParts.length})`);
const tickets = realParts.map((p) => p.ticket);
eq(new Set(tickets).size, tickets.length, "§2 no part is reported twice");
for (const part of realParts) {
  ok(/^OPE-\d+$/.test(part.ticket), `§2 part ticket "${part.ticket}" is an OPE identifier`);
  ok(part.title.length > 3, `§2 part ${part.ticket} carries a title (got "${part.title}")`);
  ok(!part.title.includes("==="), `§2 part ${part.ticket}'s title does not swallow the header delimiter`);
}

eq(
  parseEvePatchParts(`+// === OE PATCH (OPE-1568) — the per-hop egress fence ===`),
  [{ ticket: "OPE-1568", title: "the per-hop egress fence" }],
  "§2 the `=== OE PATCH (OPE-N) — title ===` shape parses",
);
eq(
  parseEvePatchParts(`+// --- OE UNTRUSTED OUTPUT PROJECTION (OPE-73): prose here ---`),
  [{ ticket: "OPE-73", title: "UNTRUSTED OUTPUT PROJECTION" }],
  "§2 the `--- OE TITLE (OPE-N): … ---` shape parses",
);
eq(parseEvePatchParts(`+// === END OE PATCH HELPERS ===`), [], "§2 the END marker names no ticket and is not a part");
eq(parseEvePatchParts(""), [], "§2 no header means no part — never a fabricated one");
eq(
  parseEvePatchParts(`+x// === OE PATCH (OPE-9) — a ===y// === OE PATCH (OPE-9) — b ===`).length,
  1,
  "§2 a ticket named twice on one minified line yields one part",
);

eq(
  parseEvePatchMarkers("+function __oeB(){}\n+const __oeA=1\n+__oeA"),
  ["__oeA", "__oeB"],
  "§3 markers are deduplicated and sorted",
);
eq(parseEvePatchMarkers("-function __oeGone(){}\n if(__oeContext){}"), [], "§3 a removed or context line introduces nothing");
eq(
  parseEvePatchMarkers("+++ b/node_modules/eve/__oeNotAMarker.js\n+const __oeReal=1"),
  ["__oeReal"],
  "§3 the `+++ b/…` header is not an added line",
);
const toolLoop = realTargets.find((t) => t.insidePackage === "dist/src/harness/tool-loop.js");
ok(toolLoop !== undefined, "§3 the committed patch targets eve's tool-loop.js");
ok(
  toolLoop!.markers.includes("__oeProjectToolSet"),
  "§3 tool-loop.js's markers include __oeProjectToolSet — the untrusted-projection splice",
);
ok(
  !toolLoop!.markers.includes("__oeForceContinue") && !toolLoop!.markers.includes("__oeCeilTrip"),
  "§3 no retired symbol is derived as a marker (OPE-172, OPE-407 both left the patch)",
);
for (const target of realTargets) {
  ok(
    target.insidePackage !== "" && !target.insidePackage.startsWith("node_modules/"),
    `§3 ${target.path} resolves to an eve-relative path (got "${target.insidePackage}")`,
  );
}
ok(
  realTargets.some((t) => t.parts.length === 0),
  "§3 at least one target declares no named part — the applier prints a line for it anyway",
);

eq(
  checkEveApplierPacking({ bin: { oe: "./bin/oe.js", [EVE_APPLIER_BIN]: "./bin/oe-eve-patch.js" }, files: ["dist", EVE_PATCH_DIR] }),
  [],
  "§3b a manifest that declares the applier AND packs the patch directory is clean",
);
eq(checkEveApplierPacking({ bin: { oe: "./bin/oe.js" }, files: ["dist"] }), [], "§3b a manifest with neither is clean");
ok(
  checkEveApplierPacking({ bin: { [EVE_APPLIER_BIN]: "./bin/oe-eve-patch.js" }, files: ["dist"] })[0]?.includes("omits") === true,
  "§3b an applier with no packed patch directory is refused",
);
ok(
  checkEveApplierPacking({ bin: { oe: "./bin/oe.js" }, files: ["dist", EVE_PATCH_DIR] })[0]?.includes("declares no") === true,
  "§3b a packed patch directory with no applier is refused",
);
eq(
  checkEveApplierPacking({ bin: "./bin/thing.js", files: ["dist"] }),
  [],
  "§3b a bare-string `bin` is named after the package, and no publishable OE package is named oe-eve-patch",
);
eq(checkEveApplierPacking({ bin: undefined, files: ["dist"] }), [], "§3b a package with no bin at all is clean");
ok(declaresEveApplier({ [EVE_APPLIER_BIN]: "./bin/oe-eve-patch.js" }), "§3b the predicate reads a bin map");
ok(
  !declaresEveApplier("./bin/oe-eve-patch.js"),
  "§3b a bare-string bin reads as no applier — npm names it after the PACKAGE, and the path is not the command",
);
ok(!declaresEveApplier(undefined) && !declaresEveApplier(null) && !declaresEveApplier({ oe: "./bin/oe.js" }), "§3b nothing else reads as the applier");
const coreManifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { bin: unknown; files: string[] };
eq(checkEveApplierPacking({ bin: coreManifest.bin, files: coreManifest.files }), [], "§3b @open-everywhere/core satisfies the rule");
ok(EVE_PATCH_DIR === "patches" && coreManifest.files.includes(EVE_PATCH_DIR), "§3b core's files allowlist carries the patch directory");

const declaredMarkers = EVE_PATCH_PARTS.map((part) => part.marker);
ok(declaredMarkers.length > 0, "§3c EVE_PATCH_PARTS declares at least one part");
eq(
  checkEvePatchPartTable({ declaredMarkers, patchMarkers: evePatchPartMarkers(PATCH_BODY) }),
  [],
  "§3c THIS repository's packed patch and EVE_PATCH_PARTS agree — the negative control for the two arms below",
);
ok(
  checkEvePatchPartTable({ declaredMarkers: ["__oeGhostPatched"], patchMarkers: [] })[0]?.includes("adds no such marker") === true,
  "§3c a declared part the patch does not add is refused",
);
ok(
  checkEvePatchPartTable({ declaredMarkers: [], patchMarkers: ["__oeOrphanPatched"] })[0]?.includes("no EVE_PATCH_PARTS row claims it") === true,
  "§3c a patch marker no row claims is refused",
);
eq(
  evePatchPartMarkers("+const __oeProjectToolSetPatched=true;+const __oeProjectToolSet=1"),
  ["__oeProjectToolSetPatched"],
  "§3c only the `…Patched` markers are part keys — the helper names are not",
);
for (const part of EVE_PATCH_PARTS) {
  ok(
    realTargets.some((t) => t.insidePackage === part.carrier),
    `§3c part ${part.part}'s carrier ${part.carrier} is a file the committed patch changes`,
  );
  ok(part.lost.length > 30, `§3c part ${part.part} says what is lost without it`);
}

const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const rootPatchFiles = [PATCH_FILE, "@agent-browser+eve+0.32.4.patch"];
eq(
  checkPackedEvePatchDir({
    pin: PIN,
    rootPatchFiles,
    packedPatchFiles: [PATCH_FILE],
    rootBody: "same",
    packedBody: "same",
  }),
  [],
  "§4 one matching patch, byte-identical to the root copy, is clean",
);
ok(
  checkPackedEvePatchDir({ pin: PIN, rootPatchFiles, packedPatchFiles: [PATCH_FILE], rootBody: "a", packedBody: "b" }).length === 1,
  "§4 a drifted copy is refused",
);
ok(
  checkPackedEvePatchDir({ pin: PIN, rootPatchFiles, packedPatchFiles: [], rootBody: undefined, packedBody: undefined }).length > 0,
  "§4 an empty packed directory is refused",
);
ok(
  checkPackedEvePatchDir({
    pin: PIN,
    rootPatchFiles,
    packedPatchFiles: [PATCH_FILE, "@agent-browser+eve+0.32.4.patch"],
    rootBody: "same",
    packedBody: "same",
  }).length === 1,
  "§4 a SECOND patch in the packed directory is refused — patch-package would apply it to a consumer's tree",
);
ok(
  checkPackedEvePatchDir({
    pin: "0.99.0",
    rootPatchFiles,
    packedPatchFiles: [PATCH_FILE],
    rootBody: undefined,
    packedBody: undefined,
  }).length > 0,
  "§4 a pin with no patch of its own is refused",
);
ok(checkPackedEvePatchDir({ pin: "^0.54.3", rootPatchFiles, packedPatchFiles: [], rootBody: undefined, packedBody: undefined })[0]?.includes("exact peer") === true, "§4 a range instead of an exact pin is refused by name");
eq(
  checkPackedEvePatchDir({
    pin: PIN,
    rootPatchFiles: [PATCH_FILE],
    packedPatchFiles: [PATCH_FILE],
    rootBody: readFileSync(join(REPO_ROOT, "patches", PATCH_FILE), "utf8"),
    packedBody: PATCH_BODY,
  }),
  [],
  "§4 THIS repository's packed copy is byte-identical to patches/ at the root",
);

const ROOT = "/app";
const resolved = `${ROOT}/node_modules/eve/package.json`;
eq(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: resolved,
    addressableManifest: resolved,
    installedVersion: PIN,
    pin: PIN,
  }),
  [],
  "§5 a hoisted eve at the pinned version is accepted",
);
ok(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: undefined,
    addressableManifest: undefined,
    installedVersion: undefined,
    pin: PIN,
  })[0]?.includes("no eve resolves") === true,
  "§5 no eve at all is refused by name",
);
ok(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: "/elsewhere/node_modules/eve/package.json",
    addressableManifest: undefined,
    installedVersion: PIN,
    pin: PIN,
  })[0]?.includes("OUTSIDE the project root") === true,
  "§5 an eve outside the project root is refused — the applier never rewrites bytes the project does not own",
);
const pnpmResolved = `${ROOT}/node_modules/.pnpm/eve@0.54.3/node_modules/eve/package.json`;
eq(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: pnpmResolved,
    addressableManifest: pnpmResolved,
    installedVersion: PIN,
    pin: PIN,
  }),
  [],
  "§5 the layout pnpm really produces is ACCEPTED — a symlinked entry realpaths equal to its target",
);
ok(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: pnpmResolved,
    addressableManifest: undefined,
    installedVersion: PIN,
    pin: PIN,
  })[0]?.includes("nothing is installed there") === true,
  "§5 an eve with NO top-level node_modules/eve entry is refused — patch-package can address no other path",
);
ok(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: resolved,
    addressableManifest: resolved,
    installedVersion: "0.53.0",
    pin: PIN,
  })[0]?.includes(`eve@${PIN}`) === true,
  "§5 a version mismatch is refused, naming the pin to install",
);
ok(
  checkEveResolution({
    consumerRoot: ROOT,
    resolvedManifest: "/apple/node_modules/eve/package.json",
    addressableManifest: undefined,
    installedVersion: PIN,
    pin: PIN,
  })[0]?.includes("OUTSIDE the project root") === true,
  "§5 `/apple` is not inside `/app`",
);
const twoTargets = evePatchTargets(PATCH_BODY).slice(0, 2);
eq(
  evePatchSharedTargets(twoTargets, new Map(twoTargets.map((t) => [t.insidePackage, 1]))),
  [],
  "§5b an npm install copies, so every link count is 1 and nothing is detached",
);
eq(
  evePatchSharedTargets(twoTargets, new Map([[twoTargets[0]!.insidePackage, 4], [twoTargets[1]!.insidePackage, 1]])),
  [twoTargets[0]!.insidePackage],
  "§5b a target hardlinked into a store is named, and only that one",
);
eq(
  evePatchSharedTargets(twoTargets, new Map()),
  [],
  "§5b a target whose file is not there yet is not a detach candidate — the marker check reports it instead",
);
eq(
  evePatchSharedTargets([{ path: "x", insidePackage: "", markers: [], parts: [] }], new Map([["", 9]])),
  [],
  "§5b a target outside the eve package is never detached",
);
eq(
  patchDirArgument({ consumerRoot: ROOT, packedPatchDir: `${ROOT}/node_modules/@open-everywhere/core/patches` }),
  { ok: true, value: "node_modules/@open-everywhere/core/patches" },
  "§5 the --patch-dir argument is relative to the consumer root (patch-package refuses an absolute path)",
);
eq(
  patchDirArgument({ consumerRoot: ROOT, packedPatchDir: "/linked/core/patches" }).ok,
  false,
  "§5 a packed directory outside the root has no argument to pass",
);

const require_ = createRequire(import.meta.url);
const installedEve = dirname(require_.resolve("eve/package.json"));
const patchPackageBin = join(dirname(require_.resolve("patch-package/package.json")), "index.js");
const scratch = mkdtempSync(join(tmpdir(), "oe-eve-patch-"));
try {
  const project = join(scratch, "project");
  const eveDir = join(project, "node_modules", "eve");
  mkdirSync(eveDir, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "cold-consumer", version: "1.0.0", private: true }));
  writeFileSync(join(eveDir, "package.json"), JSON.stringify({ name: "eve", version: PIN }));

  for (const target of realTargets) {
    const dest = join(eveDir, target.insidePackage);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(installedEve, target.insidePackage), dest);
  }
  const fakeCore = join(project, "node_modules", "@open-everywhere", "core");
  mkdirSync(join(fakeCore, "bin"), { recursive: true });
  cpSync(join(PACKAGE_ROOT, "package.json"), join(fakeCore, "package.json"));
  cpSync(join(PACKAGE_ROOT, "bin", "oe-eve-patch.js"), join(fakeCore, "bin", "oe-eve-patch.js"));
  cpSync(join(PACKAGE_ROOT, "patches"), join(fakeCore, "patches"), { recursive: true });
  symlinkSync(join(PACKAGE_ROOT, "dist"), join(fakeCore, "dist"), "dir");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(scratch, "node_modules"), "dir");

  const applier = join(fakeCore, "bin", "oe-eve-patch.js");
  const reverse = (): void => {
    execFileSync(
      process.execPath,
      [patchPackageBin, "--patch-dir", "node_modules/@open-everywhere/core/patches", "--reverse"],
      { cwd: project, stdio: "pipe" },
    );
  };
  const run = (): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [applier], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const markerCount = (): number => {
    let found = 0;
    for (const target of realTargets) {
      const src = readFileSync(join(eveDir, target.insidePackage), "utf8");
      for (const marker of target.markers) if (src.includes(marker)) found++;
    }
    return found;
  };
  const totalMarkers = realTargets.reduce((sum, t) => sum + t.markers.length, 0);
  ok(totalMarkers > 0, "§6 the committed patch adds at least one marker for the fixture to count");

  reverse();
  eq(markerCount(), 0, "§6a the unpatched fixture carries NONE of the patch's markers");
  const contentsBefore = new Map(realTargets.map((t) => [t.insidePackage, readFileSync(join(eveDir, t.insidePackage), "utf8")]));
  ok(
    missingEveMarkers(realTargets, contentsBefore).length === totalMarkers,
    "§6a missingEveMarkers reports every marker as missing on the unpatched tree",
  );

  const first = run();
  eq(first.code, 0, `§6b the applier exits 0 on an unpatched tree — output:\n${first.out}`);
  eq(markerCount(), totalMarkers, "§6b every marker the patch adds is in the fixture's eve afterwards");
  for (const part of realParts) {
    ok(first.out.includes(part.ticket), `§6b the applier's output names part ${part.ticket}`);
  }
  ok(
    realTargets.filter((t) => t.parts.length === 0).every((t) => first.out.includes(t.path)),
    "§6b a target with no part header is still named in the output",
  );

  const second = run();
  eq(second.code, 0, `§6c a second run on a patched tree exits 0 — output:\n${second.out}`);
  eq(markerCount(), totalMarkers, "§6c the second run left every marker in place");

  reverse();
  writeFileSync(join(eveDir, "package.json"), JSON.stringify({ name: "eve", version: "0.1.0" }));
  const mismatched = run();
  eq(mismatched.code, 1, "§6d the applier refuses an eve whose version is not the pin");
  ok(mismatched.out.includes(`eve@${PIN}`), "§6d the refusal names the pin to install");
  eq(markerCount(), 0, "§6d the refusal changed NOTHING in the fixture's eve");

  writeFileSync(join(eveDir, "package.json"), JSON.stringify({ name: "eve", version: PIN }));
  reverse();
  const storeProbe = join(scratch, "store-copy.js");
  const sharedTarget = join(eveDir, realTargets[0]!.insidePackage);
  linkSync(sharedTarget, storeProbe);
  ok(statSync(sharedTarget).nlink === 2, "§6f the fixture really shares one inode between the project and the store probe");
  const storeBefore = readFileSync(storeProbe, "utf8");
  const detached = run();
  eq(detached.code, 0, `§6f the applier exits 0 on a tree whose targets are hardlinked — output:\n${detached.out}`);
  eq(markerCount(), totalMarkers, "§6f the project's eve is patched");
  eq(readFileSync(storeProbe, "utf8"), storeBefore, "§6f the STORE copy is byte-unchanged — the shared inode was not rewritten");
  eq(statSync(sharedTarget).nlink, 1, "§6f the project's target now has its own inode");
  ok(detached.out.includes("detached 1 file(s)"), "§6f the applier says it detached the file");
  rmSync(storeProbe, { force: true });

  const repoEveBefore = readFileSync(join(installedEve, realTargets[0]!.insidePackage), "utf8");
  rmSync(eveDir, { recursive: true, force: true });
  const outside = run();
  eq(outside.code, 1, "§6e the applier refuses an eve that resolves from outside the project root");
  ok(outside.out.includes("OUTSIDE the project root"), "§6e the refusal names the containment rule it applied");
  eq(
    readFileSync(join(installedEve, realTargets[0]!.insidePackage), "utf8"),
    repoEveBefore,
    "§6e THIS repository's own eve was not touched by the refused run",
  );
} finally {
  rmSync(join(scratch, "node_modules"), { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
ok(existsSync(join(REPO_ROOT, "node_modules", "eve", "package.json")), "cleanup left this repository's node_modules intact");

console.log(`\n✓ eve-patch-applier: ${n} assertions passed (${realTargets.length} patched file(s), ${realParts.length} named part(s))\n`);
