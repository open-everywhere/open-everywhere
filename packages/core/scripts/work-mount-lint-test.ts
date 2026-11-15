// proves: AP-MOD-core-access-work-mount-manifest, AP-WORK-add_label, AP-WORK-assign, AP-WORK-check_pr_status
// proves: AP-WORK-checkout_repo, AP-WORK-create_ticket, AP-WORK-get_pr_feedback, AP-WORK-notion_search
// proves: AP-WORK-open_pull_request, AP-WORK-post_pr_walkthrough, AP-WORK-read_linear_issue
// proves: AP-WORK-read_notion_page, AP-WORK-read_work_channel, AP-WORK-read_work_thread, AP-WORK-search
// proves: AP-WORK-set_state, AP-WORK-subscribe_pr, AP-WORK-walk_pr
// proves: AP-WORK-read_github_issue

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWorkMounts,
  isWorkTool,
  WORK_MOUNT_GAPS,
  WORK_TOOL_MOUNTS,
  type WorkToolFile,
} from "../agent/access/work-mount-manifest.js";

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${label}\n  ${(e as Error).message.split("\n").slice(0, 6).join("\n  ")}`);
  }
}

function cleanSurface(): WorkToolFile[] {
  const out: WorkToolFile[] = [];
  for (const [name, rule] of Object.entries(WORK_TOOL_MOUNTS)) {
    const body =
      rule.via === "grant"
        ?
          rule.connector === "*"
          ? name === "search"
            ? `import { searchGrantedConnectors } from "x"; searchGrantedConnectors(ctx, d);`
            : `import { workDestinationPlatforms } from "x"; workDestinationPlatforms(ctx, d);`
          : `import { ${rule.connector}WorkMount } from "x"; ${rule.connector}WorkMount(ctx);`
        : rule.via === "grant-and-source"
          ?
            `import { surfaceWorkReadMount, assertSurfaceWorkGrant } from "x"; surfaceWorkReadMount(ctx, d); assertSurfaceWorkGrant(ctx, d, p);`
          :
            `import { ${rule.connector}WorkMount, sourceScopedMount } from "x"; ${rule.connector}WorkMount(ctx, d); sourceScopedMount(ctx, "${rule.connector}", d);`;
    out.push({ name, source: body });
  }
  for (const name of Object.keys(WORK_MOUNT_GAPS)) {
    out.push({ name, source: `repoAllowed(input.repo, access.repos)` });
  }
  return out;
}

function mutate(name: string, source: string): WorkToolFile[] {
  return cleanSurface().map((f) => (f.name === name ? { name, source } : f));
}

function messagesFor(tools: WorkToolFile[], name: string): string[] {
  return checkWorkMounts(tools).filter((p) => p.includes(`"${name}"`));
}

check("a surface where every declared tool satisfies its own row is CLEAN", () => {
  assert.deepEqual(checkWorkMounts(cleanSurface()), []);
});

check("isWorkTool recognises each work-plane symbol, and is FALSE on a tool that names none", () => {
  for (const symbol of [
    "repoAllowed",
    "workDestinationPlatforms",
    "notionWorkMount",
    "githubWorkMount",
    "notionWorkGrant",
    "notionWorkCredential",
    "linearWorkOrg",
    "workGrantCredential",
    "hasWorkGrant",
    "hasGithubWorkGrant",
    "callerWorkGrant",
  ]) {
    assert.equal(isWorkTool(`const x = ${symbol}(ctx);`), true, `${symbol} must read as a work-plane symbol`);
  }
  assert.equal(isWorkTool(`const access = resolveAccessFor(ctx); return { repos: [...access.repos] };`), false);
  assert.equal(isWorkTool(`const x = notRepoAllowedHere;`), false);
});

check("an UN-CLASSIFIED work tool FAILS totality, and the same file without the work symbol does not", () => {
  const withWork = [...cleanSurface(), { name: "brand_new_tool", source: `repoAllowed(input.repo, access.repos)` }];
  const problems = messagesFor(withWork, "brand_new_tool");
  assert.equal(problems.length, 1, `expected exactly one totality problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /appears in neither WORK_TOOL_MOUNTS nor WORK_MOUNT_GAPS/u);
  const withoutWork = [...cleanSurface(), { name: "brand_new_tool", source: `const x = 1;` }];
  assert.deepEqual(messagesFor(withoutWork, "brand_new_tool"), []);
});

const grantOnly = Object.entries(WORK_TOOL_MOUNTS).find(([, r]) => r.via === "grant");
assert.ok(grantOnly, "the manifest must declare at least one grant-only work tool");
const [grantOnlyName, grantOnlyRule] = grantOnly;

