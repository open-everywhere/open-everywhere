import { PROVISIONERS, provisionSlackMpim, writeEnvE2e, redactGuids, loadEnvFile, notionTitleOf, reachableSurfaces } from "./e2e/fixture-inventory.js";
import { roomName, type PlannedRoom } from "./e2e/fixture-inventory-lib.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const PLAN = { slug: "addressed", linearKey: "OEEA" };

interface Recorder {
  readonly calls: { method: string; url: string; body: unknown; auth: string }[];
  creates(match: RegExp): number;
}

function recorder(): Recorder {
  const calls: { method: string; url: string; body: unknown; auth: string }[] = [];
  return {
    calls,
    creates(match) {
      return calls.filter((c) => match.test(`${c.method} ${c.url}`)).length;
    },
  };
}

function scripted(rec: Recorder, route: (url: string, method: string, body: unknown) => unknown): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = String(new Headers(init?.headers).get("authorization") ?? "");
    rec.calls.push({ method, url, body, auth });
    const answer = route(url, method, body);
    if (answer === undefined) throw new Error(`the test script has no route for ${method} ${url}`);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const ROOM = (surface: PlannedRoom["surface"], envVar: string): PlannedRoom => ({ surface, envVar, action: "create", note: "test" });

const NOTION_ENV = { E2E_NOTION_DRIVER_KEY: "k", E2E_NOTION_PAGE_ID: "aaaaaaaa-0000-4000-8000-000000000001" };
const NOTION_ROOM = ROOM("notion", "E2E_ADDRESSED_NOTION_PAGE_ID");
const WANT_NOTION = roomName(PLAN.slug, "notion");

function notionScript(rec: Recorder, on: 0 | 1 | 2): typeof fetch {
  const child = { id: "bbbbbbbb-0000-4000-8000-000000000002", type: "child_page", child_page: { title: WANT_NOTION } };
  const filler = { id: "cccccccc-0000-4000-8000-000000000003", type: "paragraph" };
  return scripted(rec, (url, method) => {
    if (url.includes("/pages/aaaaaaaa")) return { id: "aaaaaaaa", parent: { type: "page_id", page_id: "dddddddd-0000-4000-8000-000000000004" } };
    if (url.includes("/blocks/")) {
      const second = url.includes("start_cursor=");
      if (!second) return { results: [filler, ...(on === 1 ? [child] : [])], has_more: on === 2, next_cursor: on === 2 ? "CUR" : null };
      return { results: on === 2 ? [child] : [], has_more: false, next_cursor: null };
    }
    if (method === "POST" && url.endsWith("/pages")) return { id: "eeeeeeee-0000-4000-8000-000000000005" };
    return undefined;
  });
}

for (const [on, label] of [
  [1, "on the first listing page"],
  [2, "on the SECOND listing page"],
] as const) {
  const rec = recorder();
  const outcome = await withPatchedFetch(notionScript(rec, on), () => PROVISIONERS.notion(NOTION_ENV, PLAN, NOTION_ROOM));
  ok(outcome.state === "found", `notion: an existing page ${label} is FOUND, not created`);
  ok(outcome.id === "bbbbbbbb-0000-4000-8000-000000000002", `notion: the found page's own id is returned (${label})`);
  ok(rec.creates(/^POST .*\/pages$/) === 0, `notion: NO page is created when one already exists ${label}`);
}

{
  const rec = recorder();
  const outcome = await withPatchedFetch(notionScript(rec, 0), () => PROVISIONERS.notion(NOTION_ENV, PLAN, NOTION_ROOM));
  ok(outcome.state === "created", "notion: an absent page IS created — the control for the two arms above");
  ok(rec.creates(/^POST .*\/pages$/) === 1, "notion: exactly one create request, never two");
  ok(outcome.id === "eeeeeeee-0000-4000-8000-000000000005", "notion: the created page's id is returned");
}

const DISCORD_ENV = { E2E_DISCORD_DRIVER_TOKEN: "t", E2E_DISCORD_CHANNEL: "111" };
const DISCORD_ROOM = ROOM("discord", "E2E_ADDRESSED_DISCORD_CHANNEL");
const WANT_DISCORD = roomName(PLAN.slug, "discord");

