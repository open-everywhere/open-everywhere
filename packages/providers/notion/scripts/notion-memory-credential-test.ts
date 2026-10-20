import {
  defineDomain,
  domainCredentialId,
  registerBroker,
  resetBrokers,
  resetRegisteredConnectorCredentials,
  setRegisteredConnectorCredentials,
  siloTier,
  type Domain,
  type MemoryAccess,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { overrideSettingsForTest, providerById, resetSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import {
  registerNotionMemory,
  makeNotionProvider,
  notionMemoryDeps,
  resolveNotionMemoryCredential,
  NOTION_MEMORY_CREDENTIAL,
  type HttpFetch,
} from "../agent/memory/memory.js";
import { NOTION_PROVIDER } from "../agent/channels/notion-credentials.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejectsWith(fn: () => Promise<unknown>, fragment: string, label: string): Promise<void> {
  let threw = false;
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    threw = true;
    error = err;
  }
  if (!threw) {
    console.error(`✗ ${label} (expected a throw, got none)`);
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(fragment)) {
    console.error(`✗ ${label} (threw, but not the refusal under test — expected "${fragment}", got: ${message})`);
    process.exit(1);
  }
  passed++;
}

const ORG_REF = "db:notion:memory";
const ORG_TOKEN = "ntn_org_memory_token";
const PAY_CRED = "payments-memory-key";
const PAY_TOKEN = "ntn_payments_memory_token";
const BROKER = "test";

const DOMAINS: readonly Domain[] = [
  defineDomain({
    name: "payments",
    reach: ["slack/T/C_PAY"],
    memory: "pay-brain",
    credentials: [{ connector: NOTION_PROVIDER, credential: NOTION_MEMORY_CREDENTIAL, use: PAY_CRED }],
  }),
  defineDomain({ name: "support", reach: ["slack/T/C_SUP"], memory: "sup-brain" }),
];
const BOUND: MemoryAccess = { domain: DOMAINS[0] };
const UNBOUND: MemoryAccess = { domain: DOMAINS[1] };

resetBrokers();
registerBroker(BROKER, {
  async getSecret(ref) {
    if (ref === ORG_REF) return ORG_TOKEN;
    if (ref === "db:notion:payments-memory") return PAY_TOKEN;
    throw new Error(`no secret for ${ref}`);
  },
});
resetRegisteredConnectorCredentials();
setRegisteredConnectorCredentials([
  {
    connector: NOTION_PROVIDER,
    allows: ["api-key"],
    credentials: [
      { id: NOTION_MEMORY_CREDENTIAL, type: "api-key", secretRef: ORG_REF, broker: BROKER, intake: false },
      { id: PAY_CRED, type: "api-key", secretRef: "db:notion:payments-memory", broker: BROKER, intake: false },
    ],
  },
]);

{
  ok((await resolveNotionMemoryCredential(NOTION_MEMORY_CREDENTIAL, BROKER, ORG_REF)).token === ORG_TOKEN, "the org-default role resolves the deployment key through its own broker stamp");
  ok((await resolveNotionMemoryCredential(PAY_CRED, BROKER, ORG_REF)).token === PAY_TOKEN, "a BOUND domain's credential resolves a DIFFERENT token — the whole point");
  ok((await resolveNotionMemoryCredential(PAY_CRED, BROKER, ORG_REF)).token !== ORG_TOKEN, "negative control: the bound token is genuinely not the org token");

  await rejectsWith(() => resolveNotionMemoryCredential("no-such-credential", BROKER, ORG_REF), 'domain credential "no-such-credential" is not a declared notion credential with a secretRef', "a NAMED-BUT-MISSING credential THROWS — it never retries under the org default");

  ok(domainCredentialId(BOUND.domain, NOTION_PROVIDER, NOTION_MEMORY_CREDENTIAL) === PAY_CRED, "the bound domain resolves its own credential id");
  ok(domainCredentialId(UNBOUND.domain, NOTION_PROVIDER, NOTION_MEMORY_CREDENTIAL) === NOTION_MEMORY_CREDENTIAL, "the unbound domain resolves the org-default role");
  ok(domainCredentialId(undefined, NOTION_PROVIDER, NOTION_MEMORY_CREDENTIAL) === NOTION_MEMORY_CREDENTIAL, "NO domain at all resolves the org-default role — the seam fails SOFT on absence");
}

