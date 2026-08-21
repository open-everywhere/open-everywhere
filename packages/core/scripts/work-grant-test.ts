import assert from "node:assert/strict";
import { hasGithubWorkGrant, hasWorkGrant, workGrantCredential, workGrantedConnectors } from "../agent/access/work-grant.js";
import { domainCredentialId } from "../agent/access/domain-credentials.js";
import type { Domain } from "../agent/memory/domain.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const NOTION = "notion";
const WORK_ROLE = "team-key";
const CHAT_ROLE = "channel-key";

const plain: Domain = { name: "support", channels: ["slack/T1/C1"] };
const chatOnly: Domain = {
  name: "billing",
  channels: ["slack/T1/C2"],
  credentials: [{ connector: NOTION, credential: CHAT_ROLE, use: "billing-chat-key" }],
};
const worker: Domain = {
  name: "payments",
  channels: ["slack/T1/C3", "notion/WS/aaa"],
  credentials: [{ connector: NOTION, credential: WORK_ROLE, use: "payments-work-key" }],
};
const otherProvider: Domain = {
  name: "platform",
  channels: ["slack/T1/C4"],
  credentials: [{ connector: "linear", credential: WORK_ROLE, use: "platform-linear-key" }],
};

ok(workGrantCredential(worker, NOTION, WORK_ROLE) === "payments-work-key", "a declared work role resolves to the credential it names");
ok(hasWorkGrant(worker, NOTION, WORK_ROLE), "a declared work role IS the grant");

ok(workGrantCredential(plain, NOTION, WORK_ROLE) === undefined, "a domain that declares nothing resolves NO work credential");
ok(hasWorkGrant(plain, NOTION, WORK_ROLE) === false, "a domain that declares nothing holds NO work grant (explicit false, not merely falsy)");
ok(workGrantCredential(chatOnly, NOTION, WORK_ROLE) === undefined, "declaring the CHAT role does not confer the WORK grant");
ok(hasWorkGrant(chatOnly, NOTION, WORK_ROLE) === false, "a chat-role declaration holds no work grant (explicit false)");
ok(hasWorkGrant(otherProvider, NOTION, WORK_ROLE) === false, "another provider's work role confers nothing on this one");
ok(hasWorkGrant(worker, "linear", WORK_ROLE) === false, "the grant is per CONNECTOR — Notion's does not carry Linear");
ok(hasWorkGrant(undefined, NOTION, WORK_ROLE) === false, "an unresolved domain holds no grant (fail closed)");

ok(domainCredentialId(plain, NOTION, WORK_ROLE) === WORK_ROLE, "domainCredentialId FALLS BACK to the org default for an undeclared role");
ok(workGrantCredential(plain, NOTION, WORK_ROLE) === undefined, "workGrantCredential does NOT fall back for the same undeclared role");
assert.notEqual(
  domainCredentialId(plain, NOTION, WORK_ROLE),
  workGrantCredential(plain, NOTION, WORK_ROLE),
  "the two readings of one field must differ on absence — that difference IS the grant",
);
passed++;

const both: Domain = {
  name: "kb",
  channels: ["notion/WS/bbb"],
  credentials: [
    { connector: NOTION, credential: CHAT_ROLE, use: "kb-chat-key" },
    { connector: NOTION, credential: WORK_ROLE, use: "kb-work-key" },
  ],
};
ok(workGrantCredential(both, NOTION, WORK_ROLE) === "kb-work-key", "the work role resolves its own credential when both roles are declared");
ok(domainCredentialId(both, NOTION, CHAT_ROLE) === "kb-chat-key", "the chat role still resolves its own credential, untouched by the work grant");

ok(hasGithubWorkGrant(["acme/api"]), "a granted repo IS the GitHub work grant");
ok(hasGithubWorkGrant(["acme/*"]), "a WILDCARD grant is a grant — it reaches every repo under that owner");
ok(hasGithubWorkGrant([]) === false, "NEGATIVE CONTROL: no granted repo, no GitHub work grant (explicit false)");

ok(workGrantedConnectors([worker]).includes("notion"), "the summary names a credential-declared provider");
ok(workGrantedConnectors([worker]).includes("github") === false, "NEGATIVE CONTROL: a Notion-granted domain with NO repo grant is not told it may do GitHub work");
ok(workGrantedConnectors([worker], ["acme/api"]).includes("github"), "🔴 OPE-940: a repo grant puts github in the summary the model reads");
ok(workGrantedConnectors([plain], ["acme/api"]).join(",") === "github", "the repo grant stands ALONE — a domain that declares no work role at all still holds GitHub's");
ok(workGrantedConnectors([plain], []).length === 0, "NEGATIVE CONTROL: no declaration and no repo ⇒ no work line at all");
const sorted = workGrantedConnectors([worker], ["acme/api"]);
ok(sorted.join(",") === "github,notion", `the list stays sorted with github in it (${sorted.join(",")})`);

console.log(`✓ work-grant: ${passed} assertions passed`);