function discordScript(rec: Recorder, exists: boolean): typeof fetch {
  return scripted(rec, (url, method) => {
    if (url.includes("/channels/111")) return { id: "111", guild_id: "G1" };
    if (url.includes("/guilds/G1/channels") && method === "GET") return exists ? [{ id: "222", name: WANT_DISCORD }] : [{ id: "999", name: "other" }];
    if (url.includes("/guilds/G1/channels") && method === "POST") return { id: "333", name: WANT_DISCORD };
    return undefined;
  });
}

{
  const rec = recorder();
  const outcome = await withPatchedFetch(discordScript(rec, true), () => PROVISIONERS.discord(DISCORD_ENV, PLAN, DISCORD_ROOM));
  ok(outcome.state === "found" && outcome.id === "222", "discord: an existing channel is found by name");
  ok(rec.creates(/^POST/) === 0, "discord: NO channel is created when the name already exists");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(discordScript(rec, false), () => PROVISIONERS.discord(DISCORD_ENV, PLAN, DISCORD_ROOM));
  ok(outcome.state === "created" && outcome.id === "333", "discord: an absent channel IS created — the control");
  ok(rec.creates(/^POST/) === 1, "discord: exactly one create request");
}

const LINEAR_ENV = { E2E_LINEAR_API_KEY: "k" };
const LINEAR_ROOM = ROOM("linear", "E2E_ADDRESSED_LINEAR_TEAM_ID");
const WANT_LINEAR = roomName(PLAN.slug, "linear");

function linearScript(rec: Recorder, on: 0 | 1 | 2): typeof fetch {
  const team = { id: "T-EXISTING", name: WANT_LINEAR, key: "OEEA" };
  return scripted(rec, (_url, _method, body) => {
    const query = String((body as { query?: string }).query ?? "");
    if (query.includes("teamCreate")) return { data: { teamCreate: { success: true, team: { id: "T-NEW", name: WANT_LINEAR, key: "OEEA" } } } };
    const after = (body as { variables?: { after?: string | null } }).variables?.after ?? null;
    if (after === null) {
      return { data: { teams: { nodes: on === 1 ? [team] : [{ id: "X", name: "other" }], pageInfo: { hasNextPage: on === 2, endCursor: "CUR" } } } };
    }
    return { data: { teams: { nodes: on === 2 ? [team] : [], pageInfo: { hasNextPage: false, endCursor: null } } } };
  });
}

for (const [on, label] of [
  [1, "on the first page"],
  [2, "on the SECOND page"],
] as const) {
  const rec = recorder();
  const outcome = await withPatchedFetch(linearScript(rec, on), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM));
  ok(outcome.state === "found" && outcome.id === "T-EXISTING", `linear: an existing team ${label} is found by name`);
  ok(rec.calls.every((c) => !String((c.body as { query?: string }).query ?? "").includes("teamCreate")), `linear: NO team is created ${label}`);
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearScript(rec, 0), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM));
  ok(outcome.state === "created" && outcome.id === "T-NEW", "linear: an absent team IS created — the control");
  const creates = rec.calls.filter((c) => String((c.body as { query?: string }).query ?? "").includes("teamCreate"));
  ok(creates.length === 1, "linear: exactly one teamCreate");
  ok(String((creates[0].body as { variables?: { key?: string } }).variables?.key) === "OEEA", "linear: the team key comes from the plan, not from a derivation");
}

