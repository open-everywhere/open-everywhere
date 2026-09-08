import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVISION_PLAN,
  SURFACE_ORDER,
  buildInventory,
  canonicalId,
  collectDeclaredRooms,
  compareInventory,
  createGuardRefusal,
  inventoryVars,
  namesLost,
  parseInventoryDoc,
  planFor,
  renderInventoryDoc,
  resolutionKey,
  roomName,
  roomsUnseen,
  type BindingLike,
  type DomainLike,
  type PlannedRoom,
  type ProvisionDomain,
  type Resolution,
  type SurfaceKind,
} from "./fixture-inventory-lib.js";
import { DEFAULT_TEAMS_REFRESH_SINK, ENV } from "./env.js";
import { TeamsDriver } from "./teams-driver.js";
import { loadDomains } from "../../../../agent/memory/config/domains.js";
import { loadBindings } from "../../../../agent/access/bundles.js";

type Env = Record<string, string | undefined>;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const INVENTORY_DOC = join("docs", "dev", "e2e-fixtures.md");
const ENV_E2E = join(REPO_ROOT, ".env.e2e");

const TIMEOUT_MS = 15_000;

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${what} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        res(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        rej(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function resolvedEnv(): Env {
  return { ...loadEnvFile(ENV_E2E), ...process.env };
}

function reason(err: unknown): string {
  return vendorDetail(err instanceof Error ? err.message : String(err));
}

export function redactGuids(text: string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<guid>");
}

function vendorDetail(text: string, limit = 300): string {
  const clean = redactGuids(text).replace(/\s+/gu, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

async function slackApi(token: string, method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}${qs ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as Record<string, unknown>;
}

async function slackPost(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function discordApi(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> | unknown[] }> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bot ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> | unknown[];
  return { status: res.status, json };
}

async function githubApi(token: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

interface GraphqlAnswer {
  readonly data?: Record<string, unknown>;
  readonly errors?: { message?: string }[];
}

async function linearGraphql(apiKey: string, query: string, variables: Record<string, unknown>): Promise<GraphqlAnswer> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json().catch(() => ({}))) as GraphqlAnswer;
  if (!res.ok && !json.errors) return { errors: [{ message: `http ${res.status}` }] };
  return json;
}

async function notionApi(
  key: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "notion-version": "2022-06-28",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function notionTitleOf(page: Record<string, unknown>): string | undefined {
  const props = page.properties as Record<string, { type?: string; title?: { plain_text?: string }[] }> | undefined;
  if (!props) return undefined;
  for (const prop of Object.values(props)) {
    if (prop?.type !== "title") continue;
    const text = (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
    if (text) return text;
  }
  return undefined;
}

export function reachableSurfaces(env: Env): { reachable: Set<SurfaceKind>; blind: SurfaceKind[] } {
  const has = (name: string): boolean => Boolean(env[name]?.trim());
  const state: Record<SurfaceKind, boolean> = {
    slack: has(ENV.slackUserToken),
    discord: has(ENV.discordDriverToken),
    teams: [ENV.teamsTenantId, ENV.teamsClientId, ENV.teamsRefreshToken, ENV.teamsTeamId, ENV.teamsBotAppId].every(has),
    github: has(ENV.githubDriverToken),
    linear: has(ENV.linearApiKey),
    notion: has(ENV.notionDriverKey),
  };
  const reachable = new Set<SurfaceKind>(SURFACE_ORDER.filter((s) => state[s]));
  return { reachable, blind: SURFACE_ORDER.filter((s) => !state[s]) };
}

interface ResolverContext {
  readonly env: Env;
  slackTeamId?: string;
  teams?: TeamsDriver;
}

async function resolveSlackRoom(ctx: ResolverContext, id: string): Promise<Resolution> {
  const token = ctx.env[ENV.slackUserToken]!;
  const info = await slackApi(token, "conversations.info", { channel: id });
  if (info.ok === true) {
    const channel = info.channel as { name?: string; is_archived?: boolean; is_im?: boolean } | undefined;
    const name = channel?.is_im ? "(direct message)" : `#${channel?.name ?? "?"}`;
    return {
      ok: true,
      name: channel?.is_archived ? `${name} (archived)` : name,
      key: ctx.slackTeamId ? `slack/${ctx.slackTeamId}/${id}` : undefined,
      detail: "conversations.info",
    };
  }
  if (info.error === "missing_scope" || info.error === "channel_not_found") {
    const history = await slackApi(token, "conversations.history", { channel: id, limit: "1" });
    if (history.ok === true) {
      return {
        ok: true,
        name: "(direct message — `conversations.info` needs `im:read`)",
        key: ctx.slackTeamId ? `slack/${ctx.slackTeamId}/${id}` : undefined,
        detail: "conversations.history",
      };
    }
  }
  return { ok: false, detail: `conversations.info: ${String(info.error ?? "unknown")}` };
}

async function resolveDiscordRoom(ctx: ResolverContext, id: string): Promise<Resolution> {
  const token = ctx.env[ENV.discordDriverToken]!;
  const res = await discordApi(token, `/channels/${id}`);
  if (res.status !== 200) return { ok: false, detail: `GET /channels → ${res.status}` };
  const json = res.json as Record<string, unknown>;
  const guild = typeof json.guild_id === "string" ? json.guild_id : undefined;
  return { ok: true, name: `#${String(json.name ?? "?")}`, key: guild ? `discord/${guild}/${id}` : undefined, detail: "GET /channels/{id}" };
}

async function resolveTeamsRoom(ctx: ResolverContext, id: string): Promise<Resolution> {
  if (!ctx.teams) return { ok: false, detail: "no Teams driver" };
  const teamId = ctx.env[ENV.teamsTeamId]!;
  if (id === teamId) {
    const info = await ctx.teams.teamInfo();
    return { ok: true, name: info.displayName || "(unnamed team)", detail: "GET /teams/{id}" };
  }
  const channels = await ctx.teams.channels();
  const found = channels.find((c) => c.id === id);
  if (!found) return { ok: false, detail: "not in GET /teams/{team}/channels" };
  return { ok: true, name: found.displayName || "(unnamed channel)", detail: "GET /teams/{team}/channels" };
}

async function resolveGithubRoom(ctx: ResolverContext, id: string): Promise<Resolution> {
  const res = await githubApi(ctx.env[ENV.githubDriverToken]!, `/repos/${id}`);
  if (res.status !== 200) return { ok: false, detail: `GET /repos → ${res.status}` };
  const full = String(res.json.full_name ?? id);
  return { ok: true, name: full, key: `github/${full}`, detail: "GET /repos/{owner}/{repo}" };
}

async function resolveLinearRoom(ctx: ResolverContext, id: string): Promise<Resolution> {
  const keys = [ctx.env[ENV.linearApiKey], ctx.env[ENV.linearSoakDriverKey]].filter((k): k is string => Boolean(k?.trim()));
  let last = "no Linear key";
  for (const key of keys) {
    const answer = await linearGraphql(key, `query($id:String!){ team(id:$id){ id name key organization { id } } }`, { id });
    const team = (answer.data?.team ?? undefined) as { name?: string; key?: string; organization?: { id?: string } } | undefined;
    if (team?.name) {
      const org = team.organization?.id;
      return { ok: true, name: `${team.name} (${team.key ?? "?"})`, key: org ? `linear/${org}/${id}` : undefined, detail: "team(id)" };
    }
    last = answer.errors?.map((e) => e.message).join("; ") ?? "team(id) returned nothing";
  }
  return { ok: false, detail: last };
}

async function resolveNotionRoom(ctx: ResolverContext, id: string): Promise<Resolution> {
  const key = ctx.env[ENV.notionDriverKey]!;
  const res = await notionApi(key, `/pages/${id}`);
  if (res.status !== 200) return { ok: false, detail: `pages.retrieve → ${res.status} ${String(res.json.code ?? "")}`.trim() };
  const workspace = ctx.env[ENV.notionWorkspaceId]?.trim();
  return {
    ok: true,
    name: notionTitleOf(res.json) ?? "(untitled page)",
    key: workspace ? `notion/${workspace}/${canonicalId("notion", id)}` : undefined,
    detail: "pages.retrieve",
  };
}

const RESOLVERS: Record<SurfaceKind, (ctx: ResolverContext, id: string) => Promise<Resolution>> = {
  slack: resolveSlackRoom,
  discord: resolveDiscordRoom,
  teams: resolveTeamsRoom,
  github: resolveGithubRoom,
  linear: resolveLinearRoom,
  notion: resolveNotionRoom,
};

function configRooms(): { domains: readonly DomainLike[]; bindings: readonly BindingLike[] } {
  return { domains: loadDomains() as readonly DomainLike[], bindings: loadBindings() as readonly BindingLike[] };
}

export interface InventoryOptions {
  readonly check: boolean;
  readonly warnOnly: boolean;
  readonly partial: boolean;
  readonly ifArmed: boolean;
}

export const ARMING_VAR = "E2E_FIXTURE_TABLE_CHECK";

async function runInventory(env: Env, options: InventoryOptions): Promise<number> {
  if (options.ifArmed && env[ARMING_VAR]?.trim() !== "1") {
    console.log(`~ e2e:fixtures inventory --check: not armed. Set ${ARMING_VAR}=1 with the e2e credentials to compare ${INVENTORY_DOC} against the live rooms.`);
    return 0;
  }
  const { reachable, blind } = reachableSurfaces(env);
  const { domains, bindings } = configRooms();
  const declared = collectDeclaredRooms(domains, bindings);

  const ctx: ResolverContext = { env };
  if (reachable.has("slack")) {
    const auth = await withTimeout(slackApi(env[ENV.slackUserToken]!, "auth.test"), "slack auth.test").catch(() => ({}) as Record<string, unknown>);
    if (typeof auth.team_id === "string") ctx.slackTeamId = auth.team_id;
  }
  if (reachable.has("teams")) {
    ctx.teams = new TeamsDriver({
      tenantId: env[ENV.teamsTenantId]!,
      clientId: env[ENV.teamsClientId]!,
      refreshToken: env[ENV.teamsRefreshToken]!,
      teamId: env[ENV.teamsTeamId]!,
      channelId: env[ENV.teamsChannelId] ?? "",
      refreshTokenFile: env[ENV.teamsRefreshTokenFile]?.trim() || DEFAULT_TEAMS_REFRESH_SINK,
      botAppId: env[ENV.teamsBotAppId]!,
    });
  }

  const wanted = new Map<string, { surface: SurfaceKind; id: string }>();
  for (const room of declared) {
    if (room.synthetic || room.container) continue;
    const id = room.key.startsWith("github/") ? room.key.slice("github/".length) : room.key.split("/").pop()!;
    wanted.set(resolutionKey(room.surface, id), { surface: room.surface, id });
  }
  for (const spec of inventoryVars()) {
    if (spec.neverProbe) continue;
    const raw = env[spec.envVar]?.trim();
    if (!raw) continue;
    const id = spec.surface === "teams" && raw.startsWith("teams/") ? raw.split("/").pop()! : raw;
    wanted.set(resolutionKey(spec.surface, id), { surface: spec.surface, id });
  }

  const resolutions = new Map<string, Resolution>();
  for (const [key, { surface, id }] of wanted) {
    if (!reachable.has(surface)) continue;
    const answer = await withTimeout(RESOLVERS[surface](ctx, id), `${surface} lookup`).catch((err: unknown) => ({
      ok: false as const,
      detail: reason(err),
    }));
    resolutions.set(key, answer);
  }

  const teamsRosterVisible = Boolean(env.OE_TEAMS_INTERNAL_SURFACES?.trim() || env.OE_TEAMS_E2E_UNIFIED_SURFACE?.trim());
  const inventory = buildInventory({ envValues: env, declared, resolutions, unresolvableSurfaces: blind, teamsRosterVisible });
  const generated = renderInventoryDoc(inventory, { unresolvableSurfaces: blind });
  const docPath = join(REPO_ROOT, INVENTORY_DOC);

  if (!options.check) {
    if (blind.length > 0 && !options.partial) {
      console.error(`✗ e2e:fixtures inventory: no credential for ${blind.join(", ")} — writing now would drop those rows.`);
      console.error("  Set the driver credentials for every surface, or pass --partial to write anyway.");
      return 2;
    }
    const committedNow = existsSync(docPath) ? parseInventoryDoc(readFileSync(docPath, "utf8")) : [];
    const lost = namesLost(committedNow, inventory.rows);
    if (lost.length > 0 && !options.partial) {
      console.error(`✗ e2e:fixtures inventory: ${lost.length} room(s) this run could not resolve already carry a name in ${INVENTORY_DOC}:`);
      for (const l of lost) console.error(`    ${l}`);
      console.error("  Check the credential reaches those rooms. Pass --partial only if the rooms are genuinely gone.");
      return 2;
    }
    const unseen = roomsUnseen(committedNow, env);
    if (unseen.length > 0 && !options.partial) {
      console.error(`✗ e2e:fixtures inventory: ${unseen.length} room(s) in ${INVENTORY_DOC} name an env var this environment does not set:`);
      for (const u of unseen) console.error(`    ${u}`);
      console.error("  Set those variables, or pass --partial to write a table without those rooms.");
      return 2;
    }
    writeFileSync(docPath, generated, "utf8");
    console.log(`✓ e2e:fixtures inventory: wrote ${INVENTORY_DOC} — ${inventory.rows.length} rooms, ${inventory.flags.length} flag(s).`);
    for (const flag of inventory.flags) console.log(`  ! ${flag.kind}: ${flag.surface} ${flag.subject} — ${flag.detail}`);
    if (blind.length > 0) console.log(`  ~ not looked up (no credential): ${blind.join(", ")}`);
    return 0;
  }

  const mark = options.warnOnly ? "WARNING" : "✗";
  if (!existsSync(docPath)) {
    console.log(`${mark} e2e:fixtures inventory --check: ${INVENTORY_DOC} does not exist.`);
    return options.warnOnly ? 0 : 1;
  }
  const visibleRows = inventory.rows.filter((r) => !blind.includes(r.surface));
  const committed = parseInventoryDoc(readFileSync(docPath, "utf8")).filter((r) => !blind.includes(r.surface));
  const verdict = compareInventory(committed, visibleRows, env);
  if (!verdict.stale) {
    if (visibleRows.length === 0) {
      console.log(`~ e2e:fixtures inventory --check: nothing compared — no credential for ${blind.join(", ")}. ${INVENTORY_DOC} is unverified.`);
      return 0;
    }
    const skipped = blind.length > 0 ? ` (${blind.join(", ")} not compared — no credential)` : "";
    console.log(`✓ e2e:fixtures inventory --check: ${INVENTORY_DOC} matches the live rooms${skipped}.`);
    return 0;
  }
  console.log(`${mark} e2e:fixtures inventory --check: ${INVENTORY_DOC} is stale — re-run \`npm run e2e:fixtures -- inventory\`.`);
  for (const r of verdict.reasons) console.log(`    ${r}`);
  return options.warnOnly ? 0 : 1;
}

export type ProvisionTarget = Pick<ProvisionDomain, "slug" | "linearKey">;

export interface ProvisionOutcome {
  readonly room: PlannedRoom;
  readonly state: "reused" | "found" | "created" | "blocked" | "skipped";
  readonly id?: string;
  readonly name?: string;
  readonly detail: string;
  readonly grant?: string;
}

async function provisionSlack(env: Env, plan: ProvisionTarget, room: PlannedRoom): Promise<ProvisionOutcome> {
  const token = env[ENV.slackUserToken];
  if (!token) return { room, state: "skipped", detail: `no ${ENV.slackUserToken}` };
  const want = roomName(plan.slug, "slack");
  let cursor: string | undefined;
  do {
    const list = await slackApi(token, "conversations.list", {
      types: "public_channel,private_channel",
      limit: "200",
      exclude_archived: "false",
      ...(cursor ? { cursor } : {}),
    });
    if (list.ok !== true) break;
    const channels = (list.channels as { id?: string; name?: string; is_archived?: boolean }[] | undefined) ?? [];
    const found = channels.find((c) => c.name === want);
    if (found?.id && found.is_archived === true) {
      return {
        room,
        state: "blocked",
        detail: `#${want} exists but is ARCHIVED — its id would be a dead room`,
        grant: `Slack: unarchive #${want} (channel → settings → Unarchive), then re-run this command.`,
      };
    }
    if (found?.id) return { room, state: "found", id: found.id, name: `#${want}`, detail: "already exists" };
    cursor = (list.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);
  const created = await slackPost(token, "conversations.create", { name: want, is_private: true });
  if (created.ok !== true) {
    if (created.error === "missing_scope" || created.error === "not_allowed_token_type") {
      return {
        room,
        state: "blocked",
        detail: `conversations.create: ${String(created.error)}`,
        grant: "Slack: add the `groups:write` (private) / `channels:manage` (public) user scope to the driver app and reinstall — a new xoxp is minted.",
      };
    }
    return { room, state: "blocked", detail: `conversations.create: ${String(created.error ?? "unknown")}` };
  }
  const id = (created.channel as { id?: string } | undefined)?.id;
  const botUserId = env[ENV.slackBotUserId];
  if (id && botUserId) await slackPost(token, "conversations.invite", { channel: id, users: botUserId });
  return { room, state: "created", id, name: `#${want}`, detail: botUserId ? "created and the OE bot invited" : "created; no bot user id to invite" };
}

async function provisionDiscord(env: Env, plan: ProvisionTarget, room: PlannedRoom): Promise<ProvisionOutcome> {
  const token = env[ENV.discordDriverToken];
  const anchor = env[ENV.discordChannel];
  if (!token || !anchor) return { room, state: "skipped", detail: `no ${ENV.discordDriverToken} / ${ENV.discordChannel}` };
  const anchorInfo = await discordApi(token, `/channels/${anchor}`);
  const guild = (anchorInfo.json as Record<string, unknown>).guild_id;
  if (typeof guild !== "string") return { room, state: "blocked", detail: `could not read the guild id from ${ENV.discordChannel}` };
  const want = roomName(plan.slug, "discord");
  const channels = await discordApi(token, `/guilds/${guild}/channels`);
  if (channels.status === 200 && Array.isArray(channels.json)) {
    const found = (channels.json as { id?: string; name?: string }[]).find((c) => c.name === want);
    if (found?.id) return { room, state: "found", id: found.id, name: `#${want}`, detail: "already exists" };
  }
  const created = await discordApi(token, `/guilds/${guild}/channels`, { method: "POST", body: { name: want, type: 0 } });
  if (created.status === 403) {
    return {
      room,
      state: "blocked",
      detail: "POST /guilds/{guild}/channels → 403",
      grant: "Discord: give the driver bot the Manage Channels permission in the test guild (Server Settings → Roles).",
    };
  }
  if (created.status < 200 || created.status >= 300) {
    return { room, state: "blocked", detail: `POST /guilds/{guild}/channels → ${created.status}` };
  }
  const id = (created.json as Record<string, unknown>).id;
  return { room, state: "created", id: typeof id === "string" ? id : undefined, name: `#${want}`, detail: "created" };
}

async function provisionTeams(env: Env, plan: ProvisionTarget, room: PlannedRoom): Promise<ProvisionOutcome> {
  const { reachable } = reachableSurfaces(env);
  if (!reachable.has("teams")) return { room, state: "skipped", detail: "the Teams driver's vars are not all set" };
  const driver = new TeamsDriver({
    tenantId: env[ENV.teamsTenantId]!,
    clientId: env[ENV.teamsClientId]!,
    refreshToken: env[ENV.teamsRefreshToken]!,
    teamId: env[ENV.teamsTeamId]!,
    channelId: env[ENV.teamsChannelId] ?? "",
    refreshTokenFile: env[ENV.teamsRefreshTokenFile]?.trim() || DEFAULT_TEAMS_REFRESH_SINK,
    botAppId: env[ENV.teamsBotAppId]!,
  });
  const want = roomName(plan.slug, "teams");
  try {
    const existing = (await driver.channels()).find((c) => c.displayName === want);
    if (existing) return { room, state: "found", id: `teams/${env[ENV.teamsTenantId]}/${existing.id}`, name: want, detail: "already exists" };
  } catch (err) {
    return { room, state: "blocked", detail: `GET /teams/{team}/channels: ${reason(err)}` };
  }
  try {
    const created = await driver.createChannel(want, "OE e2e addressed-only fixture (OPE-1503)");
    return { room, state: "created", id: `teams/${env[ENV.teamsTenantId]}/${created.id}`, name: want, detail: "created" };
  } catch (err) {
    return {
      room,
      state: "blocked",
      detail: `POST /teams/{team}/channels: ${reason(err)}`,
      grant:
        "Teams: add the delegated Graph permission `Channel.Create` to the driver's Entra app registration, grant admin consent, then re-mint the refresh token with `npm run e2e:teams-auth`.",
    };
  }
}

async function provisionLinear(env: Env, plan: ProvisionTarget, room: PlannedRoom): Promise<ProvisionOutcome> {
  const apiKey = env[ENV.linearApiKey];
  if (!apiKey) return { room, state: "skipped", detail: `no ${ENV.linearApiKey}` };
  const want = roomName(plan.slug, "linear");
  let after: string | null = null;
  do {
    const page: GraphqlAnswer = await linearGraphql(
      apiKey,
      `query($after:String){ teams(first:250, after:$after){ nodes { id name key } pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    const teams = page.data?.teams as
      | { nodes?: { id?: string; name?: string }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
      | undefined;
    const found = (teams?.nodes ?? []).find((t) => t.name === want);
    if (found?.id) return { room, state: "found", id: found.id, name: want, detail: "already exists" };
    after = teams?.pageInfo?.hasNextPage ? (teams.pageInfo.endCursor ?? null) : null;
  } while (after);
  const key = plan.linearKey;
  const created = await linearGraphql(
    apiKey,
    `mutation($name:String!,$key:String!){ teamCreate(input:{name:$name, key:$key}){ success team { id name key } } }`,
    { name: want, key },
  );
  const team = (created.data?.teamCreate as { team?: { id?: string } } | undefined)?.team;
  if (!team?.id) {
    const detail = created.errors?.map((e) => e.message).join("; ") ?? "teamCreate returned no team";
    return {
      room,
      state: "blocked",
      detail: `teamCreate: ${detail}`,
      grant: "Linear: the driver PAT must belong to a workspace ADMIN (team creation is an admin action), or an admin creates the team by hand.",
    };
  }
  return { room, state: "created", id: team.id, name: want, detail: "created" };
}

async function provisionNotion(env: Env, plan: ProvisionTarget, room: PlannedRoom): Promise<ProvisionOutcome> {
  const key = env[ENV.notionDriverKey];
  const anchor = env[ENV.notionAmbientPageId];
  if (!key || !anchor) return { room, state: "skipped", detail: `no ${ENV.notionDriverKey} / ${ENV.notionAmbientPageId}` };
  const anchorPage = await notionApi(key, `/pages/${anchor}`);
  if (anchorPage.status !== 200) return { room, state: "blocked", detail: `pages.retrieve(${ENV.notionAmbientPageId}) → ${anchorPage.status}` };
  const parent = anchorPage.json.parent as { type?: string; page_id?: string } | undefined;
  const parentPageId = parent?.type === "page_id" ? parent.page_id : anchor;
  if (!parentPageId) return { room, state: "blocked", detail: "the e2e page has no page parent to create under" };
  const want = roomName(plan.slug, "notion");
  let start: string | undefined;
  do {
    const children = await notionApi(key, `/blocks/${parentPageId}/children?page_size=100${start ? `&start_cursor=${start}` : ""}`);
    if (children.status !== 200) return { room, state: "blocked", detail: `blocks.children → ${children.status}` };
    const results = (children.json.results ?? []) as { id?: string; type?: string; child_page?: { title?: string } }[];
    const found = results.find((b) => b.type === "child_page" && b.child_page?.title === want);
    if (found?.id) return { room, state: "found", id: canonicalId("notion", found.id), name: want, detail: "already exists" };
    start = children.json.has_more === true && typeof children.json.next_cursor === "string" ? children.json.next_cursor : undefined;
  } while (start);
  const created = await notionApi(key, "/pages", {
    method: "POST",
    body: { parent: { page_id: parentPageId }, properties: { title: [{ type: "text", text: { content: want } }] } },
  });
  if (created.status < 200 || created.status >= 300) {
    return {
      room,
      state: "blocked",
      detail: `pages.create → ${created.status} ${String(created.json.code ?? "")}`.trim(),
      grant: "Notion: connect the driver integration to the e2e page's PARENT page (⋯ → Connections), so a child page can be created under it.",
    };
  }
  const id = created.json.id;
  return { room, state: "created", id: typeof id === "string" ? canonicalId("notion", id) : undefined, name: want, detail: "created" };
}

export const PROVISIONERS: Record<SurfaceKind, (env: Env, plan: ProvisionTarget, room: PlannedRoom) => Promise<ProvisionOutcome>> = {
  slack: provisionSlack,
  discord: provisionDiscord,
  teams: provisionTeams,
  github: async (_env, _plan, room) => ({
    room,
    state: "blocked",
    detail: "no plan creates a GitHub repo today",
    grant: "GitHub: create the repo with `POST /user/repos`, then install the OE App on it and grant it in a bundle.",
  }),
  linear: provisionLinear,
  notion: provisionNotion,
};

export function writeEnvE2e(path: string, values: ReadonlyMap<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const done = new Set<string>();
  const out = existing.map((line) => {
    const m = /^(export\s+)?([A-Z0-9_]+)=/u.exec(line);
    if (!m) return line;
    const value = values.get(m[2]);
    if (value === undefined) return line;
    done.add(m[2]);
    return `${m[1] ?? ""}${m[2]}=${value}`;
  });
  const added = [...values.entries()].filter(([name]) => !done.has(name));
  if (added.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push("# --- e2e:fixtures provision (OPE-1504) ---");
    for (const [name, value] of added) out.push(`${name}=${value}`);
  }
  writeFileSync(path, `${out.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

async function runProvision(env: Env, domain: string, dryRun: boolean): Promise<number> {
  const plan = planFor(domain);
  if (!plan) {
    console.error(`✗ e2e:fixtures provision: no plan for "${domain}". Known: ${knownDomains()}`);
    return 2;
  }
  const refusals = plan.rooms.map((room) => createGuardRefusal(plan.domain, room)).filter((r): r is string => r !== null);
  if (refusals.length > 0) {
    console.error(`✗ e2e:fixtures provision ${plan.domain}: the create guard refuses this plan — nothing was created.`);
    for (const r of refusals) console.error(`    ${r}`);
    return 2;
  }
  console.log(`e2e:fixtures provision ${plan.domain} (${plan.ticket}) — ${plan.what}`);
  console.log(dryRun ? "  DRY RUN — nothing is created.\n" : "");

  const outcomes: ProvisionOutcome[] = [];
  for (const room of plan.rooms) {
    if (room.action === "reuse") {
      const value = env[room.reuseOf ?? room.envVar]?.trim();
      outcomes.push({
        room,
        state: "reused",
        ...(value ? { id: value } : {}),
        detail: value ? `reuses ${room.reuseOf} — ${room.note}` : `reuses ${room.reuseOf}, which is not set — ${room.note}`,
      });
      continue;
    }
    if (env[room.envVar]?.trim()) {
      outcomes.push({ room, state: "found", id: env[room.envVar]!.trim(), detail: `${room.envVar} is already set` });
      continue;
    }
    if (dryRun) {
      outcomes.push({ room, state: "skipped", detail: `would create "${roomName(plan.slug, room.surface)}" and set ${room.envVar}` });
      continue;
    }
    const outcome = await withTimeout(PROVISIONERS[room.surface](env, plan, room), `${room.surface} provision`).catch((err: unknown) => ({
      room,
      state: "blocked" as const,
      detail: reason(err),
    }));
    outcomes.push(outcome);
  }

  const toWrite = new Map<string, string>();
  for (const o of outcomes) {
    const mark = { created: "+", found: "=", reused: "=", blocked: "✗", skipped: "~" }[o.state];
    const shown = o.room.surface === "teams" ? (o.name ?? "(teams room)") : (o.id ?? "—");
    console.log(`  ${mark} ${o.room.surface.padEnd(8)} ${o.room.envVar.padEnd(32)} ${shown} — ${o.detail}`);
    if (o.grant) console.log(`      ONE-TIME GRANT → ${o.grant}`);
    if ((o.state === "created" || o.state === "found") && o.id && o.room.action === "create") toWrite.set(o.room.envVar, o.id);
  }

  if (toWrite.size > 0 && !dryRun) {
    writeEnvE2e(ENV_E2E, toWrite);
    console.log(`\n  wrote ${toWrite.size} var(s) to .env.e2e (gitignored).`);
    console.log("  For the deployment, run each of these and paste the value when prompted:");
    for (const name of toWrite.keys()) console.log(`    vercel env add ${name} production`);
  }

  const blocked = outcomes.filter((o) => o.state === "blocked");
  if (blocked.length > 0) {
    console.log(`\n✗ e2e:fixtures provision: ${blocked.length} surface(s) need a one-time grant: ${blocked.map((b) => b.room.surface).join(", ")}`);
    return 1;
  }
  const pending = outcomes.filter((o) => o.state === "skipped");
  if (pending.length > 0) {
    console.log(`\n~ e2e:fixtures provision: ${pending.length} room(s) still to make — re-run without --dry-run.`);
    return 0;
  }
  console.log("\n✓ e2e:fixtures provision: every room in the plan exists.");
  return 0;
}

function knownDomains(): string {
  return PROVISION_PLAN.map((p) => p.domain).join(", ");
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    console.error(`✗ e2e:fixtures: could not complete — ${reason(err)}`);
    return 2;
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "inventory") {
    return runInventory(resolvedEnv(), {
      check: rest.includes("--check"),
      warnOnly: rest.includes("--warn-only"),
      partial: rest.includes("--partial"),
      ifArmed: rest.includes("--if-armed"),
    });
  }
  if (command === "provision") {
    const domain = rest.find((a) => !a.startsWith("-"));
    if (!domain) {
      console.error(`✗ e2e:fixtures provision: name a domain. Known: ${knownDomains()}`);
      return 2;
    }
    return runProvision(resolvedEnv(), domain, rest.includes("--dry-run"));
  }
  console.error(`✗ e2e:fixtures: unknown command "${String(command)}" — use \`inventory\` or \`provision <domain>\`.`);
  return 2;
}
