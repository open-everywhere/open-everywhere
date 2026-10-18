import {
  agentDisplayName,
  appendAudit,
  domainForChannel,
  domainsNamingSilo,
  getConfig,
  getOperationalStore,
  MEMORY_CANVAS_MARKER,
  memoryCanvasAmong,
  memoryCanvasSurfaceKey,
  readDomainMemory,
  storedMemoryCanvas,
  memoryLineForReader,
  renderMemoryMarkdown,
  type Domain,
  type MemoryCanvasMatch,
  type MemoryWriteEvent,
  type OperationalStore,
  type SlackCanvasRead,
} from "@open-everywhere/core/agent/adapter-api.js";
import { confirmChannelInternalFresh, slackAuthorIsMember, slackForm } from "./slack-events.js";
import { encodeSlackForm } from "./slack-web-api.js";

const MEMORY_CANVAS_ACTION = "memory.canvas_refresh";

const MEMORY_CANVAS_CHANNELS_MAX = 20;
const BOT_CHANNEL_PAGES_MAX = 5;
const CANVAS_MARKDOWN_MAX = 90_000;

export type CanvasOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped-external"
  | "skipped-guest"
  | "skipped-foreign"
  | "skipped-disabled"
  | "cleared-external"
  | "cleared-guest"
  | "cleared-disabled"
  | "clear-failed"
  | "failed";

const MEMBER_CHECK_MAX = 200;

