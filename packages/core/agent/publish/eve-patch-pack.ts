import { isAbsolute, relative } from "node:path";

export interface EvePatchPart {
  readonly ticket: string;
  readonly title: string;
}

export interface EvePatchTarget {
  readonly path: string;
  readonly insidePackage: string;
  readonly markers: readonly string[];
  readonly parts: readonly EvePatchPart[];
}

export function evePatchFileName(pin: string): string {
  return `eve+${pin}.patch`;
}

export function checkEvePatchPartTable(input: {
  readonly declaredMarkers: readonly string[];
  readonly patchMarkers: readonly string[];
}): string[] {
  const problems: string[] = [];
  for (const marker of input.declaredMarkers) {
    if (input.patchMarkers.includes(marker)) continue;
    problems.push(
      `EVE_PATCH_PARTS declares \`${marker}\`, but the packed patch adds no such marker — the boot probe ` +
        `would refuse a tree this applier reported as patched. Re-roll the patch or retire the part row`,
    );
  }
  for (const marker of input.patchMarkers) {
    if (input.declaredMarkers.includes(marker)) continue;
    problems.push(
      `the packed patch adds \`${marker}\`, but no EVE_PATCH_PARTS row claims it — the boot probe does not ` +
        `read it, so that part is live in the bytes and unguarded at boot. Add its row to EVE_PATCH_PARTS`,
    );
  }
  return problems;
}

export function evePatchPartMarkers(patch: string): string[] {
  return parseEvePatchMarkers(patch).filter((m) => m.endsWith("Patched"));
}

function addedText(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

export function parseEvePatchParts(patch: string): EvePatchPart[] {
  const added = addedText(patch);
  const parts: EvePatchPart[] = [];
  const seen = new Set<string>();
  const push = (ticket: string, title: string): void => {
    if (seen.has(ticket)) return;
    seen.add(ticket);
    parts.push({ ticket, title: title.trim() });
  };
  for (const m of added.matchAll(/=== OE PATCH \((OPE-\d+)\) — (.+?) ===/g)) push(m[1]!, m[2]!);
  for (const m of added.matchAll(/--- OE ([A-Z][A-Z0-9 \-]*[A-Z]) \((OPE-\d+)/g)) push(m[2]!, m[1]!);
  return parts;
}

export function parseEvePatchMarkers(patch: string): string[] {
  return [...new Set([...addedText(patch).matchAll(/__oe[A-Za-z0-9_]+/g)].map((m) => m[0]))].sort();
}

export function evePatchTargets(body: string): EvePatchTarget[] {
  const targets: EvePatchTarget[] = [];
  const blocks = body.split(/^diff --git .*$/m).slice(1);
  for (const block of blocks) {
    const path = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1]?.trim();
    if (path === undefined) continue;
    targets.push({
      path,
      insidePackage: path.startsWith("node_modules/eve/") ? path.slice("node_modules/eve/".length) : "",
      markers: parseEvePatchMarkers(block),
      parts: parseEvePatchParts(block),
    });
  }
  return targets;
}

export const EVE_APPLIER_BIN = "oe-eve-patch";
export const EVE_PATCH_DIR = "patches";

export function declaresEveApplier(bin: unknown): boolean {
  return typeof bin === "object" && bin !== null && EVE_APPLIER_BIN in bin;
}

export function checkEveApplierPacking(input: {
  readonly bin: unknown;
  readonly files: readonly string[];
}): string[] {
  const shipsApplier = declaresEveApplier(input.bin);
  const packsPatches = input.files.includes(EVE_PATCH_DIR);
  if (shipsApplier === packsPatches) return [];
  return [
    shipsApplier
      ? `declares the \`${EVE_APPLIER_BIN}\` bin but its files allowlist omits "${EVE_PATCH_DIR}" — the applier would ship with no patch to apply`
      : `packs "${EVE_PATCH_DIR}" but declares no \`${EVE_APPLIER_BIN}\` bin — nothing in the tarball would apply it`,
  ];
}

export function checkPackedEvePatchDir(input: {
  readonly pin: string | undefined;
  readonly rootPatchFiles: readonly string[];
  readonly packedPatchFiles: readonly string[];
  readonly rootBody: string | undefined;
  readonly packedBody: string | undefined;
}): string[] {
  const problems: string[] = [];
  const { pin, rootPatchFiles, packedPatchFiles, rootBody, packedBody } = input;
  if (pin === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pin)) {
    problems.push(
      `the eve peer pin is ${pin === undefined ? "missing" : `"${pin}"`}, so the packed patch filename cannot be checked — ` +
        `a publishable manifest pins eve as an exact peer`,
    );
    return problems;
  }
  const expected = evePatchFileName(pin);
  if (packedPatchFiles.length !== 1 || packedPatchFiles[0] !== expected) {
    problems.push(
      `packages/core/patches/ must hold exactly one patch file, ${expected} (found: ${packedPatchFiles.join(", ") || "none"}). ` +
        `The applier reads only the file named for the pin, so a second file there is bytes nothing applies, and a ` +
        `filename naming another version makes the applier refuse every install. Fix: ` +
        `cp patches/${expected} packages/core/patches/`,
    );
  }
  if (!rootPatchFiles.includes(expected)) {
    problems.push(
      `patches/${expected} does not exist at the repository root — the packed copy has no source. A pin bump that leaves ` +
        `the patch filename behind makes this repository's patch-package postinstall silently skip the OE hooks ` +
          `(scripts/eve-patch-lint.ts owns that rule)`,
    );
    return problems;
  }
  if (rootBody !== undefined && packedBody !== undefined && rootBody !== packedBody) {
    problems.push(
      `packages/core/patches/${expected} is not byte-identical to patches/${expected}. The copy is what a consumer applies, ` +
        `so a drifted copy patches a consumer's eve with bytes this repository never ran. Fix: cp patches/${expected} packages/core/patches/`,
    );
  }
  return problems;
}