check(`a via:"grant" tool that drops its ${grantOnlyRule.connector}WorkMount predicate FAILS`, () => {
  const problems = messagesFor(mutate(grantOnlyName, `repoAllowed(input.repo, access.repos)`), grantOnlyName);
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /MUST decide its mount with the connector's grant predicate/u);
});

check(`a via:"grant" tool that ALSO mounts through sourceScopedMount FAILS (chat presence is never a widening)`, () => {
  const source = `${grantOnlyRule.connector}WorkMount(ctx); sourceScopedMount(ctx, "${grantOnlyRule.connector}");`;
  const problems = messagesFor(mutate(grantOnlyName, source), grantOnlyName);
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /chat presence is never a precondition NOR a widening/u);
});

const union = Object.entries(WORK_TOOL_MOUNTS).find(([, r]) => r.via === "grant-or-source");
assert.ok(union, "the manifest must declare at least one union-mount work tool");
const [unionName, unionRule] = union;

check(`a via:"grant-or-source" tool that mounts on topology alone FAILS`, () => {
  const problems = messagesFor(mutate(unionName, `resolveWindowSources(ctx, domains).includes("x"); repoAllowed(a, b);`), unionName);
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /does not name the pair/u);
});

check(`a via:"grant-or-source" tool is CLEAN on the ONE union spelling (…WorkMount + sourceScopedMount)`, () => {
  const source = `${unionRule.connector}WorkMount(ctx, d); sourceScopedMount(ctx, "${unionRule.connector}");`;
  assert.deepEqual(messagesFor(mutate(unionName, source), unionName), []);
});

check(`a via:"grant-or-source" tool spelled with workDestinationPlatforms FAILS (OPE-953 collapsed that spelling)`, () => {
  const problems = messagesFor(mutate(unionName, `workDestinationPlatforms(ctx, d);`), unionName);
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /the pair \(/u);
});

check(`a neutral verb (connector:"*") declared via:"grant" must name the GRANT SET`, () => {
  const missing: WorkToolFile[] = [{ name: "make_believe", source: `hasWorkGrant(d, "notion", "team-key")` }];
  const problems = checkWorkMounts(missing, { make_believe: { connector: "*", via: "grant" } }, {}).filter((p) => p.includes("make_believe"));
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /never names workDestinationPlatforms/u);
  const named: WorkToolFile[] = [{ name: "make_believe", source: `workDestinationPlatforms(ctx, d)` }];
  assert.deepEqual(checkWorkMounts(named, { make_believe: { connector: "*", via: "grant" } }, {}), []);
  const unionAttempt = checkWorkMounts(named, { make_believe: { connector: "*", via: "grant-or-source" } }, {}).filter((p) => p.includes("make_believe"));
  assert.equal(unionAttempt.length, 1, `expected one problem, got ${JSON.stringify(unionAttempt)}`);
  for (const [name, rule] of Object.entries(WORK_TOOL_MOUNTS)) {
    if (rule.connector === "*") {
      assert.ok(
        rule.via === "grant" || rule.via === "grant-and-source",
        `neutral verb "${name}" must mount on the grant set or the intersection — no single connector gates it (got via:"${rule.via}")`,
      );
    }
  }
});

check(`🔴 OPE-961: "search" is the ONE row that reads searchGrantedConnectors, not workDestinationPlatforms`, () => {
  const searchNamesWrongSet: WorkToolFile[] = [{ name: "search", source: `workDestinationPlatforms(ctx, d)` }];
  const wrongProblems = checkWorkMounts(searchNamesWrongSet, { search: { connector: "*", via: "grant" } }, {}).filter((p) => p.includes(`"search"`));
  assert.equal(wrongProblems.length, 1, `expected one problem, got ${JSON.stringify(wrongProblems)}`);
  assert.match(wrongProblems[0], /never names searchGrantedConnectors/u);

  const searchClean: WorkToolFile[] = [{ name: "search", source: `searchGrantedConnectors(ctx, d)` }];
  assert.deepEqual(checkWorkMounts(searchClean, { search: { connector: "*", via: "grant" } }, {}), []);

  const otherNamesSearchSet: WorkToolFile[] = [{ name: "make_believe", source: `searchGrantedConnectors(ctx, d)` }];
  const otherProblems = checkWorkMounts(otherNamesSearchSet, { make_believe: { connector: "*", via: "grant" } }, {}).filter((p) => p.includes("make_believe"));
  assert.equal(otherProblems.length, 1, `expected one problem, got ${JSON.stringify(otherProblems)}`);
  assert.match(otherProblems[0], /never names workDestinationPlatforms/u);
});

