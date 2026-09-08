import assert from "node:assert/strict";
import { loadDomains, domainsForSurface } from "../agent/memory/config/domains.js";
import { loadBindings, loadBundles } from "../agent/access/bundles.js";
import { loadConnectorCredentials } from "../agent/access/connector-credentials.js";
import { PLUGIN_REGISTRY } from "../agent/plugins/registry.js";
import { resolveAccess } from "@open-everywhere/core/agent/access/resolver.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const domains = loadDomains();
const bundles = loadBundles();
const bindings = loadBindings();
const credentials = loadConnectorCredentials();

function reposOnOrigin(platform: string, workspace: string, channel: string): readonly string[] {
  const access = resolveAccess(
    {
      mode: "channel",
      platform,
      workspace,
      channel,
      domains: domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }),
    },
    bundles,
    bindings,
    PLUGIN_REGISTRY,
    credentials,
  );
  return access.repos;
}

const domain = domains.find((d) => d.name === "e2e-unified");
ok(domain !== undefined, "the e2e-unified domain is defined — without it this whole file measures nothing");
ok(domain?.mode === "unified", "e2e-unified is still mode: \"unified\" — a per-container domain would make this file's claim meaningless");
ok(domain?.reach?.includes("slack/T0EXAMPLE/C0EXCHAN003") === true, "the Slack anchor channel is still a member of the domain");
ok(domain?.reach?.includes("github/example-owner/e2e-scratch") === true, "the GitHub repo channel is still a member of the same domain");

const slackRepos = reposOnOrigin("slack", "T0EXAMPLE", "C0EXCHAN003");
ok(slackRepos.includes("example-owner/e2e-scratch"), "a Slack-shaped wake on the domain's anchor channel resolves the e2e-scratch repo grant");

const githubRepos = reposOnOrigin("github", "example-owner", "e2e-scratch");
ok(
  githubRepos.includes("example-owner/e2e-scratch"),
  "a GitHub-shaped wake on the SAME domain's OWN repo channel resolves the SAME e2e-scratch repo grant a Slack wake gets — OPE-1004",
);

const unrelatedRepos = reposOnOrigin("github", "example-owner", "ope-1004-unrelated-repo-fixture");
ok(unrelatedRepos.length === 0, "a GitHub channel with no domain membership and no binding resolves NO repos — the positive result above is a real grant, not a wildcard");

const soakRepos = reposOnOrigin("github", "example-owner", "soak-scratch");
ok(!soakRepos.includes("example-owner/e2e-scratch"), "the soak domain's GitHub repo does not inherit e2e-unified's e2e-scratch grant");

if (n === 0) {
  console.error("✗ unified-repo-grant-origin: 0 assertions ran — the file is vacuous");
  process.exit(1);
}
console.log(`✓ unified-repo-grant-origin: ${n} assertions — a GitHub-woken and a Slack-woken session on the same unified domain resolve the same repo grants (OPE-1004).`);
