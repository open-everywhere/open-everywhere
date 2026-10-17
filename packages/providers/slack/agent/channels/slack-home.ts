import {
  appendAudit,
  bindFrom,
  buildHomeView,
  domainForChannel,
  getConfig,
  hasHomeAction,
  homeDomainsFor,
  resolvePartition,
  runHomeAction,
  SLACK_HOME_WIRE,
  type BindableContext,
  type Domain,
  type DomainMembershipProbe,
  type HomeBlock,
  type HomeDomainMembership,
  type HomeViewer,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackInteractivityTenantIds } from "./slack-tenant-fence.js";
import { confirmChannelInternal, slackAuthorIsMember, slackForm } from "./slack-events.js";
import { encodeSlackForm } from "./slack-web-api.js";

export const HOME_ACTION_PREFIX = SLACK_HOME_WIRE.actionPrefix;
export const HOME_MODAL_CALLBACK_ID = SLACK_HOME_WIRE.modalCallbackId;
const EDIT_BLOCK_ID = "oe_home_edit";
const EDIT_ELEMENT_ID = "text";
export const SLACK_HOME_MAX_BLOCKS = 100;
const ITEM_TEXT_MAX = 600;
const MEMBERSHIP_PAGES_MAX = 5;

export interface ParsedHomeOpen {
  readonly teamId?: string;
  readonly enterpriseId?: string;
  readonly userId: string;
}

export function parseHomeOpened(env: unknown): ParsedHomeOpen | undefined {
  const e = asObject(env);
  const ev = asObject(e?.event);
  if (e?.type !== "event_callback" || ev?.type !== "app_home_opened" || ev.tab !== "home") return undefined;
  const userId = str(ev.user);
  if (!userId) return undefined;
  const teamId = str(e.team_id);
  const enterpriseId = str(e.enterprise_id);
  return { userId, ...(teamId ? { teamId } : {}), ...(enterpriseId ? { enterpriseId } : {}) };
}

export interface ParsedHomeInteraction {
  readonly userId: string;
  readonly teamId?: string;
  readonly enterpriseId?: string;
  readonly triggerId?: string;
}

export interface ParsedHomeClick extends ParsedHomeInteraction {
  readonly action: string;
  readonly ref?: string;
}

export interface ParsedHomeSubmission extends ParsedHomeInteraction {
  readonly action: string;
  readonly ref?: string;
  readonly input?: string;
}

function interactionIds(p: Record<string, unknown>): ParsedHomeInteraction | undefined {
  const userId = str(asObject(p.user)?.id);
  if (!userId) return undefined;
  const { teamId, enterpriseId } = slackInteractivityTenantIds(p);
  const triggerId = str(p.trigger_id);
  return { userId, ...(teamId ? { teamId } : {}), ...(enterpriseId ? { enterpriseId } : {}), ...(triggerId ? { triggerId } : {}) };
}

export function parseHomeClick(raw: unknown): ParsedHomeClick | undefined {
  const p = asObject(raw);
  if (p?.type !== "block_actions" || !Array.isArray(p.actions)) return undefined;
  const ids = interactionIds(p);
  if (!ids) return undefined;
  for (const a of p.actions) {
    const act = asObject(a);
    const actionId = str(act?.action_id);
    if (!actionId?.startsWith(HOME_ACTION_PREFIX)) continue;
    if (act?.type === "overflow") {
      const value = str(asObject(act.selected_option)?.value);
      const split = value ? splitActionValue(value) : undefined;
      if (split) return { ...ids, ...split };
      continue;
    }
    const action = actionId.slice(HOME_ACTION_PREFIX.length);
    if (action) return { ...ids, action };
  }
  return undefined;
}

export function parseHomeSubmission(raw: unknown): ParsedHomeSubmission | undefined {
  const p = asObject(raw);
  if (p?.type !== "view_submission") return undefined;
  const view = asObject(p.view);
  if (view?.callback_id !== HOME_MODAL_CALLBACK_ID) return undefined;
  const ids = interactionIds(p);
  if (!ids) return undefined;
  const meta = str(view.private_metadata);
  const split = meta ? splitActionValue(meta) : undefined;
  if (!split) return undefined;
  const values = asObject(asObject(view.state)?.values);
  const input = str(asObject(asObject(values?.[EDIT_BLOCK_ID])?.[EDIT_ELEMENT_ID])?.value);
  return { ...ids, ...split, ...(input !== undefined ? { input } : {}) };
}

