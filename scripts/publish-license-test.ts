import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import {
  LICENSE_FILE,
  NOTICE_FILE,
  checkNoticeModifications,
  checkPackageLicense,
  checkPackageNotice,
  checkTarballLicense,
  noticeClaimsLicenseFile,
  noticeModifications,
  patchTargets,
} from "./publish-license.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const GRANT = "Apache License\nVersion 2.0\n";
const NOTICE_WITH_CLAIM = "This product is licensed under the Apache License, Version 2.0 (see LICENSE).\n";
const NOTICE_WITHOUT_CLAIM = "This product is licensed under the Apache License, Version 2.0.\n";
const clean = { notice: NOTICE_WITH_CLAIM, license: GRANT, rootLicense: GRANT, files: ["dist", LICENSE_FILE, "NOTICE"] };

ok(noticeClaimsLicenseFile(NOTICE_WITH_CLAIM), "a NOTICE that says 'see LICENSE' claims a licence file");
ok(noticeClaimsLicenseFile(NOTICE_WITHOUT_CLAIM) === false, "a NOTICE that only names the licence claims no file");

ok(checkPackageLicense(clean).length === 0, "a package that ships the grant and lists it is clean");

const missing = checkPackageLicense({ ...clean, license: undefined });
ok(missing.length === 1, "a package with no LICENSE file fails");
ok(/NOTICE tells the reader to see one/u.test(missing[0]), "the failure names the NOTICE's broken promise");

const missingNoClaim = checkPackageLicense({ ...clean, license: undefined, notice: NOTICE_WITHOUT_CLAIM });
ok(missingNoClaim.length === 1, "the licence text is required even when the NOTICE promises no file");
ok(/NOTICE tells the reader/u.test(missingNoClaim[0]) === false, "that failure does not claim a promise the NOTICE never made");

const drifted = checkPackageLicense({ ...clean, license: `${GRANT}and one extra clause\n` });
ok(drifted.length === 1 && /differs from the repository/u.test(drifted[0]), "a package whose grant differs from the root grant fails");

const unlisted = checkPackageLicense({ ...clean, files: ["dist", "NOTICE"] });
ok(unlisted.length === 1 && /files allowlist/u.test(unlisted[0]), "a files allowlist that omits LICENSE fails");

ok(checkPackageLicense({ ...clean, license: undefined, files: ["dist"] }).length === 2, "both source-tree arms report together");

ok(checkTarballLicense(["dist/index.js", LICENSE_FILE, "NOTICE"]).length === 0, "a tarball carrying the licence is clean");
ok(checkTarballLicense(["dist/index.js", "NOTICE"]).length === 1, "a tarball with no licence fails");
ok(checkTarballLicense(["dist/LICENSE"]).length === 1, "a licence buried under a directory does not count — npm reads the package root");

const PATCH = [
  "diff --git a/node_modules/eve/dist/a.js b/node_modules/eve/dist/a.js",
  "--- a/node_modules/eve/dist/a.js",
  "+++ b/node_modules/eve/dist/a.js",
  "@@ -1 +1 @@",
  "+++x",
  "diff --git a/node_modules/eve/dist/b.js b/node_modules/eve/dist/b.js",
  "--- a/node_modules/eve/dist/b.js",
  "+++ b/node_modules/eve/dist/b.js",
  "",
].join("\n");
const noticeFor = (count: string, files: readonly string[]): string =>
  `Intro\n\n---\n\nModifications to eve\n\nThe patch modifies ${count} files of eve 0.54.3:\n\n${files.map((f) => `  ${f}`).join("\n")}\n\n  indented prose is not a path\n\n---\n\n  dist/outside.js\n`;

ok(patchTargets(PATCH).join(",") === "dist/a.js,dist/b.js", "patch targets are the +++ paths with the eve prefix stripped, and an added '++x' line is not a target");
ok(patchTargets("+++ b/node_modules/other/x.js\n")[0] === "b/node_modules/other/x.js", "a target outside eve stays whole, so it cannot match a NOTICE line");
ok(noticeModifications("no section here\n") === undefined, "a NOTICE with no modifications section reads as none");
ok(noticeModifications(noticeFor("two", ["dist/a.js", "dist/b.js"]))?.files.join(",") === "dist/a.js,dist/b.js", "the section's path lines end at the next ---, and multi-word indented lines are not paths");
ok(checkNoticeModifications(noticeFor("two", ["dist/a.js", "dist/b.js"]), PATCH).length === 0, "a NOTICE that names every patched file, in patch order, with the right count, is clean");