const TIER = siloTier("pay-brain");
const P: Partition = { org: "default", platform: "slack", workspace: "T", surface: "C", workspaceKey: "slack/T", surfaceKey: "slack/T/C", key: "slack/T/C" };

function recordingFetch(): { fetchFn: HttpFetch; auth: string[] } {
  const auth: string[] = [];
  const fetchFn: HttpFetch = async (url, init) => {
    auth.push(String(init.headers["authorization"] ?? ""));
    const token = String(init.headers["authorization"] ?? "").replace("Bearer ", "");
    const m = url.match(/\/v1\/blocks\/([^/?]+)\/children/);
    const id = m ? m[1] : "";
    const results =
      id === "page-shared" ? [{ type: "paragraph", id: "x", paragraph: { rich_text: [{ plain_text: `seen-by:${token}` }] } }] : [];
    return {
      ok: true,
      status: 200,
      async text() {
        return "";
      },
      async json() {
        return { results, has_more: false, next_cursor: null };
      },
    };
  };
  return { fetchFn, auth };
}

{
  const { fetchFn, auth } = recordingFetch();
  const provider = makeNotionProvider(notionMemoryDeps(ORG_REF, BROKER, fetchFn));

  await provider.readTier(P, TIER, { name: "pay-brain", provider: "notion", container: "page-pay", readOnly: true }, BOUND);
  ok(auth.length > 0, "the bound read reached the wire at all");
  ok(auth.every((h) => h === `Bearer ${PAY_TOKEN}`), "🔴 a BOUND domain's subtree pull runs under THAT domain's integration token");
  ok(!auth.some((h) => h.includes(ORG_TOKEN)), "negative control: NO call in the bound read touched the org token");

  const { fetchFn: fetch2, auth: auth2 } = recordingFetch();
  const provider2 = makeNotionProvider(notionMemoryDeps(ORG_REF, BROKER, fetch2));
  await provider2.readTier(P, siloTier("sup-brain"), { name: "sup-brain", provider: "notion", container: "page-sup", readOnly: true }, UNBOUND);
  ok(auth2.length > 0 && auth2.every((h) => h === `Bearer ${ORG_TOKEN}`), "an UNBOUND domain falls back to the ORG DEFAULT token");
  ok(!auth2.some((h) => h.includes(PAY_TOKEN)), "negative control: NO call in the unbound read touched the bound domain's token");

  const { fetchFn: fetch3, auth: auth3 } = recordingFetch();
  const provider3 = makeNotionProvider(notionMemoryDeps(ORG_REF, BROKER, fetch3));
  await provider3.readTier(P, TIER, { name: "pay-brain", provider: "notion", container: "page-pay", readOnly: true });
  ok(auth3.length > 0 && auth3.every((h) => h === `Bearer ${ORG_TOKEN}`), "NO access argument falls back to the org default — absence never refuses");
}

{
  const { fetchFn, auth } = recordingFetch();
  const provider = makeNotionProvider(notionMemoryDeps(ORG_REF, BROKER, fetchFn));
  const silo = { name: "shared-root", provider: "notion", container: "page-shared", readOnly: true };

  const unbound = await provider.readTier(P, TIER, silo, UNBOUND);
  ok(unbound["MEMORY.md"].includes(`seen-by:${ORG_TOKEN}`), "the unbound read returns the ORG integration's view of the shared root page");

  const bound = await provider.readTier(P, TIER, silo, BOUND);
  ok(bound["MEMORY.md"].includes(`seen-by:${PAY_TOKEN}`), "🔴 the bound read of the SAME root page returns ITS OWN integration's view, not the cached org one");
  ok(!bound["MEMORY.md"].includes(`seen-by:${ORG_TOKEN}`), "negative control: the org integration's cached files are NOT served to the bound domain");
  ok(auth.some((h) => h === `Bearer ${PAY_TOKEN}`), "the bound read really issued its own call rather than a cache hit");

  const before = auth.length;
  const again = await provider.readTier(P, TIER, silo, BOUND);
  ok(auth.length === before, "a repeat read under the SAME credential is served from cache (no new call)");
  ok(again["MEMORY.md"] === bound["MEMORY.md"], "…and returns the same files");
}