function splitActionValue(value: string): { action: string; ref?: string } | undefined {
  const bar = value.indexOf("|");
  const action = bar === -1 ? value : value.slice(0, bar);
  const ref = bar === -1 ? undefined : value.slice(bar + 1);
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(action)) return undefined;
  if (ref !== undefined && !/^[0-9a-f]{64}$/.test(ref)) return undefined;
  return { action, ...(ref !== undefined ? { ref } : {}) };
}

export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

type SlackBlock = Record<string, unknown>;

function plain(text: string): Record<string, unknown> {
  return { type: "plain_text", text: clip(text, 150), emoji: true };
}

function renderBlock(b: HomeBlock): SlackBlock[] {
  switch (b.kind) {
    case "heading":
      return [{ type: "header", text: plain(b.text) }];
    case "text":
      return [{ type: "section", text: { type: "mrkdwn", text: escapeSlackText(clip(b.text, 2900)) } }];
    case "note":
      return [{ type: "context", elements: [{ type: "mrkdwn", text: escapeSlackText(clip(b.text, 2900)) }] }];
    case "divider":
      return [{ type: "divider" }];
    case "buttons":
      return [
        {
          type: "actions",
          elements: b.buttons.map((btn) => ({ type: "button", action_id: `${HOME_ACTION_PREFIX}${btn.id}`, text: plain(btn.label) })),
        },
      ];
    case "room":
      return [{ type: "context", elements: [{ type: "mrkdwn", text: `${escapeSlackText(b.text)} <#${b.room.nativeId}>` }] }];
    case "item": {
      const label = b.label ? `*${escapeSlackText(clip(b.label, 80))}* · ` : "";
      const section: SlackBlock = { type: "section", text: { type: "mrkdwn", text: label + escapeSlackText(clip(b.text, ITEM_TEXT_MAX)) } };
      if (b.ref && b.actions.length > 0) {
        section.accessory = {
          type: "overflow",
          action_id: `${HOME_ACTION_PREFIX}item`,
          options: b.actions.map((a) => ({ text: plain(a.label), value: `${a.id}|${b.ref}` })),
        };
      } else if (b.link && /^https:\/\//u.test(b.link) && b.link.length <= 3000) {
        section.accessory = { type: "button", action_id: `${HOME_ACTION_PREFIX}link`, text: plain("Open"), url: b.link };
      }
      return [section];
    }
  }
}

export function renderHomeView(sections: readonly { readonly blocks: readonly HomeBlock[] }[], notice?: string): { type: "home"; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = [];
  if (notice) blocks.push({ type: "section", text: { type: "mrkdwn", text: `:information_source: ${escapeSlackText(clip(notice, 2900))}` } });
  const room = SLACK_HOME_MAX_BLOCKS - 1;
  let cut = false;
  outer: for (const s of sections) {
    for (const b of s.blocks) {
      const rendered = renderBlock(b);
      if (blocks.length + rendered.length > room) {
        cut = true;
        break outer;
      }
      blocks.push(...rendered);
    }
  }
  if (cut) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "This page is full, so some lines are not shown. Export gives you everything in your memory." }] });
  return { type: "home", blocks };
}

function homeActionModal(input: {
  readonly action: string;
  readonly ref: string;
  readonly kind: "edit" | "confirm";
  readonly itemText: string;
  readonly title: string;
  readonly yes: string;
  readonly note?: string;
}): Record<string, unknown> {
  const quoted = escapeSlackText(clip(input.itemText, 2800));
  return {
    type: "modal",
    callback_id: HOME_MODAL_CALLBACK_ID,
    private_metadata: `${input.action}|${input.ref}`,
    title: plain(clip(input.title, 24)),
    submit: plain(clip(input.yes, 24)),
    close: plain("Cancel"),
    blocks:
      input.kind === "edit"
        ? [
            {
              type: "input",
              block_id: EDIT_BLOCK_ID,
              label: plain("The fact, as I should remember it"),
              element: { type: "plain_text_input", action_id: EDIT_ELEMENT_ID, initial_value: clip(input.itemText, 1000), max_length: 1000 },
            },
            { type: "context", elements: [{ type: "mrkdwn", text: "The audit log records that this line changed, by fingerprint — never the words." }] },
          ]
        : [
            { type: "section", text: { type: "mrkdwn", text: `> ${quoted}` } },
            { type: "context", elements: [{ type: "mrkdwn", text: escapeSlackText(input.note ?? "I remove this line from your memory everywhere it is stored. You cannot undo it.") }] },
          ],
  };
}