const LINEAR_OWN_KEY_ROOM: PlannedRoom = { ...ROOM("linear", "E2E_ADDRESSED_LINEAR_TEAM_ID"), credentialVar: "E2E_ADDRESSED_LINEAR_API_KEY" };
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearScript(rec, 1), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_OWN_KEY_ROOM));
  ok(outcome.state === "skipped", "linear: a room with its own `credentialVar` unset SKIPS — an absent credential is an operator step nobody took, never a red");
  ok(
    outcome.detail?.includes("E2E_ADDRESSED_LINEAR_API_KEY") === true,
    `linear: …and the skip NAMES the variable to set, so the operator is not left to guess which key (got: ${JSON.stringify(outcome.detail)})`,
  );
  ok(
    rec.calls.length === 0,
    `🔴 linear: NOT ONE vendor call is made without that key — falling back to the base key here would query the WRONG workspace and report its answer as this room's (saw ${rec.calls.length} call(s))`,
  );
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearScript(rec, 1), () =>
    PROVISIONERS.linear({ ...LINEAR_ENV, E2E_ADDRESSED_LINEAR_API_KEY: "own-workspace-key" }, PLAN, LINEAR_OWN_KEY_ROOM),
  );
  ok(outcome.state === "found" && outcome.id === "T-EXISTING", "linear: with its own key set, the room resolves exactly as any other");
  ok(
    rec.calls.length > 0 && rec.calls.every((c) => c.auth === "own-workspace-key"),
    `🔴 linear: EVERY request carries the ROOM's key, never the base one — the whole point of the variable, and a fallback that leaked through would silently query the base workspace (auths seen: ${JSON.stringify([...new Set(rec.calls.map((c) => c.auth))])})`,
  );
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearScript(rec, 1), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM));
  ok(outcome.state === "found", "linear: a room declaring NO `credentialVar` still resolves on the base driver key — the fallback is intact");
  ok(rec.calls.every((c) => c.auth === "k"), `linear: …and it is the base key on the wire (auths seen: ${JSON.stringify([...new Set(rec.calls.map((c) => c.auth))])})`);
}

function linearRefusingScript(rec: Recorder, extension?: string): typeof fetch {
  return scripted(rec, (_url, _method, body) => {
    const query = String((body as { query?: string }).query ?? "");
    if (query.includes("teamCreate")) {
      return {
        data: { teamCreate: null },
        errors: [{ message: "Access denied", ...(extension === undefined ? {} : { extensions: { userPresentableMessage: extension } }) }],
      };
    }
    return { data: { teams: { nodes: [{ id: "X", name: "other" }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  });
}

const PLAN_LIMIT = "You have reached the limit of teams allowed in your current plan.";
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearRefusingScript(rec, PLAN_LIMIT), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM));
  ok(outcome.state === "blocked", "linear: a refused teamCreate BLOCKS the room — it is never reported as created");
  ok(
    outcome.detail?.includes(PLAN_LIMIT) === true,
    `🔴 linear: …and the detail carries Linear's OWN reason, not the "Access denied" class — the whole difference between an operator who upgrades the plan and one who retries the create by hand (got: ${JSON.stringify(outcome.detail)})`,
  );
  ok(
    outcome.grant?.includes("READ THE DETAIL ABOVE FIRST") === true,
    `linear: …and the grant line sends the operator to that detail before its by-hand steps (got: ${JSON.stringify(outcome.grant)})`,
  );
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearRefusingScript(rec), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM));
  ok(outcome.state === "blocked", "linear: an error with no `userPresentableMessage` still blocks");
  ok(
    outcome.detail?.includes("Access denied") === true,
    `linear: …and falls back to \`message\`, so a refusal Linear does not annotate still names something (got: ${JSON.stringify(outcome.detail)})`,
  );
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(linearRefusingScript(rec, "   "), () => PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM));
  ok(
    outcome.detail?.includes("Access denied") === true,
    `🔴 linear: a BLANK \`userPresentableMessage\` falls back to \`message\` — an empty reason is worse than the class it replaced (got: ${JSON.stringify(outcome.detail)})`,
  );
}
{
  const rec = recorder();
  const guid = "00000000-0000-4000-8000-000000000020";
  const outcome = await withPatchedFetch(linearRefusingScript(rec, `Team ${guid} is not accessible`), () =>
    PROVISIONERS.linear(LINEAR_ENV, PLAN, LINEAR_ROOM),
  );
  ok(
    outcome.detail?.includes(guid) === false,
    `🔴 linear: the vendor's own text is REDACTED before it becomes operator prose — this string is published into docs/dev/e2e-fixtures.md (got: ${JSON.stringify(outcome.detail)})`,
  );
  ok(
    outcome.detail?.includes("<guid>") === true,
    `linear: …and the redaction leaves the sentence readable rather than dropping it (got: ${JSON.stringify(outcome.detail)})`,
  );
}

