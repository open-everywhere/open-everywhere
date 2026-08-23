import assert from "node:assert/strict";
import {
  REPO_CAPABILITIES,
  REPO_CAPABILITY_NAMES,
  isRepoCapability,
  repoCapabilityProblems,
  unionRepoCapabilities,
  type RepoCapability,
} from "../agent/access/repo-capabilities.js";
import {
  DEFAULT_PERMISSIONS,
  ISSUE_WRITE_PERMISSIONS,
  PR_READ_PERMISSIONS,
  READ_PERMISSIONS,
  REPO_CAPABILITY_PERMISSIONS,
  EXPANSION_FORBIDDEN_FAMILIES,
  expandMintPermissions,
} from "../agent/scm/mint.js";
import { assertBundlesValid, repoGrantName, repoGrantCapabilities, type Bundle } from "../agent/access/bundle.js";
import { resolveAccess } from "../agent/access/resolver.js";
import { capabilityInstallationFit, repoCapabilityRows, renderRepoCapabilityRows, repoOwner, installationApprovalUrls } from "../agent/scm/capability-fit.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const throws = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

{
  const names = [...REPO_CAPABILITY_NAMES].sort();
  const mapped = Object.keys(REPO_CAPABILITY_PERMISSIONS).sort();
  ok(names.length > 0, "the capability vocabulary is non-empty");
  ok(JSON.stringify(names) === JSON.stringify(mapped), `every capability NAME has a permission mapping and vice versa (names=${names.join(",")} mapped=${mapped.join(",")})`);
  for (const name of names) {
    ok(typeof REPO_CAPABILITIES[name]?.summary === "string" && REPO_CAPABILITIES[name].summary.length > 0, `capability "${name}" carries an operator-facing summary`);
  }
  ok(isRepoCapability("pr-admin"), "pr-admin is an implemented capability");
  ok(isRepoCapability("pull_requests") === false, "🔴 a raw vendor permission family ('pull_requests') is NOT a capability name");
  ok(isRepoCapability("pr_admin") === false, "a near-miss spelling is not silently accepted");
}

{
  for (const [label, plane] of [
    ["DEFAULT", DEFAULT_PERMISSIONS],
    ["READ", READ_PERMISSIONS],
    ["PR_READ", PR_READ_PERMISSIONS],
    ["ISSUE_WRITE", ISSUE_WRITE_PERMISSIONS],
  ] as const) {
    ok(JSON.stringify(expandMintPermissions(plane, [])) === JSON.stringify(plane), `no capability ⇒ the ${label} job set is unchanged (back-compat floor)`);
    ok(JSON.stringify(expandMintPermissions(plane)) === JSON.stringify(plane), `an omitted capability list ⇒ the ${label} job set is unchanged`);
  }

  const ticketAdmin = expandMintPermissions(ISSUE_WRITE_PERMISSIONS, ["pr-admin"]);
  ok(ticketAdmin.pull_requests === "write", "pr-admin adds pull_requests:write to the ticket-action job set");
  ok(ticketAdmin.issues === "write", "pr-admin keeps the job set's own issues:write");
  ok(ticketAdmin.metadata === "read", "pr-admin keeps the job set's metadata:read");
  ok(ticketAdmin.contents === undefined, "🔴 pr-admin adds NO contents grade — the expansion cannot reach code");
  ok(ticketAdmin.workflows === undefined, "pr-admin adds no workflows grade — a capability adds only its own families");

  const wf = expandMintPermissions(DEFAULT_PERMISSIONS, ["workflows"]);
  ok(wf.workflows === "write", "workflows adds workflows:write to the PR job set");
  ok(wf.contents === "write" && wf.pull_requests === "write", "workflows leaves the PR job set's own families intact");

  const raised = expandMintPermissions(PR_READ_PERMISSIONS, ["pr-admin"]);
  ok(raised.pull_requests === "write", "pr-admin raises a read grade to write");
  ok(raised.contents === "read", "the raise leaves an unrelated family exactly as the job set declared it");
  const alreadyWrite = expandMintPermissions({ pull_requests: "write", metadata: "read" }, ["pr-admin"]);
  ok(alreadyWrite.pull_requests === "write", "an already-write family stays write when the expansion names write");
  const downgrade = expandMintPermissions({ pull_requests: "write", metadata: "read" }, ["reader" as RepoCapability], { reader: { pull_requests: "read" } });
  ok(downgrade.pull_requests === "write", "🔴 an expansion NEVER downgrades a family the job set already holds at write (join, not assignment)");
  const raiseVia = expandMintPermissions({ pull_requests: "read", metadata: "read" }, ["reader" as RepoCapability], { reader: { pull_requests: "read" } });
  ok(raiseVia.pull_requests === "read", "an expansion that names the grade already held changes nothing");

  const both = expandMintPermissions(ISSUE_WRITE_PERMISSIONS, ["pr-admin", "workflows"]);
  ok(both.pull_requests === "write" && both.workflows === "write" && both.issues === "write", "two capability sets union rather than replace");

  ok(throws(() => expandMintPermissions(DEFAULT_PERMISSIONS, ["not-a-capability" as RepoCapability])).includes("unknown repo capability"), "an unmapped capability name throws at the mint seam");

  ok(EXPANSION_FORBIDDEN_FAMILIES.includes("contents"), "contents is on the forbidden-expansion list");
  const rogue = throws(() => expandMintPermissions(READ_PERMISSIONS, ["push-anything" as RepoCapability], { "push-anything": { contents: "write" } }));
  ok(rogue.includes("forbidden permission family") && rogue.includes("contents"), "🔴 a capability that maps contents is REFUSED, not minted");
  for (const [name, families] of Object.entries(REPO_CAPABILITY_PERMISSIONS)) {
    for (const family of Object.keys(families)) {
      ok(EXPANSION_FORBIDDEN_FAMILIES.includes(family) === false, `shipped capability "${name}" names no forbidden family ("${family}")`);
    }
  }
}

