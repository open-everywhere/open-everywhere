import assert from "node:assert/strict";
import {
  registerBroker,
  resetBrokers,
  resetRegisteredProviders,
  setRegisteredProviders,
  siloTier,
  type CredentialEndpointRules,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { makeNotionProvider, notionMemoryDeps, NOTION_MEMORY_CREDENTIAL, type HttpFetch } from "../agent/memory/memory.js";
import { NOTION_PROVIDER } from "../agent/channels/notion-credentials.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ORG_REF = "db:notion:memory";
const ORG_TOKEN = "ntn_fence_memory_token";
const BROKER = "test";
const ROOT = "root-page";

const P: Partition = { org: "default", platform: "slack", workspace: "T", surface: "C", workspaceKey: "slack/T", surfaceKey: "slack/T/C", key: "slack/T/C" };
const TIER = siloTier("fence-brain");
const SILO = { name: "fence-brain", provider: "notion", container: ROOT, readOnly: true };

function armCredential(rules: CredentialEndpointRules | undefined): void {
  resetBrokers();
  registerBroker(BROKER, { async getSecret() { return ORG_TOKEN; } });
  resetRegisteredProviders();
  setRegisteredProviders([
    {
      name: NOTION_PROVIDER,
      connection: "notion",
      allows: ["api-key"],
      credentials: [
        { id: NOTION_MEMORY_CREDENTIAL, type: "api-key", secretRef: ORG_REF, broker: BROKER, intake: false, ...(rules ? { endpoints: rules } : {}) },
      ],
    },
  ]);
}

async function pull(rules: CredentialEndpointRules | undefined): Promise<{ threw: boolean; fetchCalls: number }> {
  armCredential(rules);
  let fetchCalls = 0;
  const fetchFn: HttpFetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, async text() { return ""; }, async json() { return { results: [], has_more: false, next_cursor: null }; } };
  };
  const provider = makeNotionProvider(notionMemoryDeps(ORG_REF, BROKER, fetchFn));
  try {
    await provider.readTier(P, TIER, SILO);
    return { threw: false, fetchCalls };
  } catch {
    return { threw: true, fetchCalls };
  }
}

{
  const permissive = await pull({ hosts: ["api.notion.com"], pathPrefixes: ["/v1/blocks/"], methods: ["GET"] });
  ok(permissive.fetchCalls > 0, "§1 POSITIVE CONTROL: under rules that admit it, the subtree pull DOES reach the injected fetch");
  ok(!permissive.threw, "§1 …and the read does not throw");
}

{
  const wrongPath = await pull({ hosts: ["api.notion.com"], pathPrefixes: ["/v1/pages/"], methods: ["GET"] });
  ok(wrongPath.fetchCalls === 0, "🔴 §2 the injected fetch was NEVER REACHED under rules that forbid the pull's path — the fence is wired on the memory path, not merely available");
  ok(wrongPath.threw, "§2 the read throws rather than silently returning an empty subtree");
}

{
  const wrongHost = await pull({ hosts: ["api.example.test"] });
  ok(wrongHost.fetchCalls === 0, "🔴 §3 a credential scoped to a DIFFERENT host never reaches the network on the memory path");
  ok(wrongHost.threw, "§3 the read throws on a wrong-host credential");
}

{
  const unnarrowed = await pull(undefined);
  ok(unnarrowed.fetchCalls > 0, "§4 a credential declaring NO rules is unnarrowed — the pull runs exactly as before OPE-523");
  ok(!unnarrowed.threw, "§4 …and does not throw");
}

resetBrokers();
console.log(`notion-memory-fence-test: ${n} assertions passed`);
