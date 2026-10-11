import {
  agentDisplayName,
  appendAudit,
  domainForChannel,
  domainsNamingSilo,
  getConfig,
  readDomainMemory,
  renderMemoryMarkdown,
  type Domain,
  type MemoryWriteEvent,
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
    `\n---\n${name} keeps this canvas up to date from this domain's memory. ` +
    `To correct or forget a line, ask ${name} in this channel. A direct edit to this canvas is replaced on the next memory change.\n`;
  const text = defuseCanvasText(body);
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
    `This channel is shared outside the workspace, or one of its members is not a full member, so ${name} no longer shows a domain's memory here. ` +
    `The memory itself is unchanged. Members can still ask ${name} about it where the domain's memory is readable.\n`
  );
}

type WithdrawReason = "external" | "guest" | "disabled";

async function withdrawIfOurs(channelId: string, reason: WithdrawReason, botUserId: string | undefined, deps: MemoryCanvasDeps): Promise<CanvasOutcome> {
  const info = await deps.call("conversations.info", { channel: channelId });
  if (info?.ok !== true) return "clear-failed";
  const existing = canvasIdOf(info);
  if (!existing) return `skipped-${reason}`;
  const file = await deps.call("files.info", { file: existing });
  if (file?.ok !== true) return "clear-failed";
  const creator = (file.file as { user?: unknown } | undefined)?.user;
  if (botUserId === undefined) return "clear-failed";
  if (creator !== botUserId) return `skipped-${reason}`;
  const cleared = await deps.call("canvases.edit", {
    canvas_id: existing,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown: withdrawnCanvasMarkdown() } }],
  });
  return cleared?.ok === true ? `cleared-${reason}` : "clear-failed";
}

function canvasIdOf(info: Record<string, unknown>): string | undefined {
  const props = (info.channel as { properties?: { canvas?: { file_id?: unknown } } } | undefined)?.properties;
  return typeof props?.canvas?.file_id === "string" ? props.canvas.file_id : undefined;
}

export async function publishChannelCanvas(
  channelId: string,
  markdown: string | null,
  botUserId: string | undefined,
  deps: MemoryCanvasDeps,
  teamId?: string,
  joinedUserId?: string,
): Promise<CanvasOutcome> {
  const blocked: "external" | "guest" | undefined = !(await deps.channelInternal(channelId))
    ? "external"
    : (joinedUserId !== undefined && joinedUserId !== botUserId && (await deps.authorIsMember(joinedUserId, teamId)) !== true) ||
        !(await everyMemberIsFull(channelId, teamId, botUserId, deps))
      ? "guest"
      : undefined;
  if (blocked) return withdrawIfOurs(channelId, blocked, botUserId, deps);
  if (markdown === null) return "unchanged";
  const info = await deps.call("conversations.info", { channel: channelId });
  if (info?.ok !== true) return "failed";
  const existing = canvasIdOf(info);
  if (!existing) {
    const created = await deps.call("conversations.canvases.create", { channel_id: channelId, document_content: { type: "markdown", markdown } });
    return created?.ok === true ? "created" : "failed";
  }
  const file = await deps.call("files.info", { file: existing });
  const creator = file?.ok === true ? (file.file as { user?: unknown } | undefined)?.user : undefined;
  if (botUserId === undefined || creator !== botUserId) return "skipped-foreign";
  const edited = await deps.call("canvases.edit", { canvas_id: existing, changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }] });
  return edited?.ok === true ? "updated" : "failed";
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
  const domain = domainForChannel(surfaceKey, getConfig().loadDomains());
  const shows = domain !== undefined && domain.memory !== undefined && domain.memoryCanvas !== false;
  const auth = await deps.call("auth.test", {});
  const botUserId = auth?.ok === true && typeof auth.user_id === "string" ? auth.user_id : undefined;
  const outcome = await (shows
    ? publishChannelCanvas(input.channelId, null, botUserId, deps, input.teamId, input.joinedUserId)
    : withdrawIfOurs(input.channelId, "disabled", botUserId, deps)
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
      const outcome = await (shows ? publishChannelCanvas(room.channelId, markdown, botUserId, deps, teamId) : withdrawIfOurs(room.channelId, "disabled", botUserId, deps)).catch(
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
