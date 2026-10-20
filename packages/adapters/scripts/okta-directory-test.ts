import assert from "node:assert/strict";
import { makeOktaDirectoryProvider, nextLink } from "../agent/directory/okta.js";
import { loadOktaDirectoryConfig, oktaDirectoryEnabled, oktaAppMappings, type OktaDirectoryConfig } from "../agent/directory/config.js";
import { defineSettings, type OktaAppSetting } from "@open-everywhere/core/agent/adapter-api.js";
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
    rowanAccounts.join(" ") === "github/gh-rowan:attested linear/lin-rowan:asserted slack/U0ROWAN:attested",
    `the grade is a function of WHICH FIELD was read: externalId ⇒ "attested", userName ⇒ "asserted" (got: ${rowanAccounts.join(" ")})`,
  );
  ok(
    rowan.accounts.every((a) => (a.platform === "linear") === (a.grade === "asserted")),
    "🔴 …and the branch is per-APP, not per-person: the same person's externalId-mapped accounts keep the stronger grade in the very same snapshot",
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
  const routes: Record<string, Route> = {
    [USERS_P1]: {
      body: [
        { id: "00u1", status: "ACTIVE", profile: { login: "rowan@acme.example", email: "rowan@acme.example", displayName: "Rowan" } },
        { id: "00u2", status: "ACTIVE", profile: { login: "ada@acme.example", displayName: "Ada" } },
      ],
    },
    [GROUPS]: { next: GROUPS_P2, body: [{ id: "00g1", profile: { name: "Engineering" } }] },
    [GROUPS_P2]: { body: [{ id: "00g2", profile: { name: "Admins" } }, { id: "00g3", profile: {} }, { id: "00g4", profile: { name: "Payments" } }] },
    [MEMBERS("00g1")]: { body: [{ id: "00u1" }, { id: "00u2" }] },
    [MEMBERS("00g2")]: { body: [{ id: "00u1" }] },
    [MEMBERS("00g4")]: { body: [{ id: "00u2" }] },
    [APP_USERS("0oaSLACK")]: {
      body: [
        { id: "00u1", externalId: "U0ROWAN", status: "ACTIVE" },
        { id: "00u9", externalId: "U0GHOST", status: "ACTIVE" },
      ],
    },
    [APP_USERS("0oaGITHUB")]: {
      body: [
        { id: "00u1", externalId: "gh-rowan", status: "ACTIVE" },
        { id: "00u2", externalId: "gh-ada-old", status: "DEPROVISIONED" },
        { id: "00u2", status: "ACTIVE" },
      ],
    },
    [APP_USERS("0oaLINEAR")]: { body: [{ id: "00u2", credentials: { userName: "  " }, status: "ACTIVE" }] },
  };
  const make = (groupAllowlist: readonly string[] | undefined, seen: { url: string; auth: string | null }[]) =>
    makeOktaDirectoryProvider({ config: { ...CONFIG, ...(groupAllowlist ? { groupAllowlist } : {}) }, fetch: fakeFetch(routes, seen), resolveToken: async () => TOKEN });

  const seen: { url: string; auth: string | null }[] = [];
  const view = await make(["Engineering", "Payments", "Paymnets"], seen).inspect!();
  const memberReads = seen.filter((x) => /\/api\/v1\/groups\/[^/?]+\/users/u.test(x.url)).map((x) => x.url);
  ok(memberReads.length === 2 && memberReads.includes(MEMBERS("00g1")) && memberReads.includes(MEMBERS("00g4")), `🔴 OPE-2644: with an allowlist, ONLY the listed groups' members are read (got: ${memberReads.join(", ")})`);
  ok(!seen.some((x) => x.url === MEMBERS("00g2")), "🔴 OPE-2644: …the unlisted group's members are never requested");
  const by = new Map(view.people.map((p) => [p.externalId, p]));
  ok(by.get("00u1")!.groups.join(",") === "Engineering" && by.get("00u2")!.groups.join(",") === "Engineering,Payments", "allowlist: a person's groups are the listed ones only");
  ok(view.groups!.total === 4 && view.groups!.read.join(",") === "Engineering,Payments" && view.groups!.skipped === 1, "inspect: groups listed, read and skipped are counted (the nameless group is neither)");
  ok(view.groups!.allowlistMissing.join(",") === "Paymnets", "inspect: an allowlisted name the org does not have is reported — the match is verbatim");
  ok(view.requests === seen.length, "inspect: the request count is the number of HTTP calls the read made");

  const src = (platform: string) => view.sources.find((x) => x.platform === platform)!;
  ok(src("slack").field === "externalId" && src("slack").grade === "attested" && src("linear").field === "userName" && src("linear").grade === "asserted", "inspect: each source names its field and grade");
  ok(src("slack").assignments === 2 && src("slack").mapped === 1, "inspect: an assignment whose user is not listed is not counted as mapped");
  const reasons = (platform: string) => src(platform).skipped.map((k) => `${k.count}:${k.reason}:${k.examples.join("|")}`);
  ok(reasons("slack").some((r) => r.startsWith("1:") && r.includes("not in the user list") && r.endsWith(":00u9")), "inspect: an assignment for an unlisted user is reported with its Okta user id");
  ok(reasons("github").some((r) => r.includes("DEPROVISIONED")) && reasons("github").some((r) => r.includes("no externalId")), "inspect: a deprovisioned assignment and a missing externalId are reported separately");
  ok(reasons("linear").some((r) => r.includes("credentials.userName")), "inspect: a blank userName on a userName app is reported");
  ok(!JSON.stringify(view.sources).includes("@"), "inspect: a skip example is an Okta user id, never an email");
  ok(JSON.stringify((await make(["Engineering", "Payments", "Paymnets"], []).listPeople()).map((p) => p.groups)) === JSON.stringify(view.people.map((p) => p.groups)), "listPeople and inspect return the same people");

  const seenAll: { url: string; auth: string | null }[] = [];
  const all = await make(undefined, seenAll).inspect!();
  ok(seenAll.filter((x) => /\/api\/v1\/groups\/[^/?]+\/users/u.test(x.url)).length === 3 && all.groups!.allowlist === undefined, "no allowlist: every named group's members are read");
  const empty = await make([], []).inspect!();
  ok(empty.groups!.read.length === 3, "an EMPTY allowlist means every group, never no group");

  const cfg = loadOktaDirectoryConfig({ OE_DIRECTORY_PROVIDER: "okta", OE_DIRECTORY_OKTA_ORG_URL: "https://acme.okta.com", OE_DIRECTORY_OKTA_TOKEN_REF: "R" }, [], ["Payments"]);
  ok(cfg.groupAllowlist?.join(",") === "Payments", "config: directory.groupAllowlist reaches the adapter config");
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
  const seen: { url: string; auth: string | null }[] = [];
  const EVIL = "https://evil.example/api/v1/users?after=x";
  const routes: Record<string, Route> = {
    [USERS_P1]: { next: EVIL, body: [{ id: "00u1", status: "ACTIVE", profile: { login: "a@acme.example" } }] },
    [EVIL]: { body: [{ id: "00u2", status: "ACTIVE", profile: { login: "b@acme.example" } }] },
  };
  const provider = makeOktaDirectoryProvider({ config: { ...CONFIG, apps: [] }, fetch: fakeFetch(routes, seen), resolveToken: async () => TOKEN });
  let msg = "";
  try {
    await provider.listPeople();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.toLowerCase().includes("origin"), `🔴 F6: a cross-origin Link header is REFUSED (got: ${msg})`);
  ok(!seen.some((s) => s.url.startsWith("https://evil.example")), "🔴 F6: the token-bearing request was NEVER sent to the cross-origin host");
  ok(seen.some((s) => s.url === USERS_P1), "F6: …the same-origin first page WAS fetched (the refusal is the cross-origin hop, not a blanket failure)");
  ok(!msg.includes(TOKEN), "F6: and the refusal message never carries the token");
}