const intersection = Object.entries(WORK_TOOL_MOUNTS).find(([, r]) => r.via === "grant-and-source");
if (intersection) {
  const [interName] = intersection;
  check("a grant-and-source tool that names only the MOUNT (no per-turn check) FAILS", () => {
    const problems = messagesFor(mutate(interName, `import { surfaceWorkReadMount } from "x"; surfaceWorkReadMount(ctx, d);`), interName);
    assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
    assert.match(problems[0], /does not name BOTH surfaceWorkReadMount .* and assertSurfaceWorkGrant/u);
  });
  check("a grant-and-source tool that mounts on the UNION instead FAILS", () => {
    const problems = messagesFor(
      mutate(interName, `import { workDestinationPlatforms, assertSurfaceWorkGrant } from "x"; workDestinationPlatforms(ctx, d); assertSurfaceWorkGrant(ctx, d, p);`),
      interName,
    );
    assert.equal(problems.length, 2, `expected two problems, got ${JSON.stringify(problems)}`);
    assert.ok(
      problems.some((x) => /names workDestinationPlatforms/u.test(x)),
      `expected the union-predicate refusal, got ${JSON.stringify(problems)}`,
    );
  });
}

const GAP_NAME = "crafted_gap";
const craftedGapSurface = (source: string): WorkToolFile[] => [{ name: GAP_NAME, source }];

check("the REAL WORK_MOUNT_GAPS table is EMPTY — every work tool mounts on its grant", () => {
  assert.deepEqual(Object.keys(WORK_MOUNT_GAPS), [], "a new gap row needs a reviewer's ruling and a ticket — see the table's header");
});

check("a WORK_MOUNT_GAPS row that KEEPS its repoAllowed execute fence is tolerated", () => {
  const problems = checkWorkMounts(craftedGapSurface(`repoAllowed(input.repo, access.repos)`), {}, { [GAP_NAME]: "OPE-960" });
  assert.deepEqual(problems, [], "NEGATIVE CONTROL for the two defects below");
});

check("a WORK_MOUNT_GAPS row that LOSES its repoAllowed execute fence FAILS", () => {
  const problems = checkWorkMounts(craftedGapSurface(`workDestinationPlatforms(ctx, d)`), {}, { [GAP_NAME]: "OPE-960" });
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /tolerated ONLY while the execute fence still refuses/u);
});

check("a WORK_MOUNT_GAPS value that is not a ticket id FAILS", () => {
  const problems = checkWorkMounts(craftedGapSurface(`repoAllowed(input.repo, access.repos)`), {}, { [GAP_NAME]: "later" });
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /is not a ticket id/u);
});

check("a tool in BOTH tables FAILS, and the real tables are disjoint", () => {
  const tools: WorkToolFile[] = [{ name: "two_faced", source: `repoAllowed(a, b); githubWorkMount(ctx);` }];
  const problems = checkWorkMounts(tools, { two_faced: { connector: "github", via: "grant" } }, { two_faced: "OPE-960" });
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /is in BOTH WORK_TOOL_MOUNTS and WORK_MOUNT_GAPS/u);
  assert.deepEqual(checkWorkMounts(tools, { two_faced: { connector: "github", via: "grant" } }, {}), []);
  for (const name of Object.keys(WORK_TOOL_MOUNTS)) {
    assert.equal(WORK_MOUNT_GAPS[name], undefined, `"${name}" is in both real tables`);
  }
});

check("a declared name with no scanned file FAILS as a stale row", () => {
  const missing = cleanSurface().filter((f) => f.name !== grantOnlyName);
  const problems = messagesFor(missing, grantOnlyName);
  assert.equal(problems.length, 1, `expected one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /stale row/u);
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function realToolFiles(): WorkToolFile[] {
  const dirs = [join(root, "packages", "core", "agent", "tools")];
  const providersRoot = join(root, "packages", "providers");
  if (existsSync(providersRoot)) {
    for (const e of readdirSync(providersRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const d = join(providersRoot, e.name, "agent", "tools");
      if (existsSync(d)) dirs.push(d);
    }
  }
  const out: WorkToolFile[] = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
      out.push({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(dir, f), "utf8") });
    }
  }
  return out;
}

check("the REAL tool tree satisfies every work-mount invariant", () => {
  const real = realToolFiles();
  assert.ok(real.length > 50, `expected the whole tool tree, scanned ${real.length}`);
  assert.deepEqual(checkWorkMounts(real), []);
});

check("the REAL tree's work tools are exactly the declared ones — the scan is not silently empty", () => {
  const real = realToolFiles();
  const found = real.filter((t) => isWorkTool(t.source)).map((t) => t.name).sort();
  const declared = [...Object.keys(WORK_TOOL_MOUNTS), ...Object.keys(WORK_MOUNT_GAPS)].sort();
  assert.deepEqual(found, declared);
  assert.ok(found.length >= 14, `expected the known work-tool population, found ${found.length}`);
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll work-mount manifest checks passed.`);

// proves: ROSTER-lint-work-mount