export interface MemoryCanvasDeps {
  readonly call: (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  readonly channelInternal: (channelId: string) => Promise<boolean>;
  readonly authorIsMember: (userId: string, teamId: string | undefined) => Promise<boolean | undefined>;
  readonly now?: () => Date;
  readonly store?: Pick<OperationalStore, "getMemoryCanvas" | "setMemoryCanvas">;
}

export function liveMemoryCanvasDeps(): MemoryCanvasDeps {
  return {
    call: (method, body) => slackForm(method, encodeSlackForm(body)),
    channelInternal: confirmChannelInternalFresh,
    authorIsMember: slackAuthorIsMember,
  };
}

export function defuseCanvasText(markdown: string): string {
  return markdown.replace(/!\[/g, "!\\[").replace(/<([@!#])/g, "‹$1");
}

function memoryCanvasMarkdown(domain: Domain, groups: Parameters<typeof renderMemoryMarkdown>[1], nowIso: string): string {
  const name = agentDisplayName();
  const body = renderMemoryMarkdown(`What ${name} knows — ${domain.title ?? domain.name}`, groups, nowIso);
  const footer =
    `\n---\n${name} keeps this canvas up to date. To correct or forget a line, ask ${name} in this channel. ` +
    `${MEMORY_CANVAS_MARKER}\n`;
  const text = defuseCanvasText(memoryLineForReader(body));
  const cut = text.length > CANVAS_MARKDOWN_MAX ? text.slice(0, CANVAS_MARKDOWN_MAX) + "\n\n_This canvas is full. Ask in this channel for the rest._\n" : text;
  return cut + footer;
}

async function domainChannels(teamId: string, domains: readonly Domain[], deps: MemoryCanvasDeps): Promise<Map<string, { channelId: string; surfaceKey: string }[]>> {
  const out = new Map<string, { channelId: string; surfaceKey: string }[]>();
  const all = getConfig().loadDomains();
  const wanted = new Set(domains.map((d) => d.name));
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < BOT_CHANNEL_PAGES_MAX && total < MEMORY_CANVAS_CHANNELS_MAX; page++) {
    const res = await deps.call("users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (res?.ok !== true || !Array.isArray(res.channels)) break;
    for (const c of res.channels) {
      const channelId = typeof (c as { id?: unknown })?.id === "string" ? (c as { id: string }).id : undefined;
      if (!channelId) continue;
      const surfaceKey = `slack/${teamId}/${channelId}`;
      const owner = domainForChannel(surfaceKey, all);
      if (!owner || !wanted.has(owner.name)) continue;
      if (total >= MEMORY_CANVAS_CHANNELS_MAX) break;
      out.set(owner.name, [...(out.get(owner.name) ?? []), { channelId, surfaceKey }]);
      total++;
    }
    cursor = typeof (res.response_metadata as { next_cursor?: unknown })?.next_cursor === "string" ? (res.response_metadata as { next_cursor: string }).next_cursor : undefined;
    if (!cursor) break;
  }
  return out;
}

async function everyMemberIsFull(channelId: string, teamId: string | undefined, botUserId: string | undefined, deps: MemoryCanvasDeps): Promise<boolean> {
  const res = await deps.call("conversations.members", { channel: channelId, limit: MEMBER_CHECK_MAX });
  if (res?.ok !== true || !Array.isArray(res.members)) return false;
  const next = (res.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
  if (typeof next === "string" && next.length > 0) return false;
  for (const m of res.members) {
    if (typeof m !== "string" || m.length === 0) return false;
    if (m === botUserId) continue;
    if ((await deps.authorIsMember(m, teamId)) !== true) return false;
  }
  return true;
}

function withdrawnCanvasMarkdown(): string {
  const name = agentDisplayName();
  return (
    `# ${name}'s memory canvas was withdrawn\n\n` +
    `This channel includes guests or people from outside your organisation, so ${name} no longer shows its memory here. ` +
    `The memory itself is unchanged. Members can still ask ${name} about it in an internal channel. ` +
    `${MEMORY_CANVAS_MARKER}\n`
  );
}

type WithdrawReason = "external" | "guest" | "disabled";

export interface CanvasRoom {
  readonly org: string;
  readonly teamId: string;
  readonly channelId: string;
}

function readOk(deps: MemoryCanvasDeps): SlackCanvasRead {
  return async (method, params) => {
    const res = await deps.call(method, params);
    return res?.ok === true ? res : undefined;
  };
}

async function findMemoryCanvas(room: CanvasRoom, info: Record<string, unknown>, botUserId: string | undefined, deps: MemoryCanvasDeps): Promise<MemoryCanvasMatch> {
  const stored = await storedMemoryCanvas(deps.store ?? getOperationalStore(), room.org, memoryCanvasSurfaceKey(room.teamId, room.channelId));
  return memoryCanvasAmong(readOk(deps), info, stored, botUserId);
}

async function recordMemoryCanvas(room: CanvasRoom, canvasId: string, deps: MemoryCanvasDeps): Promise<void> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  await (deps.store ?? getOperationalStore()).setMemoryCanvas(room.org, memoryCanvasSurfaceKey(room.teamId, room.channelId), canvasId, at).catch(() => undefined);
}

async function withdrawIfOurs(room: CanvasRoom, reason: WithdrawReason, botUserId: string | undefined, deps: MemoryCanvasDeps): Promise<CanvasOutcome> {
  const info = await deps.call("conversations.info", { channel: room.channelId });
  if (info?.ok !== true) return "clear-failed";
  const match = await findMemoryCanvas(room, info, botUserId, deps);
  if (match.kind === "unsure") return "clear-failed";
  if (match.kind === "none") return `skipped-${reason}`;
  const cleared = await deps.call("canvases.edit", {
    canvas_id: match.canvasId,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown: withdrawnCanvasMarkdown() } }],
  });
  if (cleared?.ok !== true) return "clear-failed";
  if (match.adopt) await recordMemoryCanvas(room, match.canvasId, deps);
  return `cleared-${reason}`;
}

const CANVAS_SLOT_TAKEN = new Set(["channel_canvas_already_exists", "free_team_canvas_tab_already_exists"]);

export async function publishChannelCanvas(
  room: CanvasRoom,
  markdown: string | null,
  botUserId: string | undefined,
  deps: MemoryCanvasDeps,
  joinedUserId?: string,
): Promise<CanvasOutcome> {
  const { channelId, teamId } = room;
  const blocked: "external" | "guest" | undefined = !(await deps.channelInternal(channelId))
    ? "external"
    : (joinedUserId !== undefined && joinedUserId !== botUserId && (await deps.authorIsMember(joinedUserId, teamId)) !== true) ||
        !(await everyMemberIsFull(channelId, teamId, botUserId, deps))
      ? "guest"
      : undefined;
  if (blocked) return withdrawIfOurs(room, blocked, botUserId, deps);
  if (markdown === null) return "unchanged";
  const info = await deps.call("conversations.info", { channel: channelId });
  if (info?.ok !== true) return "failed";
  const match = await findMemoryCanvas(room, info, botUserId, deps);
  if (match.kind === "unsure") return "failed";
  if (match.kind === "none") {
    const created = await deps.call("conversations.canvases.create", { channel_id: channelId, document_content: { type: "markdown", markdown } });
    if (created?.ok !== true) return typeof created?.error === "string" && CANVAS_SLOT_TAKEN.has(created.error) ? "skipped-foreign" : "failed";
    if (typeof created.canvas_id === "string" && created.canvas_id.length > 0) await recordMemoryCanvas(room, created.canvas_id, deps);
    return "created";
  }
  const edited = await deps.call("canvases.edit", { canvas_id: match.canvasId, changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }] });
  if (edited?.ok !== true) return "failed";
  if (match.adopt) await recordMemoryCanvas(room, match.canvasId, deps);
  return "updated";
}