export interface SlackHomeDeps {
  readonly call: (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  readonly authorIsMember: (userId: string, teamId: string | undefined) => Promise<boolean | undefined>;
  readonly channelInternal: (channelId: string) => Promise<boolean>;
}

export function liveSlackHomeDeps(): SlackHomeDeps {
  return {
    call: (method, body) => slackForm(method, encodeSlackForm(body)),
    authorIsMember: slackAuthorIsMember,
    channelInternal: confirmChannelInternal,
  };
}

function dmBindable(ids: { teamId?: string; userId: string; channelId: string }): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: ids.teamId ?? "", channel_id: ids.channelId, channel_type: "im" },
          principalId: ids.userId,
          principalType: "slack-user",
        },
      },
    },
  } as BindableContext;
}

export async function buildSlackHomeViewer(ids: ParsedHomeInteraction, deps: SlackHomeDeps): Promise<HomeViewer | undefined> {
  const opened = await deps.call("conversations.open", { users: ids.userId });
  const dmId = opened?.ok === true ? str(asObject(opened.channel)?.id) : undefined;
  const anchor = dmBindable({ ...ids, channelId: dmId ?? "home" });
  const binding = bindFrom(anchor);
  if (!binding.principalId) return undefined;
  const partition = resolvePartition(anchor);
  const member = await deps.authorIsMember(ids.userId, ids.teamId);
  const trust: "internal" | "external" = member === true ? "internal" : "external";
  const memberships = trust === "internal" ? await slackDomainMemberships(ids.userId, partition.workspaceKey, deps) : [];
  return {
    org: partition.org,
    platform: partition.platform,
    workspace: partition.workspace,
    principalId: binding.principalId,
    ...(ids.enterpriseId ? { enterprise: ids.enterpriseId } : {}),
    ...(dmId ? { personal: partition } : {}),
    trust,
    domains: homeDomainsFor(trust, memberships),
  };
}

