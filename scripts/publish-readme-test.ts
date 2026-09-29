import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import { README_FILE, README_MIN_CHARS, checkPackageReadme, checkTarballReadme } from "./publish-readme.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const real = "# @open-everywhere/thing\n\n".padEnd(README_MIN_CHARS * 3, "a factual sentence about this package. ");

ok(checkPackageReadme({ readme: real }).length === 0, "a README with real content passes");
ok(checkPackageReadme({ readme: undefined }).length === 1, "🔴 NO README at the package root is refused — the defect this arm closes");
ok(
  checkPackageReadme({ readme: undefined })[0]!.includes("does not have a README"),
  "…and the message names what npm would actually render, so a reader knows the cost",
);
ok(checkPackageReadme({ readme: "" }).length === 1, "🔴 an EMPTY README is refused — it packs fine and renders an empty npm page");
ok(checkPackageReadme({ readme: "   \n\n\t  \n" }).length === 1, "🔴 a whitespace-only README is refused — whitespace is not content");
ok(checkPackageReadme({ readme: "# thing\n" }).length === 1, "🔴 a bare-heading placeholder is refused — a title is not a page");
ok(
  checkPackageReadme({ readme: "x".repeat(README_MIN_CHARS - 1) }).length === 1,
  "one character under the floor is refused (the boundary is checked, not assumed)",
);
ok(checkPackageReadme({ readme: "x".repeat(README_MIN_CHARS) }).length === 0, "…and exactly at the floor passes");
ok(
  checkPackageReadme({ readme: `${"x".repeat(README_MIN_CHARS)}\n\n\n   ` }).length === 0,
  "the floor counts NON-whitespace, so trailing blank lines neither help nor hurt",
);

ok(checkTarballReadme([README_FILE, "LICENSE", "NOTICE"]).length === 0, "a tarball carrying the README passes");
ok(checkTarballReadme(["LICENSE", "NOTICE", "dist/index.js"]).length === 1, "🔴 a tarball with NO README is refused — the tarball is what npm renders");
ok(
  checkTarballReadme(["readme.md", "LICENSE"]).length === 1,
  "🔴 a lower-case `readme.md` does not satisfy the arm — the check is exact, and npm's own auto-include writes `README.md`",
);
ok(
  checkTarballReadme(["docs/README.md", "LICENSE"]).length === 1,
  "🔴 a README nested under a subdirectory does not satisfy it — npm renders the ROOT one and nothing else",
);

ok(ALL_PUBLISHABLE_PACKAGES.length === 9, `the publish list holds exactly 9 packages (got ${ALL_PUBLISHABLE_PACKAGES.length}) — a shrunk list silently stops checking the package that left`);

for (const pkgDir of ALL_PUBLISHABLE_PACKAGES) {
  const file = join(root, pkgDir, README_FILE);
  const readme = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const problems = checkPackageReadme({ readme });
  ok(problems.length === 0, `${pkgDir}: ${problems.join("; ")}`);

  const text = readme ?? "";
  ok(
    /\bopen-everywhere\/open-everywhere\b/u.test(text),
    `${pkgDir}: the README links to the manifest's own repository (github.com/open-everywhere/open-everywhere)`,
  );
  ok(!new RegExp(["open", "tag"].join(""), "iu").test(text), `🔴 ${pkgDir}: the README must never carry the retired product name`);
}

console.log(`✓ publish-readme: ${passed} assertion(s) passed (the pure rule both ways, plus a real README in all ${ALL_PUBLISHABLE_PACKAGES.length} publishable package roots)`);