{
  ok(nextLink(undefined) === undefined && nextLink("") === undefined, "no Link header ⇒ no next page");
  ok(nextLink('<https://x/a>; rel="self"') === undefined, "a self-only Link header ⇒ no next page");
  ok(nextLink('<https://x/a>; rel="self", <https://x/b>; rel="next"') === "https://x/b", "the rel=\"next\" URL is extracted from a multi-part Link header");
  ok(nextLink("<https://x/b>; rel=next") === "https://x/b", "unquoted rel=next is accepted (RFC 5988 allows it)");
}

{
  const apps = oktaAppMappings([
    { platform: "slack", appId: "0oa1" },
    { platform: "github", appId: "0oa2" },
    { platform: "linear", appId: "0oa3", field: "userName" },
  ]);
  ok(apps.length === 3, "app map: one entry per app");
  ok(apps[0]!.platform === "slack" && apps[0]!.appId === "0oa1" && apps[0]!.field === "externalId", "app map: the default field is externalId");
  ok(apps[2]!.field === "userName", "app map: field: \"userName\" opts one app into the weaker field");
  ok(oktaAppMappings([]).length === 0, "app map: empty ⇒ no apps (the person spine still syncs, with no account mappings)");

  const throws = (entries: readonly OktaAppSetting[], label: string) => {
    let threw = false;
    try {
      oktaAppMappings(entries);
    } catch {
      threw = true;
    }
    let refusedAtLoad = false;
    try {
      defineSettings({ directory: { oktaApps: entries } });
    } catch {
      refusedAtLoad = true;
    }
    ok(threw && refusedAtLoad, `${label} (and settings load refuses the same table)`);
  };
  throws([{ platform: "slack", appId: "" }], "app map: FAIL-LOUD on a blank app id — a silently dropped mapping looks exactly like an IdP with nothing to say");
  throws([{ platform: "", appId: "0oa1" }], "app map: FAIL-LOUD on a blank platform");
  throws([{ platform: "SLACK", appId: "0oa1" }], "app map: FAIL-LOUD on a platform that is not our lowercase token");
  throws([{ platform: "slack", appId: "0oa1", field: "email" as never }], "app map: FAIL-LOUD on an unknown field name");

  const twoWorkspaces = oktaAppMappings([
    { platform: "slack", tenant: "T0AB1CD2E", appId: "0oa1" },
    { platform: "slack", tenant: "T9ZYX8W7V", appId: "0oa2" },
    { platform: "github", appId: "0oa3" },
  ]);
  ok(twoWorkspaces.length === 3, "app map (OPE-350): two apps for ONE platform are both kept — a second same-platform workspace is expressible");
  ok(twoWorkspaces[0]!.platform === "slack" && twoWorkspaces[0]!.tenant === "T0AB1CD2E", "app map (OPE-350): the tenant names the workspace");
  ok(twoWorkspaces[1]!.tenant === "T9ZYX8W7V" && twoWorkspaces[1]!.appId === "0oa2", "app map (OPE-350): …and the second app carries the OTHER workspace");
  ok(twoWorkspaces[2]!.tenant === undefined, "app map (OPE-350): an entry with no tenant carries NO tenant — this deployment's sole workspace, unchanged");
  throws([{ platform: "slack", tenant: "", appId: "0oa1" }], "app map (OPE-350): FAIL-LOUD on a blank workspace");
  throws([{ platform: "slack", tenant: "T1/T2", appId: "0oa1" }], "app map (OPE-350): FAIL-LOUD on a workspace with a slash — one workspace per entry");
  throws(
    [
      { platform: "slack", tenant: "T1", appId: "0oa1" },
      { platform: "slack", tenant: "T1", appId: "0oa2" },
    ],
    "app map (OPE-350): FAIL-LOUD on two apps mapped to the SAME (platform, workspace)",
  );
  throws(
    [
      { platform: "github", appId: "0oa1" },
      { platform: "github", appId: "0oa2" },
    ],
    "app map (OPE-350): …and the same for a vendor-global platform mapped twice",
  );

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

  const cfg = loadOktaDirectoryConfig(
    {
      OE_DIRECTORY_PROVIDER: "okta",
      OE_DIRECTORY_OKTA_ORG_URL: "https://acme.okta.com/",
      OE_DIRECTORY_OKTA_TOKEN_REF: "OKTA_API_TOKEN",
    },
    [{ platform: "slack", appId: "0oa1" }],
  );
  ok(cfg.apps.length === 1 && cfg.apps[0]!.appId === "0oa1", "config: the app table comes from the argument (the directory.oktaApps setting by default), never from env");
  ok(cfg.orgUrl === "https://acme.okta.com", "config: a trailing slash on the org URL is normalised away");
  ok(cfg.tokenBroker === "db", "config: the broker defaults to the encrypted db credential store (OPE-408 step 2)");
  ok(
    loadOktaDirectoryConfig({
      OE_DIRECTORY_PROVIDER: "okta",
      OE_DIRECTORY_OKTA_ORG_URL: ORG_URL,
      OE_DIRECTORY_OKTA_TOKEN_REF: "OKTA_API_TOKEN",
      OE_DIRECTORY_OKTA_TOKEN_BROKER: "env",
    }).tokenBroker === "env",
    "config: the broker is selectable, so the token can instead live in a plain env var",
  );

  const orgUrlThrows = (value: string, label: string): void => {
    let message = "";
    try {
      loadOktaDirectoryConfig({
        OE_DIRECTORY_PROVIDER: "okta",
        OE_DIRECTORY_OKTA_ORG_URL: value,
        OE_DIRECTORY_OKTA_TOKEN_REF: "OKTA_API_TOKEN",
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok(message.includes("OE_DIRECTORY_OKTA_ORG_URL"), `${label} (got: ${message || "NO THROW"})`);
  };
  orgUrlThrows("http://acme.okta.com", "🔴 config: a plaintext http:// org URL is REFUSED at boot — the SSWS token must never go out in clear");
  orgUrlThrows("http://localhost:8080", "🔴 config: …and there is no localhost carve-out — an escape hatch that exists for tests is an escape hatch in production");
  orgUrlThrows("acme.okta.com", "config: a scheme-less value is refused too (it is not a URL, and `new URL` would have thrown from a scheduled tick instead)");
  orgUrlThrows("ftp://acme.okta.com", "config: any non-https scheme is refused, not just http");
  ok(
    loadOktaDirectoryConfig({
      OE_DIRECTORY_PROVIDER: "okta",
      OE_DIRECTORY_OKTA_ORG_URL: "https://acme.oktapreview.com",
      OE_DIRECTORY_OKTA_TOKEN_REF: "OKTA_API_TOKEN",
    }).orgUrl === "https://acme.oktapreview.com",
    "config: an https org URL (including an *.oktapreview.com sandbox) still loads — the check narrows the scheme, not the host",
  );
}

assert.ok(passed > 0);
console.log(`✓ okta-directory-test: ${passed} assertions passed`);