export type CanvasTrigger = "memory-write" | "member-joined" | "channel-shared";

export async function recheckChannelCanvas(
  input: {
    readonly org: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly trigger: Exclude<CanvasTrigger, "memory-write">;
    readonly joinedUserId?: string;
  },
  deps: MemoryCanvasDeps,
): Promise<CanvasOutcome> {
  const surfaceKey = `slack/${input.teamId}/${input.channelId}`;
  const room: CanvasRoom = { org: input.org, teamId: input.teamId, channelId: input.channelId };
  const domain = domainForChannel(surfaceKey, getConfig().loadDomains());
  const shows = domain !== undefined && domain.memory !== undefined && domain.memoryCanvas !== false;
  const auth = await deps.call("auth.test", {});
  const botUserId = auth?.ok === true && typeof auth.user_id === "string" ? auth.user_id : undefined;
  const outcome = await (shows
    ? publishChannelCanvas(room, null, botUserId, deps, input.joinedUserId)
    : withdrawIfOurs(room, "disabled", botUserId, deps)
  ).catch((): CanvasOutcome => "clear-failed");
  if (outcome !== "unchanged" && outcome !== "skipped-disabled") {
    console.log(`[open-everywhere:slack-canvas] ${input.trigger} recheck, channel ${input.channelId}: ${outcome}`);
  }
  await appendAudit({
    org: input.org,
    platform: "slack",
    workspace: input.teamId,
    surface: input.channelId,
    action: MEMORY_CANVAS_ACTION,
    detail: { domain: domain?.name ?? null, trigger: input.trigger, outcome },
  }).catch(() => undefined);
  return outcome;
}

export async function refreshMemoryCanvases(event: MemoryWriteEvent, deps: MemoryCanvasDeps): Promise<void> {
  const domains = domainsNamingSilo(event.silo, getConfig().loadDomains());
  if (domains.length === 0) return;
  const auth = await deps.call("auth.test", {});
  const teamId = auth?.ok === true && typeof auth.team_id === "string" ? auth.team_id : undefined;
  const botUserId = auth?.ok === true && typeof auth.user_id === "string" ? auth.user_id : undefined;
  if (!teamId) return;
  const channels = await domainChannels(teamId, domains, deps);
  if (channels.size === 0) return;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  for (const domain of domains) {
    const rooms = channels.get(domain.name);
    if (!rooms || rooms.length === 0) continue;
    const shows = domain.memoryCanvas !== false;
    const markdown = shows ? memoryCanvasMarkdown(domain, await readDomainMemory(event.org, domain), nowIso) : "";
    for (const room of rooms) {
      const canvasRoom: CanvasRoom = { org: event.org, teamId, channelId: room.channelId };
      const outcome = await (shows ? publishChannelCanvas(canvasRoom, markdown, botUserId, deps) : withdrawIfOurs(canvasRoom, "disabled", botUserId, deps)).catch(
        (): CanvasOutcome => (shows ? "failed" : "clear-failed"),
      );
      if (outcome !== "created" && outcome !== "updated") {
        console.log(`[open-everywhere:slack-canvas] domain "${domain.name}" channel ${room.channelId}: ${outcome}`);
      }
      const [platform, workspace, surface] = room.surfaceKey.split("/");
      await appendAudit({
        org: event.org,
        platform: platform!,
        workspace: workspace!,
        surface: surface!,
        action: MEMORY_CANVAS_ACTION,
        detail: { domain: domain.name, trigger: "memory-write", silo: event.silo, outcome, chars: markdown.length },
      }).catch(() => undefined);
    }
  }
}

const running = new Map<string, { again: boolean; done: Promise<void> }>();

export function coalescedRefresh(event: MemoryWriteEvent, deps: MemoryCanvasDeps): Promise<void> {
  const key = `${event.org}\u0000${event.silo}`;
  const current = running.get(key);
  if (current) {
    current.again = true;
    return current.done;
  }
  const state: { again: boolean; done: Promise<void> } = { again: false, done: Promise.resolve() };
  state.done = (async () => {
    try {
      do {
        state.again = false;
        await refreshMemoryCanvases(event, deps);
      } while (state.again);
    } finally {
      running.delete(key);
    }
  })();
  running.set(key, state);
  return state.done;
}