{
  ok(repoGrantName("acme/web") === "acme/web", "a bare string reads as its repo name");
  ok(repoGrantName({ repo: "acme/web", capabilities: ["pr-admin"] }) === "acme/web", "an object grant reads as its repo name");
  ok(repoGrantCapabilities("acme/web").length === 0, "🔴 a bare-string repo grant declares NO capabilities (the default)");
  ok(repoGrantCapabilities({ repo: "acme/web" }).length === 0, "an object grant with no capabilities field declares none");
  ok(JSON.stringify(repoGrantCapabilities({ repo: "acme/web", capabilities: ["workflows"] })) === '["workflows"]', "an object grant reads its declared capabilities");

  const valid = (repos: Bundle["repos"]): string => throws(() => assertBundlesValid([{ name: "b", repos }]));

  ok(valid(["acme/web"]) === "", "a bare-string repo grant loads");
  ok(valid([{ repo: "acme/web", capabilities: ["pr-admin", "workflows"] }]) === "", "an object repo grant with implemented capabilities loads");
  ok(valid([{ repo: "acme/web" }]) === "", "an object repo grant with no capabilities loads");

  ok(valid([{ repo: "acme/web", capabilities: ["pr-admin", "nope"] as unknown as readonly RepoCapability[] }]).includes("unknown capability"), "an unknown capability name is refused at config load");
  const rawPerm = valid([{ repo: "acme/web", capabilities: ["pull_requests"] as unknown as readonly RepoCapability[] }]);
  ok(rawPerm.includes("unknown capability") && rawPerm.includes("never raw GitHub permission strings"), "🔴 a raw vendor permission string is refused, and the message says why");
  ok(valid([{ repo: "acme/web", capabilities: [] }]).includes("expands nothing"), "an empty capabilities list is refused (write the bare string instead)");
  ok(valid([{ repo: "acme/web", capabilities: ["pr-admin", "pr-admin"] }]).includes("more than once"), "a duplicate capability is refused");
  ok(valid(["acme/web", { repo: "acme/web", capabilities: ["pr-admin"] }]).includes("more than once"), "the same repo declared twice in one bundle is refused (its capabilities would be ambiguous)");
  ok(valid([{ repo: "https://github.com/acme/web" }]).includes("bare owner/name form"), "a URL in the object spelling is refused, exactly as in the bare one");
  ok(valid(["https://github.com/acme/web"]).includes("bare owner/name form"), "a URL in the bare spelling is still refused");
  ok(valid([{ repo: "acme/web", allow: ["*"] } as never]).includes('unknown field "allow"'), "an unknown field on a repo grant is refused (no smuggled second vocabulary)");
  ok(valid([42 as never]).includes("neither"), "a repo grant that is neither shape is refused");

  ok(repoCapabilityProblems("x", undefined).length === 0, "an absent capabilities list is not a problem");
  ok(repoCapabilityProblems("x", ["pr-admin"]).length === 0, "an implemented capability is not a problem");
  ok(JSON.stringify(unionRepoCapabilities(["workflows"], ["pr-admin", "workflows"])) === '["pr-admin","workflows"]', "the capability union dedupes and sorts");
}

