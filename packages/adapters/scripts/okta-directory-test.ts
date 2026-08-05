import assert from "node:assert/strict";
import { makeOktaDirectoryProvider, nextLink } from "../agent/directory/okta.js";
import { loadOktaDirectoryConfig, oktaDirectoryEnabled, parseOktaAppMap, type OktaDirectoryConfig } from "../agent/directory/config.js";
import type { DirectoryPerson } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG_URL = "https://acme.okta.example";
const TOKEN = "fake-okta-api-token";

const CONFIG: OktaDirectoryConfig = {
  orgUrl: ORG_URL,
  tokenRef: "OKTA_API_TOKEN",
  tokenBroker: "env",
  apps: [
    { platform: "slack", appId: "0oaSLACK", field: "externalId" },
    { platform: "github", appId: "0oaGITHUB", field: "externalId" },
    { platform: "linear", appId: "0oaLINEAR", field: "userName" },
  ],
};

type Route = { readonly body: unknown; readonly next?: string };

function fakeFetch(routes: Record<string, Route>, seen: { url: string; auth: string | null }[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization") });
    const route = routes[url];
    if (!route) {
      return new Response(JSON.stringify({ errorCode: "E0000007", errorSummary: `no fixture for ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const h: Record<string, string> = { "content-type": "application/json" };
    if (route.next) h.link = `<${ORG_URL}/api/v1/users?after=prev>; rel="self", <${route.next}>; rel="next"`;
    return new Response(JSON.stringify(route.body), { status: 200, headers: h });
  }) as typeof fetch;
}

const USERS_P1 = `${ORG_URL}/api/v1/users?limit=200`;
const USERS_P2 = `${ORG_URL}/api/v1/users?after=cursor2`;
const GROUPS = `${ORG_URL}/api/v1/groups?limit=200`;
const GROUPS_P2 = `${ORG_URL}/api/v1/groups?after=g2`;
const MEMBERS = (id: string) => `${ORG_URL}/api/v1/groups/${id}/users?limit=200`;
const APP_USERS = (id: string) => `${ORG_URL}/api/v1/apps/${id}/users?limit=500`;
const APP_USERS_P2 = `${ORG_URL}/api/v1/apps/0oaSLACK/users?after=a2`;

{
  const routes: Record<string, Route> = {
    [USERS_P1]: {
      next: USERS_P2,
      body: [
        { id: "00u1", status: "ACTIVE", profile: { login: "rowan@acme.example", email: "rowan@acme.example", firstName: "Rowan", lastName: "Hale" } },
        { id: "00u2", status: "PROVISIONED", profile: { login: "ada@acme.example", email: "ada@acme.example", displayName: "Ada L." } },
      ],
    },
    [USERS_P2]: {
      body: [
        { id: "00u3", status: "DEPROVISIONED", profile: { login: "gone@acme.example", email: "gone@acme.example", firstName: "Gone", lastName: "Person" } },
        { id: "00u4", status: "SUSPENDED", profile: { login: "held@acme.example", email: "held@acme.example" } },
        { id: "00u5", status: "LOCKED_OUT", profile: { login: "locked@acme.example", email: "locked@acme.example" } },
      ],
    },
    [GROUPS]: { next: GROUPS_P2, body: [{ id: "00g1", profile: { name: "Engineering" } }] },
    [GROUPS_P2]: { body: [{ id: "00g2", profile: { name: "Admins" } }, { id: "00g3", profile: {} }] },
    [MEMBERS("00g1")]: { body: [{ id: "00u1" }, { id: "00u2" }] },
    [MEMBERS("00g2")]: { body: [{ id: "00u1" }] },
    [MEMBERS("00g3")]: { body: [{ id: "00u1" }] },
    [APP_USERS("0oaSLACK")]: {
      next: APP_USERS_P2,
      body: [{ id: "00u1", externalId: "U0ROWAN", status: "PROVISIONED", credentials: { userName: "rowan@acme.example" } }],
    },
    [APP_USERS_P2]: {
      body: [
        { id: "00u2", externalId: "U0ADA", status: "ACTIVE" },
        { id: "00u3", externalId: "U0GONE", status: "ACTIVE" },
      ],
    },
    [APP_USERS("0oaGITHUB")]: {
      body: [
        { id: "00u1", externalId: "gh-rowan", status: "ACTIVE" },
        { id: "00u2", externalId: "gh-ada-old", status: "DEPROVISIONED" },
        { id: "00u5", credentials: { userName: "locked@acme.example" }, status: "ACTIVE" },
      ],
    },
    [APP_USERS("0oaLINEAR")]: {
      body: [
        { id: "00u1", externalId: "ignored-external", credentials: { userName: "lin-rowan" }, status: "ACTIVE" },
        { id: "00u2", externalId: "also-ignored", credentials: { userName: "   " }, status: "ACTIVE" },
      ],
    },
  };

  const seen: { url: string; auth: string | null }[] = [];
  let tokenResolutions = 0;
  const provider = makeOktaDirectoryProvider({
    config: CONFIG,
    fetch: fakeFetch(routes, seen),
    resolveToken: async (broker, ref) => {
      tokenResolutions++;
      ok(broker === "env" && ref === "OKTA_API_TOKEN", "token is resolved through the CONFIGURED broker + ref, never a raw env read");
      return TOKEN;
    },
  });

  ok(provider.id === "okta", "provider id is the stable evidence token \"okta\"");
  ok(provider.name.includes(ORG_URL), "provider name names the org for the control-plane status view");

  const people = (await provider.listPeople()) as readonly DirectoryPerson[];
  const by = new Map(people.map((p) => [p.externalId, p]));

  ok(people.length === 5, "pagination: both `Link: rel=\"next\"` pages of /users are followed (5 people, not 2)");
  ok(tokenResolutions === 1, "the API token is resolved ONCE per sync, not once per request");
  ok(seen.every((s) => s.auth === `SSWS ${TOKEN}`), "every Okta call carries the SSWS bearer");

  const rowan = by.get("00u1")!;
  ok(rowan.displayName === "Rowan Hale", "displayName falls back to firstName+lastName when the profile has no displayName");
  ok(by.get("00u2")!.displayName === "Ada L.", "an explicit profile.displayName wins");
  ok(by.get("00u4")!.displayName === "held@acme.example", "with neither, the login is the display name");
  ok(rowan.email === "rowan@acme.example", "profile.email rides along (an enricher input, never a join key here)");

  ok(rowan.deprovisioned === false && by.get("00u2")!.deprovisioned === false, "ACTIVE and PROVISIONED are live people");
  ok(by.get("00u3")!.deprovisioned === true, "DEPROVISIONED ⇒ deprovisioned:true");
  ok(by.get("00u4")!.deprovisioned === true, "SUSPENDED ⇒ deprovisioned:true");
  ok(by.get("00u5")!.deprovisioned === false, "LOCKED_OUT is a live human with a password problem — NOT a deprovision");

  const rowanAccounts = [...rowan.accounts].map((a) => `${a.platform}/${a.nativeId}:${a.grade}`).sort();
  ok(
    rowanAccounts.join(" ") === "github/gh-rowan:attested linear/lin-rowan:attested slack/U0ROWAN:attested",
    `every mapped app assignment becomes an "attested" account (got: ${rowanAccounts.join(" ")})`,
  );
  ok(
    [...by.get("00u1")!.accounts].some((a) => a.platform === "linear" && a.nativeId === "lin-rowan"),
    "the per-app `userName` opt-in reads credentials.userName and IGNORES externalId for that app",
  );
  const ada = by.get("00u2")!;
  ok(ada.accounts.some((a) => a.platform === "slack" && a.nativeId === "U0ADA"), "pagination: the second page of /apps/{id}/users is followed too");
  ok(!ada.accounts.some((a) => a.platform === "github"), "a DEPROVISIONED app assignment is not a mapping");
  ok(!ada.accounts.some((a) => a.platform === "linear"), "a blank userName yields no mapping — never a fallback to another field");
  ok(by.get("00u5")!.accounts.length === 0, "an assignment with no externalId on an externalId-configured app is skipped, not fudged from userName");
  ok(by.get("00u3")!.accounts.some((a) => a.nativeId === "U0GONE"), "a deprovisioned PERSON still reports their mappings — the sync decides what to do about them, not the adapter");

  ok(rowan.groups.join(",") === "Admins,Engineering", "groups: group-first fetch attaches every group's name, sorted (nameless groups dropped)");
  ok(by.get("00u2")!.groups.join(",") === "Engineering", "pagination: the second page of /groups is followed");
  ok(by.get("00u4")!.groups.length === 0, "a person in no group gets an empty groups list, not undefined");

  ok(!seen.some((s) => /\/api\/v1\/users\/[^/]+\/groups/u.test(s.url)), "groups are NOT fetched per-user (the O(people) shape is the one we did not choose)");
  ok(
    seen.filter((s) => s.url.startsWith(`${ORG_URL}/api/v1/groups/`)).length === 2,
    "one membership call per NAMED group, and only that — the nameless group is never even fetched",
  );
}

{
  const seen: { url: string; auth: string | null }[] = [];
  const provider = makeOktaDirectoryProvider({
    config: { ...CONFIG, apps: [] },
    fetch: fakeFetch({}, seen),
    resolveToken: async () => TOKEN,
  });
  let msg = "";
  try {
    await provider.listPeople();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.includes("404") && msg.includes("E0000007"), `an Okta error status throws with the status + errorCode (got: ${msg})`);
  ok(!msg.includes(TOKEN), "🔴 the token NEVER appears in a raised message");
}

{
  ok(nextLink(undefined) === undefined && nextLink("") === undefined, "no Link header ⇒ no next page");
  ok(nextLink('<https://x/a>; rel="self"') === undefined, "a self-only Link header ⇒ no next page");
  ok(nextLink('<https://x/a>; rel="self", <https://x/b>; rel="next"') === "https://x/b", "the rel=\"next\" URL is extracted from a multi-part Link header");
  ok(nextLink("<https://x/b>; rel=next") === "https://x/b", "unquoted rel=next is accepted (RFC 5988 allows it)");
}

{
  const apps = parseOktaAppMap("slack:0oa1, github:0oa2 , linear:0oa3:userName");
  ok(apps.length === 3, "app map: comma-separated entries, whitespace-tolerant");
  ok(apps[0]!.platform === "slack" && apps[0]!.appId === "0oa1" && apps[0]!.field === "externalId", "app map: the default field is externalId");
  ok(apps[2]!.field === "userName", "app map: the :userName suffix opts one app into the weaker field");
  ok(parseOktaAppMap(undefined).length === 0 && parseOktaAppMap("").length === 0, "app map: unset/empty ⇒ no apps (the person spine still syncs, with no account mappings)");
  ok(parseOktaAppMap("SLACK:0oa1")[0]!.platform === "slack", "app map: the platform token is lower-cased into our namespace");

  const throws = (raw: string, label: string) => {
    let threw = false;
    try {
      parseOktaAppMap(raw);
    } catch {
      threw = true;
    }
    ok(threw, label);
  };
  throws("slack", "app map: FAIL-LOUD on an entry with no app id — a silently dropped mapping looks exactly like an IdP with nothing to say");
  throws("slack:", "app map: FAIL-LOUD on a blank app id");
  throws(":0oa1", "app map: FAIL-LOUD on a blank platform");
  throws("slack:0oa1:email", "app map: FAIL-LOUD on an unknown field name");
  throws("slack:0oa1:externalId:extra", "app map: FAIL-LOUD on too many segments");

  ok(!oktaDirectoryEnabled({}), "selector: unset ⇒ the directory plane is OFF (silently — a deployment with no IdP is normal)");
  ok(!oktaDirectoryEnabled({ OE_DIRECTORY_PROVIDER: "oktaa" }), "selector: a typo leaves it OFF rather than half-arming");
  ok(oktaDirectoryEnabled({ OE_DIRECTORY_PROVIDER: " Okta " }), "selector: trimmed + case-insensitive exact match arms it");

  let threw = "";
  try {
    loadOktaDirectoryConfig({ OE_DIRECTORY_PROVIDER: "okta" });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(
    threw.includes("OE_DIRECTORY_OKTA_ORG_URL") && threw.includes("OE_DIRECTORY_OKTA_TOKEN_REF"),
    "config: FAIL-LOUD naming EVERY missing required var when the selector is armed",
  );

  const cfg = loadOktaDirectoryConfig({
    OE_DIRECTORY_PROVIDER: "okta",
    OE_DIRECTORY_OKTA_ORG_URL: "https://acme.okta.com/",
    OE_DIRECTORY_OKTA_TOKEN_REF: "OKTA_API_TOKEN",
    OE_DIRECTORY_OKTA_APPS: "slack:0oa1",
  });
  ok(cfg.orgUrl === "https://acme.okta.com", "config: a trailing slash on the org URL is normalised away");
  ok(cfg.tokenBroker === "env", "config: the broker defaults to core's env floor");
  ok(
    loadOktaDirectoryConfig({
      OE_DIRECTORY_PROVIDER: "okta",
      OE_DIRECTORY_OKTA_ORG_URL: ORG_URL,
      OE_DIRECTORY_OKTA_TOKEN_REF: "okta/api-token",
      OE_DIRECTORY_OKTA_TOKEN_BROKER: "db",
      OE_DIRECTORY_OKTA_APPS: "",
    }).tokenBroker === "db",
    "config: the broker is selectable, so the token can live in the encrypted db home instead of env",
  );
}

assert.ok(passed > 0);
console.log(`✓ okta-directory-test: ${passed} assertions passed`);