const SLACK_ENV = { E2E_SLACK_USER_TOKEN: "t", E2E_SLACK_BOT_USER_ID: "UBOT" };
const SLACK_ROOM = ROOM("slack", "E2E_ADDRESSED_SLACK_CHANNEL");
const WANT_SLACK = roomName(PLAN.slug, "slack");

function slackScript(rec: Recorder, on: 0 | 1 | 2 | 3): typeof fetch {
  const want = { id: "CFOUND", name: WANT_SLACK, is_archived: on === 3 };
  const other = { id: "COTHER", name: "unrelated", is_archived: false };
  return scripted(rec, (url) => {
    if (url.includes("conversations.list")) {
      const second = url.includes("cursor=");
      if (!second) {
        return {
          ok: true,
          channels: [other, ...(on === 1 || on === 3 ? [want] : [])],
          response_metadata: { next_cursor: on === 2 ? "CUR" : "" },
        };
      }
      return { ok: true, channels: on === 2 ? [want] : [], response_metadata: { next_cursor: "" } };
    }
    if (url.includes("conversations.create")) return { ok: true, channel: { id: "CNEW" } };
    if (url.includes("conversations.invite")) return { ok: true };
    return undefined;
  });
}

for (const [on, label] of [
  [1, "on the first page"],
  [2, "on the SECOND page"],
] as const) {
  const rec = recorder();
  const outcome = await withPatchedFetch(slackScript(rec, on), () => PROVISIONERS.slack(SLACK_ENV, PLAN, SLACK_ROOM));
  ok(outcome.state === "found" && outcome.id === "CFOUND", `slack: an existing channel ${label} is found by name`);
  ok(rec.creates(/conversations\.create/) === 0, `slack: NO channel is created when the name already exists ${label}`);
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(slackScript(rec, 0), () => PROVISIONERS.slack(SLACK_ENV, PLAN, SLACK_ROOM));
  ok(outcome.state === "created" && outcome.id === "CNEW", "slack: an absent channel IS created — the control");
  ok(rec.creates(/conversations\.create/) === 1, "slack: exactly one create request");
  ok(rec.creates(/conversations\.invite/) === 1, "slack: the OE bot is invited to the channel it just made");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(slackScript(rec, 3), () => PROVISIONERS.slack(SLACK_ENV, PLAN, SLACK_ROOM));
  ok(outcome.state === "blocked", "slack: an ARCHIVED channel of the wanted name blocks, never reads as found");
  ok(outcome.id === undefined, "slack: …and no dead id is handed back to be written into .env.e2e");
  ok((outcome.grant ?? "").toLowerCase().includes("unarchive"), "slack: …and the block names unarchiving as the fix");
  ok(rec.creates(/conversations\.create/) === 0, "slack: …and nothing is created over an archived name");
}

const GITHUB_ENV = { E2E_GITHUB_DRIVER_TOKEN: "t" };
const GITHUB_ROOM = ROOM("github", "E2E_ADDRESSED_GITHUB_REPO");
const WANT_GITHUB = roomName(PLAN.slug, "github");

function githubScript(rec: Recorder, on: "private" | "public" | "archived" | "absent"): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    rec.calls.push({ method, url, body, auth: String(new Headers(init?.headers).get("authorization") ?? "") });
    if (url.endsWith("/user")) return Response.json({ login: "owner1" });
    if (url.endsWith(`/repos/owner1/${WANT_GITHUB}`)) {
      if (on === "absent") return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ full_name: `owner1/${WANT_GITHUB}`, private: on !== "public", archived: on === "archived" });
    }
    if (method === "POST" && url.endsWith("/user/repos")) return Response.json({ full_name: `owner1/${WANT_GITHUB}` }, { status: 201 });
    throw new Error(`the test script has no route for ${method} ${url}`);
  }) as typeof fetch;
}