{
  const req = { mode: "channel", platform: "slack", workspace: "T1", channel: "C1", domains: ["eng"] } as const;
  const at = (bundles: Bundle[]) =>
    resolveAccess(req, bundles, bundles.map((b) => ({ bundle: b.name, scope: { level: "domain", domain: "eng" } as const })));

  const plain = at([{ name: "a", repos: ["acme/web"] }]);
  ok(JSON.stringify(plain.repos) === '["acme/web"]', "a bare-string grant still resolves the repo name");
  ok(Object.keys(plain.repoCapabilities).length === 0, "🔴 a bare-string grant resolves NO capabilities — the map is empty, not defaulted");

  const declared = at([{ name: "a", repos: [{ repo: "acme/web", capabilities: ["pr-admin"] }] }]);
  ok(JSON.stringify(declared.repoCapabilities["acme/web"]) === '["pr-admin"]', "an object grant resolves its capabilities against the repo");
  ok(JSON.stringify(declared.repos) === '["acme/web"]', "the repo list is unchanged in shape by the object spelling");

  const unioned = at([
    { name: "a", repos: [{ repo: "acme/web", capabilities: ["pr-admin"] }] },
    { name: "b", repos: [{ repo: "acme/web", capabilities: ["workflows"] }, "acme/infra"] },
  ]);
  ok(JSON.stringify(unioned.repoCapabilities["acme/web"]) === '["pr-admin","workflows"]', "two bundles granting one repo union their capabilities");
  ok(unioned.repoCapabilities["acme/infra"] === undefined, "a repo nobody expanded is absent from the map");
  ok(JSON.stringify(unioned.repos) === '["acme/infra","acme/web"]', "the repo union is unaffected");

  const mixed = at([{ name: "a", repos: ["acme/web"] }, { name: "b", repos: [{ repo: "acme/web", capabilities: ["pr-admin"] }] }]);
  ok(JSON.stringify(mixed.repoCapabilities["acme/web"]) === '["pr-admin"]', "a bare grant does not erase another bundle's expansion");
}

{
  ok(repoOwner("acme/web") === "acme", "the owner half is parsed off a repo ref");
  ok(repoOwner("notarepo") === "", "a malformed ref yields no owner (never a guess)");

  const supported = capabilityInstallationFit(["pr-admin"], { pull_requests: "write", issues: "write", metadata: "read" });
  ok(supported.reported && supported.ok && supported.missing.length === 0, "an installation that grants the family reports a clean fit");

  const short = capabilityInstallationFit(["pr-admin", "workflows"], { issues: "write", pull_requests: "read", metadata: "read" });
  ok(short.reported && short.ok === false, "an installation missing a family reports a failing fit");
  ok(short.missing.some((m) => m.capability === "pr-admin" && m.family === "pull_requests" && m.need === "write" && m.granted === "read"), "the shortfall names the family, the needed grade and what is granted today");
  ok(short.missing.some((m) => m.capability === "workflows" && m.family === "workflows" && m.granted === undefined), "an ungranted family reports no `granted` rather than a fabricated one");

  ok(capabilityInstallationFit(["pr-admin"], { pull_requests: "write" }).ok, "write covers a write need");
  ok(capabilityInstallationFit(["workflows"], { workflows: "write" }).ok, "the workflows family is matched by its own grade");

  const unreported = capabilityInstallationFit(["pr-admin"], undefined);
  ok(unreported.reported === false, "🔴 an installation that cannot report is marked UNREPORTED");
  ok(unreported.missing.length === 0, "an unreported fit invents no shortfalls");

  const rows = repoCapabilityRows(["acme/web"], { "acme/web": ["pr-admin"] }, { acme: { pull_requests: "write", metadata: "read" } });
  ok(rows.length === REPO_CAPABILITY_NAMES.length, "one row per implemented capability set, for each granted repo");
  ok(rows.some((r) => r.capability === "pr-admin" && r.declared), "a declared capability is marked declared");
  ok(rows.some((r) => r.capability === "workflows" && r.declared === false), "🔴 an undeclared capability is marked NOT declared (=== false), not merely absent");
  ok(rows.find((r) => r.capability === "workflows")?.fit.ok === false, "the undeclared capability's installation fit is computed too");

  const text = renderRepoCapabilityRows(rows, { acme: "42" }).join("\n");
  ok(text.includes('repos: [{ repo: "acme/web", capabilities: ["workflows"] }]'), "the render carries the exact config line to add");
  ok(text.includes("installation owner (acme) approves the update"), "the render names the owner-approval step for the unsupported set");
  ok(text.includes(installationApprovalUrls("acme", "42")[0]), "the render carries the installation settings URL");
  ok(text.split("installation owner (acme)").length - 1 === 1, "the owner-approval step appears ONLY for the set the installation cannot honour");
  ok(renderRepoCapabilityRows([]).join("").includes("nothing to expand"), "a domain with no repo grants says so rather than rendering an empty section");
}

console.log(`\n✓ repo capabilities (OPE-1024): ${n} assertions passed (closed vocabulary, mint derivation + contents guard, binding shape + validation, resolver union, ask-time installation fit)\n`);
