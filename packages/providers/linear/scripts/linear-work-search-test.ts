import assert from "node:assert/strict";
import { defineDomain, registerIdentityMapper, type BindableContext, type Domain } from "@open-everywhere/core/agent/adapter-api.js";
import { domainOwnTeamIds, linearWorkSearchAdapter } from "../agent/channels/linear-work-search.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "org-1";
const TEAM_OWN = "team-own";
const TEAM_OTHER = "team-other";

const rostered: Domain = defineDomain({ name: "d1", reach: ["slack/T1/C1", `linear/${ORG}/${TEAM_OWN}`, `linear/other-org/${TEAM_OTHER}`] });
const ids = domainOwnTeamIds(rostered, ORG);
ok(ids.has(TEAM_OWN), "a rostered linear channel for the ASKED org's team is in the set");
ok(ids.has(TEAM_OTHER) === false, "NEGATIVE CONTROL: a roster entry for a DIFFERENT org's team is excluded — the org argument actually filters");
ok(domainOwnTeamIds(defineDomain({ name: "d2", reach: ["slack/T1/C2"] }), ORG).size === 0, "NEGATIVE CONTROL: a domain with no Linear roster entries owns NOTHING");
ok(domainOwnTeamIds(defineDomain({ name: "d3", reach: [`linear/${ORG}`] }), ORG).size === 0, "a whole-workspace CLAIM (no per-team roster entry) also owns nothing extra to narrow to — documented, not silently ignored");

const PLATFORM = "linearworksearchtestplatform";
registerIdentityMapper(PLATFORM, (c) => {
  const a = (c as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_LWS" };
});
function ctxIn(room: string): BindableContext {
  return {
    channel: { kind: PLATFORM },
    session: { auth: { current: { attributes: { ws: "W1", room }, principalId: "U_LWS", principalType: "test-user" } } },
  } as unknown as BindableContext;
}

const domain: Domain = defineDomain({
  name: "lws-domain",
  reach: [`${PLATFORM}/W1/CROOM`, `linear/${ORG}/${TEAM_OWN}`],
  credentials: [{ connector: "linear", credential: "workspace", use: ORG }],
});

const SAVED: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in SAVED)) SAVED[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
setEnv("LINEAR_AGENT_ACCESS_TOKEN", "test-token");
for (const k of ["LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN", "LINEAR_ORGANIZATION_ID", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]) {
  setEnv(k, undefined);
}

const savedFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      data: {
        issueSearch: {
          nodes: [
            { id: "id-own", identifier: "OWN-1", title: "Our own issue", url: "https://linear.app/x/issue/OWN-1", team: { id: TEAM_OWN } },
            { id: "id-other", identifier: "OTH-1", title: "Someone else's issue", url: "https://linear.app/x/issue/OTH-1", team: { id: TEAM_OTHER } },
          ],
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

try {
  const unscoped = await linearWorkSearchAdapter.search(ctxIn("CROOM"), domain, "bug", { limit: 10, insideDomain: false });
  ok(unscoped.length === 2, "unscoped: BOTH issues come back — reach is the workspace credential's own reach, never filtered by default");
  ok(
    unscoped.some((h) => h.id === "OTH-1"),
    "unscoped INCLUDES an issue on a team outside this domain's own roster — the load-bearing negative control",
  );

  const scoped = await linearWorkSearchAdapter.search(ctxIn("CROOM"), domain, "bug", { limit: 10, insideDomain: true });
  ok(scoped.length === 1 && scoped[0]!.id === "OWN-1", "insideDomain:true narrows to ONLY the issue on this domain's own rostered team");
  ok(
    scoped.every((h) => h.id !== "OTH-1"),
    "insideDomain:true DROPS the issue on the other team",
  );
  ok(scoped[0]!.title === "Our own issue" && scoped[0]!.connector === "linear" && scoped[0]!.url === "https://linear.app/x/issue/OWN-1", "the surviving hit carries identifier, title, url and connector — never a description/body");

  await assert.rejects(
    linearWorkSearchAdapter.search(ctxIn("CROOM"), defineDomain({ name: "lws-nogrant", reach: [`${PLATFORM}/W1/CBARE`] }), "bug", { limit: 10, insideDomain: false }),
    /holds no Linear work grant/u,
    "NEGATIVE CONTROL: a domain with no Linear work grant refuses rather than silently returning empty",
  );
} finally {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log(`✓ linear-work-search: ${passed} assertions passed`);
