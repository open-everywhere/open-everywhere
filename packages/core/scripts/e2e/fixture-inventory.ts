import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  PROVISION_PLAN,
  SURFACE_ORDER,
  buildInventory,
  canonicalId,
  collectDeclaredRooms,
  compareInventory,
  createGuardRefusal,
  inventoryOptions,
  inventoryVars,
  namesLost,
  notionQueryPageBody,
  notionQueryPageTitle,
  parseInventoryDoc,
  planFor,
  renderInventoryDoc,
  resolutionKey,
  roomIdFor,
  roomName,
  roomsUnseen,
  staleCheckExitCode,
  slackRoomName,
  teamsSegment,
  trackedRoomId,
  type BindingLike,
  type DomainLike,
  type InventoryOptions,
  type PlannedRoom,
  type ProvisionDomain,
  type Resolution,
  type SlackChannelInfo,
  type SurfaceKind,
} from "./fixture-inventory-lib.js";
import { DEFAULT_TEAMS_REFRESH_SINK, ENV, S24_DEFAULT_QUERY } from "./env.js";
import { TeamsDriver } from "./teams-driver.js";
import { notionFetch, parseNotionRetryAfterMs } from "./notion-driver.js";
import { resolveAppRoot } from "../../agent/scaffold/app-root.js";
import { loadAppBindings, loadAppDomains } from "./app-config.js";

type Env = Record<string, string | undefined>;

export const INVENTORY_DOC = join("docs", "dev", "e2e-fixtures.md");
function envE2ePath(): string {
  return join(resolveAppRoot(), ".env.e2e");
}

export const PROBE_TIMEOUT_MS = 15_000;

const NOTION_SEED_TIMEOUT_MS = 120_000;

const NOTION_PROBE_RETRY_CAP_MS = 30_000;

interface ProbeDeadline {
  extend(ms: number): boolean;
}

const PROBE_DEADLINE = new AsyncLocalStorage<ProbeDeadline>();

function extendProbeDeadline(ms: number): boolean {
  return PROBE_DEADLINE.getStore()?.extend(ms) ?? false;
}