{
  const rec = recorder();
  const outcome = await withPatchedFetch(githubScript(rec, "private"), () => PROVISIONERS.github(GITHUB_ENV, PLAN, GITHUB_ROOM));
  ok(outcome.state === "found" && outcome.id === `owner1/${WANT_GITHUB}`, "github: an existing PRIVATE repo is found by name");
  ok(rec.creates(/^POST .*\/user\/repos$/) === 0, "github: NO repo is created when the name already exists");
  ok((outcome.grant ?? "").includes("App"), "github: …and the App installation still prints, because no PAT can read it back");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(githubScript(rec, "absent"), () => PROVISIONERS.github(GITHUB_ENV, PLAN, GITHUB_ROOM));
  ok(outcome.state === "created" && outcome.id === `owner1/${WANT_GITHUB}`, "github: an absent repo IS created — the control for the arm above");
  ok(rec.creates(/^POST .*\/user\/repos$/) === 1, "github: exactly one create request, never two");
  const create = rec.calls.find((c) => c.method === "POST")!;
  ok((create.body as { private?: boolean }).private === true, "github: the created repo is PRIVATE — the journey's non-mention arm refuses a public one");
  ok((create.body as { name?: string }).name === WANT_GITHUB, "github: …and it is created under the plan's own room name");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(githubScript(rec, "public"), () => PROVISIONERS.github(GITHUB_ENV, PLAN, GITHUB_ROOM));
  ok(outcome.state === "blocked", "github: a PUBLIC repo of the wanted name blocks, never reads as found");
  ok(outcome.id === undefined, "github: …and no id for a repo the journey would refuse is handed back to .env.e2e");
  ok((outcome.grant ?? "").toLowerCase().includes("private"), "github: …and the block names making it private as the fix");
  ok(rec.creates(/^POST/) === 0, "github: …and nothing is created over the existing name");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(githubScript(rec, "archived"), () => PROVISIONERS.github(GITHUB_ENV, PLAN, GITHUB_ROOM));
  ok(outcome.state === "blocked", "github: an ARCHIVED repo of the wanted name blocks, never reads as found");
  ok(outcome.id === undefined, "github: …and no read-only repo's id is handed back to .env.e2e");
  ok((outcome.detail ?? "").includes("ARCHIVED"), "github: …and the refusal names what is wrong with it");
  ok(rec.creates(/^POST/) === 0, "github: …and nothing is created over the existing name");
}
{
  const outcome = await PROVISIONERS.github({}, PLAN, GITHUB_ROOM);
  ok(outcome.state === "skipped", "github: with no driver token the surface is SKIPPED, never blocked on a vendor it never called");
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-envfile-"));
  const file = join(dir, ".env.e2e");
  writeFileSync(file, "# a comment\nE2E_SLACK_CHANNEL=CKEEP\nE2E_ADDRESSED_NOTION_PAGE_ID=OLD\n", "utf8");
  writeEnvE2e(file, new Map([["E2E_ADDRESSED_NOTION_PAGE_ID", "NEW"], ["E2E_ADDRESSED_DISCORD_CHANNEL", "D1"]]));
  const after = readFileSync(file, "utf8");
  ok(after.includes("E2E_SLACK_CHANNEL=CKEEP"), "writeEnvE2e leaves a var it was not given alone");
  ok(after.includes("# a comment"), "writeEnvE2e leaves comments alone");
  ok(after.includes("E2E_ADDRESSED_NOTION_PAGE_ID=NEW") && !after.includes("=OLD"), "writeEnvE2e replaces a var it was given rather than appending a second copy");
  ok(after.includes("E2E_ADDRESSED_DISCORD_CHANNEL=D1"), "writeEnvE2e appends a var the file did not have");
  ok(loadEnvFile(file).E2E_SLACK_CHANNEL === "CKEEP", "loadEnvFile reads a written file back");
  ok(Object.keys(loadEnvFile(join(dir, "absent"))).length === 0, "loadEnvFile on a missing file is empty, never a throw");
}

ok(
  redactGuids("teams POST /teams/12345678-90ab-4cde-8f01-23456789abcd/channels failed") === "teams POST /teams/<guid>/channels failed",
  "redactGuids strips a tenant/team GUID out of a Graph error path",
);
ok(redactGuids("12345678-90AB-4CDE-8F01-23456789ABCD") === "<guid>", "redactGuids is case-insensitive");
ok(redactGuids("channel C0EXCHAN003 is fine") === "channel C0EXCHAN003 is fine", "redactGuids leaves a non-GUID id alone");