{
  const { fetchFn, auth } = recordingFetch();
  const broken = defineDomain({
    name: "broken",
    reach: ["slack/T/C_BAD"],
    memory: "bad-brain",
    credentials: [{ connector: NOTION_PROVIDER, credential: NOTION_MEMORY_CREDENTIAL, use: "never-declared" }],
  });
  const provider = makeNotionProvider(notionMemoryDeps(ORG_REF, BROKER, fetchFn));
  await rejectsWith(
    () => provider.readTier(P, TIER, { name: "bad-brain", provider: "notion", container: "page-bad", readOnly: true }, { domain: broken }),
    'domain credential "never-declared" is not a declared notion credential with a secretRef',
    "a bound domain naming an UNDECLARED credential fails the read",
  );
  ok(auth.length === 0, "🔴 negative control: the failed read sent NOTHING — the org token never reached the wire");
}

// proves: SET-100
{
  const { fetchFn, auth } = recordingFetch();
  const provider = makeNotionProvider(notionMemoryDeps(undefined, BROKER, fetchFn));
  const silo = { name: "sup-brain", provider: "notion", container: "page-sup", readOnly: true };
  await provider.readTier(P, siloTier("sup-brain"), silo, UNBOUND);
  ok(auth.length > 0 && auth.every((h) => h === `Bearer ${ORG_TOKEN}`), "memory.notionTokenSecret: the shipped name db:notion:memory resolves the org token");
  const { fetchFn: fetch2, auth: auth2 } = recordingFetch();
  const provider2 = makeNotionProvider(notionMemoryDeps(undefined, BROKER, fetch2));
  process.env.OE_NOTION_SECRET_REF = ORG_REF;
  overrideSettingsForTest({ memory: { notionTokenSecret: "db:notion:payments-memory" } });
  await provider2.readTier(P, siloTier("sup-brain"), { ...silo, container: "page-sup-2" }, UNBOUND);
  ok(auth2.length > 0 && auth2.every((h) => h === `Bearer ${PAY_TOKEN}`), "🔴 memory.notionTokenSecret: the registered name decides which stored token the org default reads");
  ok(!auth2.some((h) => h.includes(ORG_TOKEN)), "🔴 …and the retired OE_NOTION_SECRET_REF variable is not read");
  delete process.env.OE_NOTION_SECRET_REF;
  resetSettingsForTest();
}

{
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  const wire: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    wire.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""));
    return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });
  }) as typeof fetch;
  registerBroker("db", {
    async getSecret(ref) {
      asked.push(ref);
      return ORG_TOKEN;
    },
  });
  process.env.NOTION_MEMORY_ENV_PROBE = "ntn_env_held_value";
  overrideSettingsForTest({ memory: { notionTokenSecret: "NOTION_MEMORY_ENV_PROBE" } });
  try {
    registerNotionMemory();
    await providerById("notion").readTier(P, siloTier("sup-brain"), { name: "sup-brain", provider: "notion", container: "page-reg", readOnly: true }, UNBOUND);
    ok(asked.length > 0 && asked.every((r) => r === "NOTION_MEMORY_ENV_PROBE"), `🔴 registerNotionMemory resolves the setting's name through the "db" broker (asked ${JSON.stringify(asked)})`);
    ok(wire.length > 0 && wire.every((h) => h === `Bearer ${ORG_TOKEN}`), "…and the wire carries the stored value");
    ok(!wire.some((h) => h.includes("ntn_env_held_value")), "🔴 …and NEVER the env var of the same name");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NOTION_MEMORY_ENV_PROBE;
    resetSettingsForTest();
  }
}

console.log(`✓ notion-memory-credential: ${passed} assertions passed`);
