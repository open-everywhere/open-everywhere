import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_PUBLISHABLE_PACKAGES, PUBLISHABLE_PACKAGES } from "./publish-exports-generate.js";
import { README_FILE, README_MIN_CHARS, checkPackageReadme, checkReadmeEvePin, checkTarballReadme } from "./publish-readme.js";

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

const PIN = "0.54.3";
const recipe = `## Install\n\n\`\`\`sh\nnpm i @open-everywhere/core eve@${PIN}\nnpx oe-eve-patch\n\`\`\`\n`;

ok(checkReadmeEvePin({ readme: recipe, pin: PIN }).length === 0, "a README naming the pin passes");
ok(
  checkReadmeEvePin({ readme: recipe.replace(PIN, "0.54.2"), pin: PIN }).length === 1,
  "🔴 a README naming ANOTHER eve version is refused — the drift this arm closes",
);
ok(
  checkReadmeEvePin({ readme: recipe.replace(PIN, "0.54.2"), pin: PIN })[0]!.includes("refuses to boot"),
  "…and the message names what it costs the consumer, not just that two strings differ",
);
ok(
  checkReadmeEvePin({ readme: "no install recipe here at all", pin: PIN }).length === 0,
  "a README that names no eve version is not this arm's question — checkPackageReadme owns an empty page",
);
ok(checkReadmeEvePin({ readme: undefined, pin: PIN }).length === 0, "a missing README is not reported twice");
ok(
  checkReadmeEvePin({ readme: "eve@0.54.2 and eve@0.54.2 again", pin: PIN }).length === 1,
  "one problem per WRONG VERSION, not per line — a re-roll that missed two lines reads as one drift",
);
ok(
  checkReadmeEvePin({ readme: "eve@0.54.2 then eve@0.53.0", pin: PIN }).length === 2,
  "…but two different wrong versions are two problems",
);
ok(
  checkReadmeEvePin({ readme: "npm i @agent-browser/eve@0.32.4", pin: PIN }).length === 0,
  "🔴 `@agent-browser/eve@0.32.4` is a DIFFERENT package and is not read as an eve pin",
);
ok(
  checkReadmeEvePin({ readme: "a sleeve@1.0.0 and my-eve@2.0.0", pin: PIN }).length === 0,
  "…nor is any other name that merely ends in `eve`",
);
ok(
  checkReadmeEvePin({ readme: `install \`eve@0.54.2\`, then run it.`, pin: PIN }).length === 1,
  "a version inside a backtick span is read, and the closing backtick and comma are not part of it",
);
ok(
  checkReadmeEvePin({ readme: `install \`eve@${PIN}\`, then run it.`, pin: PIN }).length === 0,
  "…so the correct pin inside a backtick span is not read with its punctuation attached",
);
ok(
  checkReadmeEvePin({ readme: "npm i eve@<pin>", pin: PIN }).length === 1,
  "🔴 a PLACEHOLDER is refused too — a consumer copies the npm page literally, and `eve@<pin>` is not installable",
);

ok(
  checkReadmeEvePin({ readme: "_eve@0.54.2_", pin: PIN }).length === 1,
  "🔴 an ITALICISED wrong version is refused — `_` is a word character, and a lookbehind that stopped at one matched nothing here",
);
ok(
  checkReadmeEvePin({ readme: "**eve@0.54.2**", pin: PIN }).length === 1,
  "…and a BOLD wrong version is refused too",
);
ok(
  checkReadmeEvePin({ readme: `**eve@${PIN}**`, pin: PIN }).length === 0,
  "🔴 a BOLD correct pin is NOT refused — the emphasis marks are not part of the version",
);
ok(
  checkReadmeEvePin({ readme: `[eve@${PIN}](https://example.test/pkg)`, pin: PIN }).length === 0,
  "🔴 a correct pin inside a markdown LINK is not refused — the bracket, paren and URL are not part of the version",
);
ok(
  checkReadmeEvePin({ readme: `<eve@${PIN}> and eve@${PIN}}`, pin: PIN }).length === 0,
  "…nor is one wrapped in an angle bracket or followed by a brace",
);
ok(
  checkReadmeEvePin({ readme: "my_eve@2.0.0 and my-eve@2.0.0", pin: PIN }).length === 0,
  "🔴 an UNDERSCORE name ending in `eve` is still not eve — the emphasis branch needs a space before the mark, so it cannot swallow this",
);
ok(
  checkReadmeEvePin({ readme: `run eve@${PIN}.`, pin: PIN }).length === 0,
  "a sentence-final full stop is not part of the version",
);

const corePin = (JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as { peerDependencies?: Record<string, string> })
  .peerDependencies?.eve;
ok(typeof corePin === "string" && /^\d+\.\d+\.\d+$/u.test(corePin), `@open-everywhere/core pins eve at an exact triple (got ${String(corePin)})`);

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
  const pinProblems = checkReadmeEvePin({ readme, pin: corePin as string });
  ok(pinProblems.length === 0, `${pkgDir}: ${pinProblems.join("; ")}`);
}

const LIBRARY_COUNT = 8;
ok(
  PUBLISHABLE_PACKAGES.length === LIBRARY_COUNT,
  `the library list holds exactly ${LIBRARY_COUNT} packages (got ${PUBLISHABLE_PACKAGES.length}) — "eight library packages" in docs/dev/publishing.md is this number`,
);

for (const pkgDir of PUBLISHABLE_PACKAGES) {
  const install = /\n## Install\n([\s\S]*?)\n## /u.exec(readFileSync(join(root, pkgDir, README_FILE), "utf8"))?.[1] ?? "";
  ok(install !== "", `${pkgDir}/${README_FILE} has an § Install section`);

  const recipe = (/```sh\n([\s\S]*?)```/u.exec(install)?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  ok(
    recipe.length === 2,
    `${pkgDir}/${README_FILE} § Install holds a two-command shell recipe (got ${recipe.length} command(s))`,
  );
  ok(
    recipe[0]?.includes(`eve@${corePin as string}`) === true,
    `🔴 ${pkgDir}/${README_FILE} § Install installs the pinned eve explicitly — the applier accepts no other version`,
  );
  ok(
    recipe[1] === "npx oe-eve-patch",
    `🔴 ${pkgDir}/${README_FILE} § Install RUNS \`npx oe-eve-patch\` as the second command (got \`${recipe[1] ?? "nothing"}\`) — core REFUSES TO BOOT on an unpatched eve (OPE-2182) and a registry eve carries no patch, so a recipe without this line throws at module load`,
  );
  ok(
    /refuses to boot/u.test(install),
    `${pkgDir}/${README_FILE} § Install says WHY the second command is required — a command a reader cannot justify is the one a reader skips`,
  );
}

console.log(`✓ publish-readme: ${passed} assertion(s) passed (the pure rule both ways, plus a real README in all ${ALL_PUBLISHABLE_PACKAGES.length} publishable package roots)`);