export function checkEveResolution(input: {
  readonly consumerRoot: string;
  readonly resolvedManifest: string | undefined;
  readonly addressableManifest: string | undefined;
  readonly installedVersion: string | undefined;
  readonly pin: string;
}): string[] {
  const problems: string[] = [];
  const { consumerRoot, resolvedManifest, addressableManifest, installedVersion, pin } = input;
  if (resolvedManifest === undefined) {
    problems.push(
      `no eve resolves from ${consumerRoot}. @open-everywhere/core declares eve@${pin} as a PEER, so the consumer installs ` +
        `it: run \`npm i eve@${pin}\` in that project, then \`npx oe-eve-patch\` again`,
    );
    return problems;
  }
  if (!isInside(consumerRoot, resolvedManifest)) {
    problems.push(
      `the resolved eve (${resolvedManifest}) is OUTSIDE the project root ${consumerRoot}. Applying a patch there would ` +
        `rewrite bytes this project does not own — a linked workspace copy, or a global install. Install eve into this ` +
        `project and run the applier again`,
    );
    return problems;
  }
  if (addressableManifest === undefined || addressableManifest !== resolvedManifest) {
    problems.push(
      `the resolved eve (${resolvedManifest}) is not the one at ${consumerRoot}/node_modules/eve` +
        `${addressableManifest === undefined ? " (nothing is installed there)" : ` (that path is ${addressableManifest})`}. ` +
        `The packed patch spells its targets \`node_modules/eve/…\` relative to the project root, so this layout cannot ` +
        `be patched by this command. A hoisted npm install is the supported ` +
        `shape; under pnpm, set \`node-linker=hoisted\` (or \`public-hoist-pattern[]=eve\`) for this project and reinstall`,
    );
    return problems;
  }
  if (installedVersion !== pin) {
    problems.push(
      `eve@${installedVersion ?? "unknown"} is installed, but @open-everywhere/core ships the patch for eve@${pin}. ` +
        `The patch's hunks derive from other bytes, so the applier refuses instead: run \`npm i eve@${pin}\` ` +
        `and try again`,
    );
  }
  return problems;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function evePatchSharedTargets(
  targets: readonly EvePatchTarget[],
  linkCounts: ReadonlyMap<string, number>,
): string[] {
  const shared: string[] = [];
  for (const target of targets) {
    if (target.insidePackage === "") continue;
    if ((linkCounts.get(target.insidePackage) ?? 1) > 1) shared.push(target.insidePackage);
  }
  return shared;
}

export function missingEveMarkers(
  targets: readonly EvePatchTarget[],
  contents: ReadonlyMap<string, string | undefined>,
): string[] {
  const problems: string[] = [];
  for (const target of targets) {
    if (target.markers.length === 0) continue;
    if (target.insidePackage === "") {
      problems.push(
        `${target.path} is not a file inside the eve package, so the applier cannot verify the ${target.markers.length} ` +
          `marker(s) the patch adds to it (${target.markers.join(", ")})`,
      );
      continue;
    }
    const src = contents.get(target.insidePackage);
    if (src === undefined) {
      problems.push(`${target.path} is not installed, so the patch cannot have applied to it`);
      continue;
    }
    for (const marker of target.markers) {
      if (src.includes(marker)) continue;
      problems.push(
        `${target.path} does not contain \`${marker}\`, which the patch adds. The patch did NOT apply, ` +
          `whatever the apply step reported`,
      );
    }
  }
  return problems;
}

export function evePatchedFilesInstalled(contents: ReadonlyMap<string, string | undefined>): string[] {
  const found: string[] = [];
  for (const [path, src] of contents) {
    if (src !== undefined && /__oe[A-Za-z0-9_]/.test(src)) found.push(path);
  }
  return found.sort();
}

export function checkPristineEve(input: {
  readonly name: string | undefined;
  readonly version: string | undefined;
  readonly pin: string;
}): string[] {
  const { name, version, pin } = input;
  if (name === "eve" && version === pin) return [];
  return [
    `the tarball npm returned for eve@${pin} holds ${name ?? "no package name"}@${version ?? "no version"}, so the ` +
      `applier did not copy it over the installed eve`,
  ];
}

export function packageManagerOf(userAgent: string | undefined): "npm" | "pnpm" | "bun" | "yarn" {
  const name = userAgent?.split("/")[0]?.trim();
  return name === "pnpm" || name === "bun" || name === "yarn" ? name : "npm";
}

export function evePatchRecovery(pin: string, manager: "npm" | "pnpm" | "bun" | "yarn" = "npm"): string {
  return (
    `Recover with two commands in the project root: ` +
    `\`node -e "require('fs').rmSync('node_modules/eve',{recursive:true,force:true})"\`, then \`${manager} install\`. ` +
    `If the project's postinstall does not run oe-eve-patch, run \`npx oe-eve-patch\` after them. The install must ` +
    `resolve eve@${pin}`
  );
}

interface EvePatchHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly beforeNoEol: boolean;
  readonly afterNoEol: boolean;
}

