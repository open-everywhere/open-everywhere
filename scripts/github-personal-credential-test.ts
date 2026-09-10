import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConnectorCredentials } from "../agent/access/connector-credentials.js";
import {
  checkOwnAccountGateSites,
  findOwnAccountGateSites,
  type OwnAccountGateFile,
} from "@open-everywhere/core/agent/access/own-account-gate-manifest.js";
import { expandConnectorGrant, humanActingSupport, isHumanActing, principalOfCredential, type ConnectorCredentials } from "@open-everywhere/core/agent/access/connector-credentials.js";
import { humanActingConnectors } from "@open-everywhere/core/agent/connections/own-account-vendors.js";
import { credentialEndpointVerdict } from "@open-everywhere/core/agent/access/credential-endpoints.js";
import { MEMBER_ROLES, memberGrantKey, memberPlaneGrants } from "@open-everywhere/core/agent/access/member-grant.js";
import { CREDENTIAL_GRANT_ROLES, credentialGrantConnectors, domainsAdmitCredentialGrant } from "@open-everywhere/core/agent/access/credential-grant.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const GITHUB = "github";
const PERSONAL = "user-oauth";

const catalogues = loadConnectorCredentials();
const github = catalogues.find((c) => c.connector === GITHUB);
ok(github !== undefined, "the shipped config declares a github connector catalogue");
const gh = github as ConnectorCredentials;
const personal = gh.credentials.find((c) => c.id === PERSONAL);
ok(personal !== undefined, `the github catalogue declares the "${PERSONAL}" credential`);
const cred = personal!;

ok(humanActingSupport(gh) === "supported", "github declares human-acting support");
const linear = catalogues.find((c) => c.connector === "linear");
ok(linear !== undefined && humanActingSupport(linear) === "undeclared", "negative control: an undeclared connector reads undeclared, so `supported` is not what every catalogue returns");
ok(humanActingSupport(gh) !== humanActingSupport(linear!), "negative control: the declared and undeclared states are distinguishable");

ok(isHumanActing(cred), "the github personal credential carries the human-acting family");
ok(principalOfCredential(cred) === "user", "the github personal credential is user-principal");
ok(principalOfCredential({ type: "api-key" }) === "app", "negative control: an install-family api-key is app-principal");
ok(principalOfCredential({ grantFamily: "human-acting", type: "api-key" }) === "user", "negative control: the FAMILY, not the type, decides the principal");

const grant = { credential: PERSONAL, name: GITHUB } as const;
const inDm = expandConnectorGrant(grant, gh, { dm: true });
ok(inDm.resolved !== null, "the github personal credential RESOLVES on a DM binding");
ok(inDm.resolved?.principal === "user", "the resolved DM binding is user-principal");
const inRoom = expandConnectorGrant(grant, gh, { dm: false });
ok(inRoom.resolved === null, "the github personal credential is REFUSED on a non-DM binding — DM-scoped by construction");
ok(inRoom.warnings.length > 0, "the non-DM refusal carries a warning, so the refusal is not silent");

ok(!MEMBER_ROLES.some((r) => r.connector === GITHUB), "github is absent from MEMBER_ROLES");
const domainDeclaringGithub = {
  credentials: [{ connector: GITHUB, credential: PERSONAL, use: "somebody-elses-id" }],
  name: "declares-github-anyway",
};
ok(
  !memberPlaneGrants([domainDeclaringGithub]).includes(memberGrantKey(GITHUB, "somebody-elses-id")),
  "a domain that declares the github member role holds NO member-plane grant for it",
);
const notionRole = MEMBER_ROLES.find((r) => r.connector === "notion");
ok(notionRole !== undefined, "negative control: notion still holds a member role, so the helper has a positive case");
ok(
  memberPlaneGrants([{ credentials: [{ connector: "notion", credential: notionRole!.role, use: "some-notion-id" }], name: "declares-notion" }]).includes(
    memberGrantKey("notion", "some-notion-id"),
  ),
  "negative control: the same declaration shape DOES yield a member-plane grant for notion",
);

ok(!CREDENTIAL_GRANT_ROLES.some((r) => r.connector === GITHUB), "github is absent from CREDENTIAL_GRANT_ROLES");
ok(!credentialGrantConnectors().includes(GITHUB), "github is not a credential-grant connector");
ok(!domainsAdmitCredentialGrant([{ credentialGrants: [GITHUB], name: "declares-github-grants" }], GITHUB), "a domain declaring github credentialGrants still admits none");
ok(domainsAdmitCredentialGrant([{ credentialGrants: ["notion"], name: "declares-notion-grants" }], "notion"), "negative control: the same call DOES admit notion, so the refusal is about github");

const rules = cred.endpoints;
ok(rules !== undefined, "the github personal credential declares endpoint rules");
ok(credentialEndpointVerdict(rules, "https://api.github.com/repos/example-owner/ungranted-repo/pulls/1", "GET").allowed, "a GET to api.github.com is allowed");
ok(!credentialEndpointVerdict(rules, "https://api.github.com/repos/example-owner/ungranted-repo/pulls", "POST").allowed, "a POST under the personal credential is refused — the ruling admits reads only");
ok(!credentialEndpointVerdict(rules, "https://github.com/example-owner/ungranted-repo", "GET").allowed, "a GET to another host is refused — the host is pinned");

{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsFilesUnder = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === "generated") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  };
  const roots = [join(root, "packages", "core", "agent"), join(root, "agent")];
  for (const p of readdirSync(join(root, "packages", "providers"))) {
    const agentDir = join(root, "packages", "providers", p, "agent");
    try {
      if (statSync(agentDir).isDirectory()) roots.push(agentDir);
    } catch {
    }
  }
  const files: OwnAccountGateFile[] = [];
  for (const dir of roots) for (const full of tsFilesUnder(dir)) files.push({ file: relative(root, full), source: readFileSync(full, "utf8") });

  const humanActing = humanActingConnectors(loadConnectorCredentials());
  ok(humanActing.includes(GITHUB), "github declares humanActing.supported AND holds a human-acting credential");

  const vendorFactOnly: ConnectorCredentials = {
    allows: ["user-oauth"],
    connector: "researched-but-undeclared",
    credentials: [{ id: "install", type: "api-key" }],
    description: "a vendor researched and recorded, with no personal credential declared",
    humanActing: { credentialTypes: ["user-oauth"], supported: true },
  };
  ok(humanActingSupport(vendorFactOnly) === "supported", "the control really does declare humanActing.supported — otherwise it would pass vacuously");
  ok(humanActingConnectors([vendorFactOnly]).length === 0, "🔴 …but it does NOT enter the exemption list, because it holds no human-acting credential");

  const sites = findOwnAccountGateSites(files);
  ok(
    sites.some((s) => s.connector === GITHUB && s.file.includes("github-acting-identity.ts")),
    "🔴 the github gate call carries an `own-account-gate: github` marker the lint can read",
  );
  ok(checkOwnAccountGateSites(files, credentialGrantConnectors(), humanActing).length === 0, "🔴 the shipped tree is clean under all three rules");

  const withoutGithub = checkOwnAccountGateSites(files, credentialGrantConnectors(), humanActing.filter((c) => c !== GITHUB));
  ok(withoutGithub.length === 1, "🔴 negative control: drop github's humanActing declaration and its gate reds as a stale join");
  ok(withoutGithub[0]?.includes(GITHUB), "…naming github");
}

console.log(`✓ github personal credential: ${passed} assertions`);