export async function withTimeout<T>(run: () => Promise<T>, what: string, ms: number = PROBE_TIMEOUT_MS): Promise<T> {
  let deadline = Date.now() + ms;
  let extendedMs = 0;
  let running = true;
  const handle: ProbeDeadline = {
    extend(extra: number): boolean {
      if (!running) return false;
      deadline += extra;
      extendedMs += extra;
      return true;
    },
  };
  return new Promise<T>((res, rej) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function arm(inMs: number): void {
      timer = setTimeout(fire, inMs);
    }
    function fire(): void {
      const left = deadline - Date.now();
      if (left > 0) {
        arm(left);
        return;
      }
      settle();
      const honoured = extendedMs > 0 ? ` (plus ${extendedMs}ms of honoured Retry-After, which the budget does not pay for)` : "";
      rej(new Error(`${what} timed out after ${ms}ms${honoured}`));
    }
    function settle(): void {
      running = false;
      clearTimeout(timer);
    }
    arm(ms);
    PROBE_DEADLINE.run(handle, run).then(
      (v) => {
        settle();
        res(v);
      },
      (e: unknown) => {
        settle();
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
  return { ...loadEnvFile(envE2ePath()), ...process.env };
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

async function githubApi(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

interface GraphqlAnswer {
  readonly data?: Record<string, unknown>;
  readonly errors?: { message?: string; extensions?: { userPresentableMessage?: string } }[];
}

function linearErrorText(answer: GraphqlAnswer): string | undefined {
  const parts = (answer.errors ?? []).map((e) => e.extensions?.userPresentableMessage?.trim() || e.message?.trim()).filter((m): m is string => !!m);
  return parts.length > 0 ? vendorDetail(parts.join("; ")) : undefined;
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

export async function notionApi(
  key: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  deps: { readonly sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sleepFn = deps.sleepFn ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const send = async (): Promise<Response> =>
    fetch(`https://api.notion.com/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${key}`,
        "notion-version": "2022-06-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  let res = await send();
  if (res.status === 429) {
    const named = parseNotionRetryAfterMs(res.headers.get("retry-after"), Date.now());
    if (named !== undefined) {
      const wait = Math.max(0, Math.min(named, NOTION_PROBE_RETRY_CAP_MS));
      const moved = extendProbeDeadline(wait);
      console.log(
        `  notion ${init.method ?? "GET"} 429 — honouring Retry-After: one retry in ${wait}ms ` +
          (moved
            ? `(the ${PROBE_TIMEOUT_MS}ms probe budget is unchanged; this probe's deadline moves by the same ${wait}ms)`
            : `(no probe deadline is running, so none was moved)`),
      );
      await sleepFn(wait);
      res = await send();
    }
  }
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
    linear: has(ENV.linearApiKey) || has(ENV.addressedLinearApiKey),
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
    const channel = info.channel as SlackChannelInfo | undefined;
    return {
      ok: true,
      name: slackRoomName(channel),
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
  const found = channels.find((c) => c.id === id || teamsSegment(c.id) === id);
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
  const keys = [ctx.env[ENV.linearApiKey], ctx.env[ENV.addressedLinearApiKey], ctx.env[ENV.linearSoakDriverKey]].filter((k): k is string => Boolean(k?.trim()));
  let last = "no Linear key";
  for (const key of keys) {
    const answer = await linearGraphql(key, `query($id:String!){ team(id:$id){ id name key organization { id } } }`, { id });
    const team = (answer.data?.team ?? undefined) as { name?: string; key?: string; organization?: { id?: string } } | undefined;
    if (team?.name) {
      const org = team.organization?.id;
      return { ok: true, name: `${team.name} (${team.key ?? "?"})`, key: org ? `linear/${org}/${id}` : undefined, detail: "team(id)" };
    }
    last = linearErrorText(answer) ?? "team(id) returned nothing";
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

export async function loadConfigRooms(root: string = resolveAppRoot()): Promise<{ domains: readonly DomainLike[]; bindings: readonly BindingLike[] }> {
  const domains = await loadAppDomains(root);
  const bindings = await loadAppBindings(root);
  return { domains: domains as readonly DomainLike[], bindings: bindings as readonly BindingLike[] };
}

export const ARMING_VAR = "E2E_FIXTURE_TABLE_CHECK";

async function runInventory(env: Env, options: InventoryOptions): Promise<number> {
  if (options.ifArmed && env[ARMING_VAR]?.trim() !== "1") {
    console.log(`~ e2e:fixtures inventory --check: not armed. Set ${ARMING_VAR}=1 with the e2e credentials to compare ${INVENTORY_DOC} against the live rooms.`);
    return 0;
  }
  const { reachable, blind } = reachableSurfaces(env);
  const { domains, bindings } = await loadConfigRooms();
  const declared = collectDeclaredRooms(domains, bindings);

  const ctx: ResolverContext = { env };
  if (reachable.has("slack")) {
    const auth = await withTimeout(() => slackApi(env[ENV.slackUserToken]!, "auth.test"), "slack auth.test").catch(() => ({}) as Record<string, unknown>);
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
    const raw = roomIdFor(spec.envVar, env);
    if (!raw) continue;
    const id = spec.surface === "teams" && raw.startsWith("teams/") ? raw.split("/").pop()! : raw;
    wanted.set(resolutionKey(spec.surface, id), { surface: spec.surface, id });
  }

  const resolutions = new Map<string, Resolution>();
  for (const [key, { surface, id }] of wanted) {
    if (!reachable.has(surface)) continue;
    const answer = await withTimeout(() => RESOLVERS[surface](ctx, id), `${surface} lookup`).catch((err: unknown) => ({
      ok: false as const,
      detail: reason(err),
    }));
    resolutions.set(key, answer);
  }

  const inventory = buildInventory({ envValues: env, declared, resolutions, unresolvableSurfaces: blind });
  const generated = renderInventoryDoc(inventory, { unresolvableSurfaces: blind });
  const docPath = join(resolveAppRoot(), INVENTORY_DOC);

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
    return staleCheckExitCode(options);
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
  return staleCheckExitCode(options);
}

export type ProvisionTarget = Pick<ProvisionDomain, "slug" | "linearKey">;

export interface ProvisionOutcome {
  readonly room: PlannedRoom;
  readonly state: "reused" | "found" | "created" | "blocked" | "skipped";
  readonly id?: string;
  readonly name?: string;
  readonly detail: string;
  readonly grant?: string;
  readonly trackedId?: boolean;
}

export function alreadyProvisioned(room: PlannedRoom, env: Env): ProvisionOutcome | undefined {
  const known = roomIdFor(room.envVar, env);
  if (!known) return undefined;
  if (env[room.envVar]?.trim()) return { room, state: "found", id: known, detail: `${room.envVar} is already set` };
  return {
    room,
    state: "found",
    id: known,
    detail: `this repository carries the id (TRACKED_ROOM_IDS.${room.envVar}) — leave ${room.envVar} unset`,
    trackedId: true,
  };
}

export function offersEnvWrite(o: ProvisionOutcome): boolean {
  return (o.state === "created" || o.state === "found") && Boolean(o.id) && o.room.action === "create" && o.trackedId !== true;
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
  const keyVar = room.credentialVar ?? ENV.linearApiKey;
  const apiKey = env[keyVar]?.trim();
  if (!apiKey) {
    return {
      room,
      state: "skipped",
      detail:
        keyVar === ENV.linearApiKey
          ? `no ${keyVar}`
          : `no ${keyVar} — this room's team is in its own Linear workspace, so ${ENV.linearApiKey} cannot see it. Mint a personal API key in THAT workspace and export it as ${keyVar}`,
    };
  }
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
    const detail = linearErrorText(created) ?? "teamCreate returned no team";
    return {
      room,
      state: "blocked",
      detail: `teamCreate: ${detail}`,
      grant:
        `Linear: READ THE DETAIL ABOVE FIRST — it carries Linear's own reason. Where that reason is a PLAN team limit, the limit is on the workspace, so step (1) very likely refuses in the console too (nobody has driven it): try it, and if it refuses, only an upgrade or a freed team slot gets past. ` +
        `Then, two steps, both required: (1) create the team by hand — Settings → Teams → New team, name "${want}", key "${key}"; ` +
        `(2) mint a personal API key IN THE WORKSPACE THAT TEAM LIVES IN, scoped to include it, and export it as ${keyVar}. A key cannot read a team outside its own scope — and never one outside its own WORKSPACE, whatever its team scope — so step (1) alone leaves the room unresolvable.`,
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

const GITHUB_APP_GRANT =
  "GitHub: confirm the OE GitHub App is installed on this repo (or that its installation covers All repositories) — no PAT can install an App or read the installation back, so this tool cannot check it. Without the installation no webhook reaches the deployment.";

async function provisionGithub(env: Env, plan: ProvisionTarget, room: PlannedRoom): Promise<ProvisionOutcome> {
  const token = env[ENV.githubDriverToken];
  if (!token) return { room, state: "skipped", detail: `no ${ENV.githubDriverToken}` };
  const want = roomName(plan.slug, "github");
  const me = await githubApi(token, "/user");
  const owner = typeof me.json.login === "string" ? me.json.login : "";
  if (!owner) {
    return {
      room,
      state: "blocked",
      detail: `GET /user → ${me.status} — the driver token names no account, so there is no owner to create under`,
      grant: `GitHub: check ${ENV.githubDriverToken} is a live token for the e2e account.`,
    };
  }
  const existing = await githubApi(token, `/repos/${owner}/${want}`);
  if (existing.status === 200) {
    const full = String(existing.json.full_name ?? `${owner}/${want}`);
    if (existing.json.private !== true) {
      return {
        room,
        state: "blocked",
        detail: `${full} exists but is PUBLIC — J-ENGAGED-github's non-mention arm refuses a public repo`,
        grant: `GitHub: make ${full} private (Settings → General → Danger Zone), then re-run this command.`,
      };
    }
    const readOnly = existing.json.archived === true ? "ARCHIVED" : existing.json.disabled === true ? "DISABLED" : "";
    if (readOnly) {
      return {
        room,
        state: "blocked",
        detail: `${full} exists but is ${readOnly} — read-only, so the journey cannot open its issue`,
        grant: `GitHub: un-${readOnly.toLowerCase()} ${full} (Settings → General → Danger Zone), then re-run this command.`,
      };
    }
    return { room, state: "found", id: full, name: full, detail: "already exists (private)", grant: GITHUB_APP_GRANT };
  }
  if (existing.status !== 404) {
    return { room, state: "blocked", detail: `GET /repos/{owner}/{repo} → ${existing.status} — cannot tell whether the repo exists, so nothing is created` };
  }
  const created = await githubApi(token, "/user/repos", {
    method: "POST",
    body: { name: want, private: true, auto_init: true, has_issues: true, description: "OE e2e addressed-only fixture (OPE-1503)" },
  });
  if (created.status < 200 || created.status >= 300) {
    return {
      room,
      state: "blocked",
      detail: `POST /user/repos → ${created.status} ${String(created.json.message ?? "")}`.trim(),
      grant:
        `GitHub: either give ${ENV.githubDriverToken} the account-level "Administration" write permission ` +
        `(fine-grained PAT → Account permissions → Administration: Read and write), or create the repo by hand — ` +
        `a PRIVATE repo named \`${want}\` under \`${owner}\` — then re-run this command, which finds it by name.`,
    };
  }
  const full = String(created.json.full_name ?? `${owner}/${want}`);
  return { room, state: "created", id: full, name: full, detail: "created private", grant: GITHUB_APP_GRANT };
}

export const PROVISIONERS: Record<SurfaceKind, (env: Env, plan: ProvisionTarget, room: PlannedRoom) => Promise<ProvisionOutcome>> = {
  slack: provisionSlack,
  discord: provisionDiscord,
  teams: provisionTeams,
  github: provisionGithub,
  linear: provisionLinear,
  notion: provisionNotion,
};

const MPIM_THIRD_MEMBER_VARS: readonly string[] = [ENV.slackUser2Id, ENV.slackSecondaryUserId];

export interface MpimOutcome {
  readonly state: "opened" | "blocked";
  readonly id?: string;
  readonly detail: string;
  readonly grant?: string;
}

export async function provisionSlackMpim(env: Env): Promise<MpimOutcome> {
  const token = env[ENV.slackUserToken]?.trim();
  if (!token) {
    return { state: "blocked", detail: `no ${ENV.slackUserToken}`, grant: `Slack: export ${ENV.slackUserToken} (the driver user's xoxp) and re-run.` };
  }
  const bot = env[ENV.slackBotUserId]?.trim();
  if (!bot) {
    return {
      state: "blocked",
      detail: `no ${ENV.slackBotUserId} — a group DM the OE bot is not in can never wake it`,
      grant: `Slack: export ${ENV.slackBotUserId} (OE's own bot USER id, U…/W…) and re-run.`,
    };
  }
  const thirdVar = MPIM_THIRD_MEMBER_VARS.find((v) => env[v]?.trim());
  if (!thirdVar) {
    return {
      state: "blocked",
      detail: `no third member — a group DM needs one beyond the driver user and the bot (tried ${MPIM_THIRD_MEMBER_VARS.join(", ")})`,
      grant: `Slack: export ${MPIM_THIRD_MEMBER_VARS[0]} with a REAL workspace member's user id and re-run — an invented U… opens nothing.`,
    };
  }
  const opened = await slackPost(token, "conversations.open", { users: `${bot},${env[thirdVar]!.trim()}` });
  if (opened.ok !== true) {
    const error = String(opened.error ?? "unknown");
    const needed = typeof opened.needed === "string" ? opened.needed : undefined;
    const detail = vendorDetail(needed ? `conversations.open: ${error} (needs ${needed})` : `conversations.open: ${error}`);
    return {
      state: "blocked",
      detail,
      grant:
        `Slack: READ THE DETAIL ABOVE FIRST — it carries Slack's own reason. For a missing scope, add ${needed ? `\`${vendorDetail(needed, 60)}\`` : "`mpim:write`"} ` +
        `to the DRIVER app's USER scopes and reinstall it (a new xoxp is minted, so re-export ${ENV.slackUserToken}). ` +
        `The DEPLOYMENT side needs \`mpim:history\` and \`mpim:read\` on the OE app, which this command cannot check.`,
    };
  }
  const channel = opened.channel as { id?: string; is_mpim?: unknown; is_im?: unknown } | undefined;
  if (!channel?.id) return { state: "blocked", detail: "conversations.open returned no channel id" };
  if (channel.is_mpim !== true) {
    const oneToOne = channel.is_im === true;
    return {
      state: "blocked",
      detail: oneToOne
        ? `conversations.open returned a 1:1 channel (is_im), not a group DM — ${thirdVar} and ${ENV.slackBotUserId} may name the same user`
        : "conversations.open returned a channel Slack does not call a group DM (no `is_mpim: true`)",
      grant: oneToOne
        ? `Slack: point ${thirdVar} at a third, distinct workspace member and re-run.`
        : `Slack: re-run and read the raw answer — a room the vendor does not call an mpim is never published as ${ENV.slackMpimChannel}.`,
    };
  }
  return {
    state: "opened",
    id: channel.id,
    detail: `open over the ${ENV.slackUserToken} user, ${ENV.slackBotUserId} and ${thirdVar}`,
  };
}

async function runProvisionMpim(env: Env, dryRun: boolean): Promise<number> {
  console.log(`e2e:fixtures provision-mpim (OPE-1640) — ${ENV.slackMpimChannel}: J-MPIM's group DM, the pack's only mpim room`);
  if (dryRun) {
    console.log(`  DRY RUN — nothing is opened. Would call conversations.open over the ${ENV.slackUserToken} user, ${ENV.slackBotUserId} and ${MPIM_THIRD_MEMBER_VARS.join(" or ")}.`);
    return 0;
  }
  const outcome: MpimOutcome = await withTimeout(() => provisionSlackMpim(env), "slack conversations.open").catch((err: unknown) => ({
    state: "blocked" as const,
    detail: reason(err),
  }));
  if (outcome.state === "blocked") {
    console.error(`  ✗ ${ENV.slackMpimChannel} — ${outcome.detail}`);
    if (outcome.grant) console.error(`      ONE-TIME GRANT → ${outcome.grant}`);
    return 1;
  }
  console.log(`  + ${ENV.slackMpimChannel} ${outcome.id} — ${outcome.detail}`);
  const tracked = trackedRoomId(ENV.slackMpimChannel);
  if (tracked === outcome.id) {
    console.log("\n✓ e2e:fixtures provision-mpim: the room exists and this repository already carries its id.");
    return 0;
  }
  console.log(`\n~ e2e:fixtures provision-mpim: the id is NOT in this repository${tracked ? " (the table names a different room)" : ""}.`);
  console.log("  A room id is a tracked literal, so it changes by pull request. Put this line in");
  console.log("  `packages/core/scripts/e2e/fixture-inventory-lib.ts`'s TRACKED_ROOM_IDS, then run");
  console.log(`  \`npm run e2e:fixtures -- inventory\` and \`npm run docs:generate\`:\n`);
  console.log(`    ${ENV.slackMpimChannel}: "${outcome.id}",`);
  return 0;
}

async function notionApiRetrying(
  key: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await notionFetch(
    `https://api.notion.com/v1${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${key}`,
        "notion-version": "2022-06-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    { what: `${init.method ?? "GET"} /v1${path}` },
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export interface NotionQueryPageOutcome {
  readonly state: "created" | "found" | "blocked";
  readonly id?: string;
  readonly title?: string;
  readonly detail: string;
  readonly grant?: string;
}

export async function provisionNotionQueryPage(env: Env, query: string): Promise<NotionQueryPageOutcome> {
  const key = env[ENV.notionDriverKey]?.trim();
  const anchor = env[ENV.notionAmbientPageId]?.trim();
  if (!key || !anchor) {
    return {
      state: "blocked",
      detail: `no ${ENV.notionDriverKey} / ${ENV.notionAmbientPageId}`,
      grant: `Notion: export ${ENV.notionDriverKey} (the driver integration's secret) and ${ENV.notionAmbientPageId} (J-NOT's ambient page) and re-run.`,
    };
  }
  const title = notionQueryPageTitle(query);
  const anchorPage = await notionApiRetrying(key, `/pages/${encodeURIComponent(anchor)}`);
  if (anchorPage.status !== 200) return { state: "blocked", detail: `pages.retrieve(${ENV.notionAmbientPageId}) → ${anchorPage.status}` };
  const parent = anchorPage.json.parent as { type?: string; page_id?: string } | undefined;
  const parentPageId = parent?.type === "page_id" ? parent.page_id : anchor;
  if (!parentPageId) return { state: "blocked", detail: "the e2e page has no page parent to create under" };
  let start: string | undefined;
  do {
    const children = await notionApiRetrying(key, `/blocks/${encodeURIComponent(parentPageId)}/children?page_size=100${start ? `&start_cursor=${start}` : ""}`);
    if (children.status !== 200) return { state: "blocked", detail: `blocks.children → ${children.status}` };
    const results = (children.json.results ?? []) as { id?: string; type?: string; child_page?: { title?: string } }[];
    const found = results.find((b) => b.type === "child_page" && b.child_page?.title === title);
    if (found?.id) return { state: "found", id: canonicalId("notion", found.id), title, detail: "already exists" };
    start = children.json.has_more === true && typeof children.json.next_cursor === "string" ? children.json.next_cursor : undefined;
  } while (start);
  const created = await notionApiRetrying(key, "/pages", {
    method: "POST",
    body: {
      parent: { page_id: parentPageId },
      properties: { title: [{ type: "text", text: { content: title } }] },
      children: notionQueryPageBody(query).map((line) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
      })),
    },
  });
  if (created.status < 200 || created.status >= 300) {
    return {
      state: "blocked",
      detail: `pages.create → ${created.status} ${String(created.json.code ?? "")}`.trim(),
      grant: "Notion: connect the driver integration to the e2e page's PARENT page (⋯ → Connections), so a child page can be created under it.",
    };
  }
  const id = created.json.id;
  return { state: "created", id: typeof id === "string" ? canonicalId("notion", id) : undefined, title, detail: "created with its quotable body" };
}

async function runProvisionNotionQueryPage(env: Env, dryRun: boolean): Promise<number> {
  const query = env[ENV.notionQuery]?.trim() || S24_DEFAULT_QUERY;
  const title = notionQueryPageTitle(query);
  console.log(`e2e:fixtures provision-notion-query-page (OPE-1722) — the page S24's own search for "${query}" must find`);
  if (dryRun) {
    console.log(`  DRY RUN — nothing is written. Would find-or-create the child page "${title}" under ${ENV.notionAmbientPageId}'s own parent,`);
    console.log(`  with ${notionQueryPageBody(query).length} quotable paragraph(s).`);
    return 0;
  }
  const outcome: NotionQueryPageOutcome = await withTimeout(() => provisionNotionQueryPage(env, query), "provision-notion-query-page (pages.retrieve + blocks.children + pages.create)", NOTION_SEED_TIMEOUT_MS).catch((err: unknown) => ({
    state: "blocked" as const,
    detail: reason(err),
  }));
  if (outcome.state === "blocked") {
    console.error(`  ✗ "${title}" — ${outcome.detail}`);
    if (outcome.grant) console.error(`      ONE-TIME GRANT → ${outcome.grant}`);
    return 1;
  }
  console.log(`  ${outcome.state === "created" ? "+" : "="} "${outcome.title}" ${outcome.id ?? "(no id returned)"} — ${outcome.detail}`);
  console.log(`\n~ e2e:fixtures provision-notion-query-page: the page exists. Nothing was written to any env var — S24 finds it by SEARCH.`);
  console.log(`  Notion's search index lags a write by up to a few minutes. Confirm before you trust the leg:`);
  console.log(`    npm run e2e:fixtures -- inventory --partial     # the page is reachable at all`);
  console.log(`  then run S24 itself: E2E_ONLY=S24 npm run e2e:driver`);
  return 0;
}

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
    const known = alreadyProvisioned(room, env);
    if (known) {
      outcomes.push(known);
      continue;
    }
    if (dryRun) {
      outcomes.push({ room, state: "skipped", detail: `would create "${roomName(plan.slug, room.surface)}" and set ${room.envVar}` });
      continue;
    }
    const outcome = await withTimeout(() => PROVISIONERS[room.surface](env, plan, room), `${room.surface} provision`).catch((err: unknown) => ({
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
    if (offersEnvWrite(o)) toWrite.set(o.room.envVar, o.id!);
  }

  if (toWrite.size > 0 && !dryRun) {
    writeEnvE2e(envE2ePath(), toWrite);
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
    return runInventory(resolvedEnv(), inventoryOptions(rest));
  }
  if (command === "provision") {
    const domain = rest.find((a) => !a.startsWith("-"));
    if (!domain) {
      console.error(`✗ e2e:fixtures provision: name a domain. Known: ${knownDomains()}`);
      return 2;
    }
    return runProvision(resolvedEnv(), domain, rest.includes("--dry-run"));
  }
  if (command === "provision-mpim") {
    return runProvisionMpim(resolvedEnv(), rest.includes("--dry-run"));
  }
  if (command === "provision-notion-query-page") {
    return runProvisionNotionQueryPage(resolvedEnv(), rest.includes("--dry-run"));
  }
  console.error(
    `✗ e2e:fixtures: unknown command "${String(command)}" — use \`inventory\`, \`provision <domain>\`, \`provision-mpim\` or \`provision-notion-query-page\`.`,
  );
  return 2;
}