{
  const { reachable, blind } = reachableSurfaces({ E2E_SLACK_USER_TOKEN: "t" });
  ok(reachable.has("slack"), "a surface with its driver credential is reachable");
  ok(!reachable.has("discord") && blind.includes("discord"), "a surface without its credential is blind, never silently reachable");
  ok(reachableSurfaces({}).blind.length === 6, "with no credential at all, every surface is blind");
}
ok(notionTitleOf({ properties: { Name: { type: "title", title: [{ plain_text: "oe-e2e" }] } } }) === "oe-e2e", "notionTitleOf reads whichever property is the title");
ok(notionTitleOf({ properties: { Other: { type: "rich_text" } } }) === undefined, "notionTitleOf returns nothing when no property is a title");

const MPIM_ENV = { E2E_SLACK_USER_TOKEN: "t", E2E_SLACK_BOT_USER_ID: "UBOT", E2E_SLACK_USER2_ID: "U2" };

function mpimScript(rec: Recorder, answer: unknown): typeof fetch {
  return scripted(rec, (url) => (url.includes("conversations.open") ? answer : undefined));
}

{
  const rec = recorder();
  const outcome = await withPatchedFetch(mpimScript(rec, { ok: true, channel: { id: "GMPIM1" } }), () => provisionSlackMpim(MPIM_ENV));
  ok(outcome.state === "opened" && outcome.id === "GMPIM1", "mpim: conversations.open returns the group DM's id");
  const body = rec.calls.find((c) => c.url.includes("conversations.open"))?.body as { users?: string } | undefined;
  ok(body?.users === "UBOT,U2", "🔴 mpim: …opened over the OE BOT and a third member — two users plus the token's own identity is what makes it an mpim rather than a 1:1");
  ok(
    outcome.detail.includes("E2E_SLACK_USER2_ID") && !outcome.detail.includes("U2") && !outcome.detail.includes("UBOT"),
    `🔴 mpim: the outcome names the VARIABLES its members came from, never the user ids — BOTH of them, so a later "opened over UBOT and …" cannot slip a Slack user id into a run log (got: ${JSON.stringify(outcome.detail)})`,
  );
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(mpimScript(rec, { ok: true, channel: { id: "GMPIM1" } }), () =>
    provisionSlackMpim({ E2E_SLACK_USER_TOKEN: "t", E2E_SLACK_BOT_USER_ID: "UBOT" }),
  );
  ok(outcome.state === "blocked", "mpim: with no third member the room is BLOCKED");
  ok(rec.calls.length === 0, "…and Slack is never called — the refusal precedes the vendor, so no room is opened by accident");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(mpimScript(rec, { ok: false, error: "missing_scope", needed: "mpim:write", provided: "im:write,chat:write" }), () =>
    provisionSlackMpim(MPIM_ENV),
  );
  ok(outcome.state === "blocked" && outcome.id === undefined, "mpim: a refused open BLOCKS and publishes no id");
  ok(outcome.detail.includes("mpim:write"), `🔴 mpim: …and the detail carries Slack's own \`needed\` scope, not just the "missing_scope" class (got: ${JSON.stringify(outcome.detail)})`);
  ok(outcome.grant?.includes("mpim:write") === true, "mpim: …and the grant line names the same scope to add to the driver app");
  ok(
    !outcome.detail.includes("chat:write") && outcome.grant?.includes("chat:write") !== true,
    "🔴 mpim: …and never Slack's `provided` list — what the token DOES hold is nobody's business in a report",
  );
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(mpimScript(rec, { ok: false, error: "user_not_found" }), () => provisionSlackMpim(MPIM_ENV));
  ok(outcome.state === "blocked" && outcome.detail.includes("user_not_found"), "mpim: a refusal with no `needed` still names Slack's error");
}
{
  const rec = recorder();
  const outcome = await withPatchedFetch(mpimScript(rec, { ok: true, channel: { id: "D0DM" } }), () => provisionSlackMpim(MPIM_ENV));
  ok(outcome.state === "blocked" && outcome.id === undefined, "🔴 mpim: a `D…` 1:1 is REFUSED and never published as the group DM");
  ok(
    !outcome.detail.includes("UBOT") && !outcome.detail.includes("U2"),
    `mpim: …and that refusal names its two member variables, never their user ids (got: ${JSON.stringify(outcome.detail)})`,
  );
}

console.log(`✓ fixture-inventory-provision: ${passed} assertions passed`);
