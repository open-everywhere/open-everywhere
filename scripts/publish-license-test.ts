import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import { LICENSE_FILE, checkPackageLicense, checkTarballLicense, noticeClaimsLicenseFile } from "./publish-license.js";

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

const rootLicense = readFileSync(join(root, LICENSE_FILE), "utf8");
ok(rootLicense.includes("Apache License"), "the repository LICENSE carries the Apache grant");
ok(ALL_PUBLISHABLE_PACKAGES.length > 0, "there is at least one publishable package to check");

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
}

console.log(`✓ publish-license — ${passed} assertion(s) across ${ALL_PUBLISHABLE_PACKAGES.length} publishable package(s)`);