interface EvePatchFileBlock {
  readonly path: string;
  readonly insidePackage: string;
  readonly hunks: readonly EvePatchHunk[];
}

function parseEvePatchFileBlocks(
  body: string,
): { readonly ok: true; readonly files: EvePatchFileBlock[] } | { readonly ok: false; readonly problem: string } {
  const files: EvePatchFileBlock[] = [];
  const blocks = body.split(/^diff --git .*$/m).slice(1);
  if (blocks.length === 0) return { ok: false, problem: "the patch holds no `diff --git` block" };
  for (const block of blocks) {
    const lines = block.split("\n");
    const path = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1]?.trim();
    if (path === undefined) return { ok: false, problem: "a `diff --git` block has no `+++ b/…` header" };
    const unsupported = lines.find((l) => /^(new file mode|deleted file mode|rename from|rename to|old mode|new mode|similarity index|Binary files|GIT binary patch)/.test(l));
    if (unsupported !== undefined) {
      return { ok: false, problem: `${path}: the block carries \`${unsupported}\`, and the applier only modifies existing text files` };
    }
    const hunks: EvePatchHunk[] = [];
    let i = lines.findIndex((l) => l.startsWith("@@"));
    if (i < 0) return { ok: false, problem: `${path}: the block holds no hunk` };
    while (i < lines.length && lines[i]!.startsWith("@@")) {
      const header = lines[i]!;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
      if (m === null) return { ok: false, problem: `${path}: the hunk line \`${header.slice(0, 80)}\` is not a unified-diff hunk header` };
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      const before: string[] = [];
      const after: string[] = [];
      let beforeNoEol = false;
      let afterNoEol = false;
      let last = "";
      i++;
      while (i < lines.length && (before.length < oldCount || after.length < newCount || lines[i]!.startsWith("\\"))) {
        const line = lines[i]!;
        const text = line.slice(1);
        if (line.startsWith("\\")) {
          if (last === " " || last === "-") beforeNoEol = true;
          if (last === " " || last === "+") afterNoEol = true;
        } else if (line.startsWith(" ")) {
          before.push(text);
          after.push(text);
        } else if (line.startsWith("-")) {
          before.push(text);
        } else if (line.startsWith("+")) {
          after.push(text);
        } else {
          return { ok: false, problem: `${path}: hunk \`${header.slice(0, 80)}\` ends before the line counts its header declares` };
        }
        last = line[0]!;
        i++;
      }
      if (before.length !== oldCount || after.length !== newCount) {
        return { ok: false, problem: `${path}: hunk \`${header.slice(0, 80)}\` does not hold the line counts its header declares` };
      }
      hunks.push({ header, oldStart: Number(m[1]), newStart: Number(m[3]), before, after, beforeNoEol, afterNoEol });
    }
    const rest = lines.slice(i).find((l) => l !== "");
    if (rest !== undefined) {
      return { ok: false, problem: `${path}: a line follows the last hunk's declared line counts (\`${rest.slice(0, 80)}\`)` };
    }
    files.push({
      path,
      insidePackage: path.startsWith("node_modules/eve/") ? path.slice("node_modules/eve/".length) : "",
      hunks,
    });
  }
  return { ok: true, files };
}