const dropped = checkNoticeModifications(noticeFor("one", ["dist/a.js"]), PATCH);
ok(dropped.length === 2 && /does not name dist\/b\.js/u.test(dropped[0] ?? ""), "a NOTICE that misses a patched file fails and names it");
ok(dropped.some((p) => /modifies one file\(s\), and the patch modifies two/u.test(p)), "the count word is checked against the patch");
const stale = checkNoticeModifications(noticeFor("two", ["dist/a.js", "dist/b.js"]), `${PATCH}+++ b/node_modules/eve/dist/c.js\n`);
ok(stale.length === 2 && /dist\/c\.js/u.test(stale[0] ?? ""), "a patch that grows a part turns an unchanged NOTICE red");
const extra = checkNoticeModifications(noticeFor("three", ["dist/a.js", "dist/b.js", "dist/gone.js"]), PATCH);
ok(extra.some((p) => /names dist\/gone\.js, which the patch does not modify/u.test(p)), "a NOTICE that names a file the patch no longer modifies fails");
const reordered = checkNoticeModifications(noticeFor("two", ["dist/b.js", "dist/a.js"]), PATCH);
ok(reordered.length === 1 && /different order/u.test(reordered[0] ?? ""), "a NOTICE in a different order fails");
ok(/no "Modifications to eve" section/u.test(checkNoticeModifications("Intro\n", PATCH)[0] ?? ""), "a NOTICE with no section fails while the patch modifies eve");

ok(checkPackageNotice("same\n", "same\n").length === 0, "a package NOTICE equal to the root NOTICE is clean");
ok(checkPackageNotice("same \n", "same\n").length === 1, "a package NOTICE one byte off the root NOTICE fails");
ok(checkPackageNotice(undefined, "same\n").length === 1, "a package with no NOTICE fails");

const rootLicense = readFileSync(join(root, LICENSE_FILE), "utf8");
ok(rootLicense.includes("Apache License"), "the repository LICENSE carries the Apache grant");
ok(ALL_PUBLISHABLE_PACKAGES.length > 0, "there is at least one publishable package to check");

const evePatches = readdirSync(join(root, "patches")).filter((f) => /^eve\+.+\.patch$/u.test(f));
ok(evePatches.length === 1, `exactly one eve patch under patches/ (found ${evePatches.join(", ") || "none"})`);
const rootNotice = readFileSync(join(root, NOTICE_FILE), "utf8");
const evePatch = readFileSync(join(root, "patches", evePatches[0] ?? ""), "utf8");
ok(patchTargets(evePatch).length > 0, "the eve patch modifies at least one file");
const noticeProblems = checkNoticeModifications(rootNotice, evePatch);
ok(noticeProblems.length === 0, `${NOTICE_FILE}: ${noticeProblems.join(" · ")}`);
ok(rootNotice.includes(`patches/${evePatches[0] ?? ""}`), `${NOTICE_FILE} names the shipped patch file, patches/${evePatches[0] ?? ""}`);

for (const pkgDir of ALL_PUBLISHABLE_PACKAGES) {
  const abs = join(root, pkgDir);
  const manifest = JSON.parse(readFileSync(join(abs, "package.json"), "utf8")) as { files?: readonly string[] };
  const licensePath = join(abs, LICENSE_FILE);
  const noticePath = join(abs, "NOTICE");
  const problems = checkPackageLicense({
    ...(existsSync(noticePath) ? { notice: readFileSync(noticePath, "utf8") } : {}),
    ...(existsSync(licensePath) ? { license: readFileSync(licensePath, "utf8") } : {}),
    rootLicense,
    files: manifest.files ?? [],
  });
  ok(problems.length === 0, `${pkgDir}: ${problems.join(" · ")}`);
  const noticeDrift = checkPackageNotice(existsSync(noticePath) ? readFileSync(noticePath, "utf8") : undefined, rootNotice);
  ok(noticeDrift.length === 0, `${pkgDir}: ${noticeDrift.join(" · ")}`);
}

console.log(`✓ publish-license — ${passed} assertion(s) across ${ALL_PUBLISHABLE_PACKAGES.length} publishable package(s)`);