async function slackDomainMemberships(
  userId: string,
  workspaceKey: string,
  deps: SlackHomeDeps,
  keep: (domain: Domain) => boolean = (d) => d.memory !== undefined,
): Promise<HomeDomainMembership[]> {
  const domains = getConfig().loadDomains();
  const byDomain = new Map<string, HomeDomainMembership>();
  let cursor: string | undefined;
  for (let page = 0; page < MEMBERSHIP_PAGES_MAX; page++) {
    const res = await deps.call("users.conversations", {
      user: userId,
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    if (res?.ok !== true || !Array.isArray(res.channels)) break;
    for (const c of res.channels) {
      const channelId = str(asObject(c)?.id);
      if (!channelId) continue;
      const surfaceKey = `${workspaceKey}/${channelId}`;
      const domain = domainForChannel(surfaceKey, domains);
      if (!domain || !keep(domain)) continue;
      if (!(await deps.channelInternal(channelId))) continue;
      const existing = byDomain.get(domain.name);
      const room = { surfaceKey, nativeId: channelId };
      byDomain.set(domain.name, existing ? { domain, rooms: [...existing.rooms, room] } : { domain, rooms: [room] });
    }
    cursor = str(asObject(res.response_metadata)?.next_cursor);
    if (!cursor) break;
  }
  return [...byDomain.values()];
}

export function slackDomainMembershipProbe(deps: SlackHomeDeps = liveSlackHomeDeps()): DomainMembershipProbe {
  return async ({ principalId, workspaceKey }) => {
    try {
      const [platform, teamId] = workspaceKey.split("/");
      if (platform !== "slack" || !teamId || principalId.length === 0) return { fullMember: false, rooms: [] };
      if ((await deps.authorIsMember(principalId, teamId)) !== true) return { fullMember: false, rooms: [] };
      const memberships = await slackDomainMemberships(principalId, workspaceKey, deps, () => true);
      return {
        fullMember: true,
        rooms: memberships.flatMap((m) => m.rooms.map((r) => ({ domain: m.domain.name, surfaceKey: r.surfaceKey, origin: { platform: "slack" as const, channelId: r.nativeId } }))),
      };
    } catch {
      return { fullMember: false, rooms: [] };
    }
  };
}

const HOME_PUBLISH_ACTION = "home.publish";

async function publishHome(userId: string, viewer: HomeViewer, deps: SlackHomeDeps, notice?: string): Promise<boolean> {
  const view = renderHomeView(await buildHomeView(viewer), notice);
  const res = await deps.call("views.publish", { user_id: userId, view });
  const ok = res?.ok === true;
  if (!ok) console.log(`[open-everywhere:slack-home] views.publish failed: ${String(res?.error ?? "no response")}`);
  await appendAudit({
    org: viewer.org,
    platform: viewer.platform,
    workspace: viewer.workspace,
    surface: viewer.personal?.surface ?? "home",
    principalId: viewer.principalId,
    action: HOME_PUBLISH_ACTION,
    detail: {
      ok,
      blocks: view.blocks.length,
      trust: viewer.trust,
      domains: viewer.domains.length,
      notice: notice !== undefined,
      ...(ok ? {} : { error: typeof res?.error === "string" ? res.error : "no response" }),
    },
  }).catch(() => undefined);
  return ok;
}

export async function handleHomeOpened(ev: ParsedHomeOpen, deps: SlackHomeDeps): Promise<boolean> {
  const viewer = await buildSlackHomeViewer(ev, deps);
  if (!viewer) return false;
  return publishHome(ev.userId, viewer, deps);
}

export async function handleHomeClick(click: ParsedHomeClick, deps: SlackHomeDeps): Promise<boolean> {
  if (!hasHomeAction(click.action)) return false;
  const viewer = await buildSlackHomeViewer(click, deps);
  if (!viewer) return false;
  if (click.ref === undefined) {
    const result = await runHomeAction(viewer, click.action);
    if (result.file) await deliverFile(click.userId, result.file, result.notice, deps);
    const notice = result.file ? `${result.notice} I sent it to our direct messages.` : result.notice;
    return publishHome(click.userId, viewer, deps, notice || undefined);
  }
  const located = await locateItem(viewer, click.action, click.ref);
  if (!located || !click.triggerId) {
    return publishHome(click.userId, viewer, deps, "That line is not on your page any more.");
  }
  const res = await deps.call("views.open", {
    trigger_id: click.triggerId,
    view: homeActionModal({
      action: click.action,
      ref: click.ref,
      kind: located.action.kind,
      itemText: located.text,
      title: located.action.confirm?.title ?? `${located.action.label}`,
      yes: located.action.confirm?.yes ?? "Save",
      ...(located.action.confirm?.note !== undefined ? { note: located.action.confirm.note } : {}),
    }),
  });
  return res?.ok === true;
}

async function locateItem(viewer: HomeViewer, actionId: string, ref: string) {
  for (const section of await buildHomeView(viewer)) {
    for (const b of section.blocks) {
      if (b.kind !== "item" || b.ref !== ref) continue;
      const action = b.actions.find((a) => a.id === actionId);
      if (action) return { text: b.text, action };
    }
  }
  return undefined;
}

export async function handleHomeSubmission(sub: ParsedHomeSubmission, deps: SlackHomeDeps): Promise<boolean> {
  if (!hasHomeAction(sub.action)) return false;
  const viewer = await buildSlackHomeViewer(sub, deps);
  if (!viewer) return false;
  const result = await runHomeAction(viewer, sub.action, sub.ref, sub.input);
  return publishHome(sub.userId, viewer, deps, result.notice || undefined);
}

async function deliverFile(
  userId: string,
  file: { readonly filename: string; readonly title: string; readonly content: string },
  comment: string,
  deps: SlackHomeDeps,
): Promise<boolean> {
  const opened = await deps.call("conversations.open", { users: userId });
  const channelId = opened?.ok === true ? str(asObject(opened.channel)?.id) : undefined;
  if (!channelId) return false;
  const bytes = new TextEncoder().encode(file.content);
  const url = await deps.call("files.getUploadURLExternal", { filename: file.filename, length: bytes.byteLength });
  const uploadUrl = url?.ok === true ? str(url.upload_url) : undefined;
  const fileId = url?.ok === true ? str(url.file_id) : undefined;
  if (!uploadUrl || !fileId) return false;
  const put = await fetch(uploadUrl, { method: "POST", headers: { "content-type": "text/markdown" }, body: bytes }).catch(() => undefined);
  if (!put?.ok) return false;
  const done = await deps.call("files.completeUploadExternal", {
    files: [{ id: fileId, title: file.title }],
    channel_id: channelId,
    initial_comment: comment,
  });
  return done?.ok === true;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