const EVE_HUNK_OFFSET_WINDOW = 20;

function applyHunks(text: string, hunks: readonly EvePatchHunk[], reverse: boolean): { ok: true; text: string } | { ok: false; hunk: number } {
  const endsWithNewline = text.endsWith("\n");
  let eol = endsWithNewline;
  const lines = text === "" ? [] : (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  let delta = 0;
  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h]!;
    const expect = reverse ? hunk.after : hunk.before;
    const write = reverse ? hunk.before : hunk.after;
    const expectNoEol = reverse ? hunk.afterNoEol : hunk.beforeNoEol;
    const writeNoEol = reverse ? hunk.beforeNoEol : hunk.afterNoEol;
    const start = reverse ? hunk.newStart : hunk.oldStart;
    const base = (expect.length === 0 ? start : start - 1) + delta;
    let at = -1;
    for (let k = 0; k <= 2 * EVE_HUNK_OFFSET_WINDOW && at < 0; k++) {
      const p = base + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
      if (p < 0 || p + expect.length > lines.length) continue;
      if (!expect.every((line, j) => lines[p + j] === line)) continue;
      const reachesEnd = expect.length > 0 && p + expect.length === lines.length;
      if (reachesEnd && eol === expectNoEol) continue;
      if (!reachesEnd && expectNoEol) continue;
      at = p;
    }
    if (at < 0) return { ok: false, hunk: h };
    const reachesEnd = at + expect.length === lines.length;
    lines.splice(at, expect.length, ...write);
    if (reachesEnd && write.length > 0) eol = !writeNoEol;
    delta += write.length - expect.length;
  }
  return { ok: true, text: lines.join("\n") + (eol && lines.length > 0 ? "\n" : "") };
}

export type EvePatchApplication =
  | { readonly ok: true; readonly state: "applied"; readonly files: ReadonlyMap<string, string> }
  | { readonly ok: true; readonly state: "already-applied" }
  | { readonly ok: false; readonly problem: string };

export function applyEvePatch(body: string, contents: ReadonlyMap<string, string | undefined>): EvePatchApplication {
  const parsed = parseEvePatchFileBlocks(body);
  if (!parsed.ok) return { ok: false, problem: `the packed patch cannot be read: ${parsed.problem}` };
  const forward = new Map<string, string>();
  const failures: string[] = [];
  let allReverse = true;
  for (const file of parsed.files) {
    if (file.insidePackage === "") {
      return { ok: false, problem: `${file.path} is not a file inside the eve package, so the applier does not write it` };
    }
    const src = contents.get(file.insidePackage);
    if (src === undefined) return { ok: false, problem: `${file.path} is not installed, so the patch cannot apply to it` };
    const applied = applyHunks(src, file.hunks, false);
    if (applied.ok) {
      forward.set(file.insidePackage, applied.text);
      allReverse = false;
      continue;
    }
    const hunk = file.hunks[applied.hunk]!;
    failures.push(`${file.path}: hunk ${applied.hunk + 1} of ${file.hunks.length} (${hunk.header.slice(0, 60)}) does not apply`);
    if (!applyHunks(src, file.hunks, true).ok) allReverse = false;
  }
  if (failures.length === 0) return { ok: true, state: "applied", files: forward };
  if (allReverse) return { ok: true, state: "already-applied" };
  return {
    ok: false,
    problem:
      `the patch does not apply to the installed eve, and it is not already applied: ${failures.join("; ")}. ` +
      `The applier wrote nothing`,
  };
}
