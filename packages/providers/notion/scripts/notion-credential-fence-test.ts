import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleNotionDelivery } from "../agent/channels/notion-webhook.js";
import { resolveNotionCredential, type FetchLike } from "../agent/channels/notion-api.js";
import { NOTION_CHANNEL_CREDENTIAL } from "../agent/channels/notion-credentials.js";
import { registerBroker, resetBrokers, setRegisteredConnectorCredentials, type CredentialEndpointRules } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const WS = "ws-1";
const PAGE = "11111111-1111-1111-1111-111111111111";
const TOKEN = "ntn_fence_token";
const SECRET = "verification-token";
const sign = (body: string): string => "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
const BODY = JSON.stringify({ type: "comment.created", workspace_id: WS, entity: { id: "cmt-1", type: "comment" }, data: { page_id: PAGE } });

function armCredential(rules: CredentialEndpointRules | undefined): void {
  resetBrokers();
  registerBroker("test", { async getSecret() { return TOKEN; } });
  setRegisteredConnectorCredentials([
    {
      connector: "notion",
      allows: ["api-key"],
      credentials: [
        {
          id: NOTION_CHANNEL_CREDENTIAL,
          type: "api-key",
          secretRef: "db:notion:channel-key",
          broker: "test",
          intake: false,
          ...(rules ? { endpoints: rules } : {}),
        },
      ],
    },
  ]);
}

async function deliver(rules: CredentialEndpointRules | undefined): Promise<{ action: string; detail?: string; fetchCalls: number }> {
  armCredential(rules);
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ id: "cmt-1", discussion_id: "d-1", parent: { type: "page_id", page_id: PAGE }, rich_text: [], created_by: { id: "U_HUMAN", type: "person" } }), { status: 200 });
  };
  const out = await handleNotionDelivery(BODY, sign(BODY), {
    signingKeys: [{ credentialId: NOTION_CHANNEL_CREDENTIAL, secret: SECRET }],
    allowUnverified: false,
    credentialFor: (id) => resolveNotionCredential(id),
    credentialForPage: () => undefined,
    domains: [],
    resolveBotUserId: async () => "U_BOT",
    ambientEnabled: () => true,
    fetch: fetchImpl,
    dispatch: async () => {},
  });
  return { action: out.action, detail: out.detail, fetchCalls };
}

{
  const permissive = await deliver({ hosts: ["api.notion.com"], pathPrefixes: ["/v1/"], methods: ["GET", "POST"] });
  ok(permissive.fetchCalls > 0, "§1 POSITIVE CONTROL: under rules that admit it, the webhook two-step DOES reach the injected fetch");
  ok(permissive.action !== "error", `§1 …and the delivery does not error (action=${permissive.action})`);
}

{
  const fenced = await deliver({ hosts: ["api.notion.com"], pathPrefixes: ["/v1/blocks"], methods: ["GET"] });
  ok(fenced.fetchCalls === 0, "🔴 §1 the injected fetch was NEVER REACHED under rules that forbid the two-step's path — the fence is wired on the webhook path, not merely available");
  ok(fenced.action === "error", "§1 the delivery reports an error rather than dispatching on an unfetched comment");
  ok((fenced.detail ?? "").includes("BLOCKED"), "§1 …and the detail carries the fence's own refusal, so an operator can tell this from a Notion outage");
}

{
  const wrongHost = await deliver({ hosts: ["api.example.test"] });
  ok(wrongHost.fetchCalls === 0, "🔴 §1 a credential scoped to a DIFFERENT host never reaches the network on the webhook path");
}

{
  const unnarrowed = await deliver(undefined);
  ok(unnarrowed.fetchCalls > 0, "§1 a credential declaring NO rules is unnarrowed — the delivery runs exactly as before OPE-505");
}

resetBrokers();

const AGENT_DIR = fileURLToPath(new URL("../agent/", import.meta.url));
const FENCE_OWNER = "notion-api.ts";

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const offenders: string[] = [];
for (const file of tsFilesUnder(AGENT_DIR)) {
  if (file.endsWith(FENCE_OWNER)) continue;
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    if (!/\bapiKey:/.test(line)) return;
    if (/readonly apiKey:|apiKey: string|apiKey\?: string/.test(line)) return;
    if (line.includes("endpoints")) return;
    offenders.push(`${file.slice(AGENT_DIR.length)}:${i + 1}: ${line.trim()}`);
  });
}

ok(
  offenders.length === 0,
  `🔴 §2 every Notion REST call site passes the credential's \`endpoints\` alongside its \`apiKey\` — a bare key silently disables the fence. Offenders:\n  ${offenders.join("\n  ")}`,
);

const scanned = tsFilesUnder(AGENT_DIR).filter((f) => !f.endsWith(FENCE_OWNER));
ok(scanned.length > 5, `§2 the structural scan really read the agent tree (${scanned.length} file(s)) — an empty scan would pass vacuously`);
ok(
  scanned.some((f) => f.endsWith("notion.ts")),
  "§2 …including channels/notion.ts, the file whose webhook memo and terminal reply this rule exists for",
);

console.log(`notion-credential-fence-test: ${n} assertions passed`);
