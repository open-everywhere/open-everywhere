import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { TeamsDriverConfig } from "./env.js";
import { pollUntil, sleep } from "./poll.js";

const TOKEN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_SKEW_MS = 60_000;
const MAX_GRAPH_PAGES = 20;

export interface TeamsMessage {
  readonly id: string;
  readonly fromApplicationId?: string;
  readonly fromUserId?: string;
  readonly text: string;
  readonly createdDateTime?: string;
  readonly attachments?: readonly TeamsMessageAttachment[];
}

export interface TeamsMessageAttachment {
  readonly contentType?: string;
  readonly content?: string;
}

interface GraphChatMessage {
  id?: string;
  from?: { application?: { id?: string }; user?: { id?: string } };
  body?: { contentType?: string; content?: string };
  createdDateTime?: string;
  attachments?: { contentType?: string; content?: string }[];
}

export const TEAMS_APPROVAL_DATA_KEY = "oe_teams_approval";

export interface TeamsCardAction {
  readonly title?: string;
  readonly verb?: string;
  readonly pendingId: string;
  readonly decision: string;
  readonly org: string;
}

export function teamsApprovalCardActions(m: Pick<TeamsMessage, "attachments">): readonly TeamsCardAction[] {
  const out: TeamsCardAction[] = [];
  for (const a of m.attachments ?? []) {
    if (a.contentType !== "application/vnd.microsoft.card.adaptive" || typeof a.content !== "string") continue;
    let card: unknown;
    try {
      card = JSON.parse(a.content);
    } catch {
      continue;
    }
    const actions = (card as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions as { title?: unknown; verb?: unknown; data?: Record<string, unknown> }[]) {
      const payload = action?.data?.[TEAMS_APPROVAL_DATA_KEY] as { id?: unknown; decision?: unknown; org?: unknown } | undefined;
      if (!payload || typeof payload.id !== "string" || typeof payload.decision !== "string" || typeof payload.org !== "string") continue;
      out.push({
        ...(typeof action.title === "string" ? { title: action.title } : {}),
        ...(typeof action.verb === "string" ? { verb: action.verb } : {}),
        pendingId: payload.id,
        decision: payload.decision,
        org: payload.org,
      });
    }
  }
  return out;
}

export interface GraphPage<T> {
  readonly value?: readonly T[];
  readonly "@odata.nextLink"?: string;
}

export async function collectGraphPages<T>(
  first: string,
  fetchPage: (url: string) => Promise<GraphPage<T>>,
  maxPages: number,
): Promise<readonly T[]> {
  const items: T[] = [];
  let next: string | undefined = first;
  for (let page = 0; page < maxPages; page += 1) {
    const json: GraphPage<T> = await fetchPage(next);
    for (const item of json.value ?? []) items.push(item);
    const link = json["@odata.nextLink"];
    if (typeof link !== "string" || link.length === 0) return items;
    next = link;
  }
  throw new Error(`teams: reply chain still had pages after ${maxPages} — refusing to answer with a partial collection`);
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function toMessage(m: GraphChatMessage): TeamsMessage {
  return {
    id: m.id ?? "",
    fromApplicationId: m.from?.application?.id,
    fromUserId: m.from?.user?.id,
    text: stripHtml(m.body?.content ?? ""),
    createdDateTime: m.createdDateTime,
    ...(m.attachments && m.attachments.length > 0
      ? { attachments: m.attachments.map((a) => ({ ...(a.contentType ? { contentType: a.contentType } : {}), ...(typeof a.content === "string" ? { content: a.content } : {}) })) }
      : {}),
  };
}

export function isMissingChatScopeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /missing scope permissions/i.test(msg) && /\bchat\.read/i.test(msg);
}

export function readRefreshSidecar(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeRefreshSidecar(path: string, token: string): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[e2e:teams] could not persist rotated refresh token to ${path}: ${String(err instanceof Error ? err.message : err)}`);
  }
}

export class TeamsDriver {
  private currentRefreshToken: string;

  constructor(private readonly cfg: TeamsDriverConfig) {
    this.currentRefreshToken = readRefreshSidecar(cfg.refreshTokenFile) ?? cfg.refreshToken;
  }

  get channelId(): string {
    return this.cfg.channelId;
  }

  private cached?: { token: string; expiresAt: number };

  private async accessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - TOKEN_SKEW_MS) return this.cached.token;
    try {
      return await this.exchangeRefresh(this.currentRefreshToken);
    } catch (err) {
      if (this.currentRefreshToken !== this.cfg.refreshToken) {
        console.warn(
          `[e2e:teams] sidecar refresh token failed (${String(err instanceof Error ? err.message : err)}); ` +
            "falling back to the seed E2E_TEAMS_REFRESH_TOKEN.",
        );
        this.currentRefreshToken = this.cfg.refreshToken;
        return await this.exchangeRefresh(this.currentRefreshToken);
      }
      throw err;
    }
  }

  private async exchangeRefresh(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.cfg.clientId,
      refresh_token: refreshToken,
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await fetch(`${TOKEN_BASE}/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      const detail = json.error_description ?? json.error ?? `http ${res.status}`;
      throw new Error(`teams token exchange failed: ${detail}`);
    }
    if (json.refresh_token && json.refresh_token !== this.currentRefreshToken) {
      this.currentRefreshToken = json.refresh_token;
      writeRefreshSidecar(this.cfg.refreshTokenFile, json.refresh_token);
    }
    const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1_000;
    this.cached = { token: json.access_token, expiresAt };
    return json.access_token;
  }

  private async graph(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<unknown> {
    const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
    if (!url.startsWith(`${GRAPH_BASE}/`)) throw new Error(`teams ${method}: refusing a link outside ${GRAPH_BASE}`);
    const token = await this.accessToken();
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && !retried) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      await sleep(Math.min((Number.isFinite(retryAfter) ? retryAfter : 1) * 1_000, 10_000));
      return this.graph(method, path, body, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`teams ${method} ${path} failed: http ${res.status} ${text}`);
    }
    return res.json();
  }

  async channelInfo(): Promise<{ id: string; displayName: string }> {
    const json = (await this.graph("GET", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}`)) as {
      id?: string;
      displayName?: string;
    };
    return { id: json.id ?? "", displayName: json.displayName ?? "" };
  }

  async teamInfo(): Promise<{ id: string; displayName: string }> {
    const json = (await this.graph("GET", `/teams/${this.cfg.teamId}`)) as { id?: string; displayName?: string };
    return { id: json.id ?? "", displayName: json.displayName ?? "" };
  }

  async channels(): Promise<readonly { id: string; displayName: string }[]> {
    const json = (await this.graph("GET", `/teams/${this.cfg.teamId}/channels`)) as {
      value?: readonly { id?: string; displayName?: string }[];
    };
    return (json.value ?? []).map((c) => ({ id: c.id ?? "", displayName: c.displayName ?? "" }));
  }

  async createChannel(displayName: string, description: string): Promise<{ id: string; displayName: string }> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels`, {
      displayName,
      description,
      membershipType: "standard",
    })) as { id?: string; displayName?: string };
    return { id: json.id ?? "", displayName: json.displayName ?? displayName };
  }

  async resolveDmChat(): Promise<{ chatId: string }> {
    const installed = (await this.graph("GET", "/me/teamwork/installedApps?$expand=teamsApp")) as {
      value?: readonly { id?: string; teamsApp?: { externalId?: string; displayName?: string } }[];
    };
    const row = (installed.value ?? []).find((r) => r.teamsApp?.externalId === this.cfg.botAppId);
    if (!row?.id) {
      throw new Error(
        `teams DM: no personal install row for app externalId ${this.cfg.botAppId} in ${(installed.value ?? []).length} ` +
          `installedApps — the OPE-887 precondition (personal-scope install for the driver user) is not met`,
      );
    }
    const chat = (await this.graph("GET", `/me/teamwork/installedApps/${encodeURIComponent(row.id)}/chat`)) as { id?: string };
    if (!chat.id) throw new Error(`teams DM: installedApps/${row.id}/chat returned no chat id`);
    return { chatId: chat.id };
  }

  async postDm(chatId: string, text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/chats/${encodeURIComponent(chatId)}/messages`, {
      body: { contentType: "html", content: htmlEscape(text) },
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async dmMessages(chatId: string): Promise<readonly TeamsMessage[]> {
    const json = (await this.graph("GET", `/chats/${encodeURIComponent(chatId)}/messages`)) as { value?: readonly GraphChatMessage[] };
    return (json.value ?? []).map(toMessage);
  }

  async awaitDmReply(chatId: string, opts: { timeoutMs: number; afterIso?: string; contains?: string }): Promise<TeamsMessage> {
    return pollUntil(
      async () =>
        (await this.dmMessages(chatId)).find(
          (m) =>
            this.isBotReply(m) &&
            (opts.afterIso === undefined || (m.createdDateTime ?? "") > opts.afterIso!) &&
            (opts.contains === undefined || m.text.includes(opts.contains)),
        ),
      {
        timeoutMs: opts.timeoutMs,
        what: `a bot reply in the 1:1 chat ${chatId}${opts.afterIso ? ` after ${opts.afterIso}` : ""}${opts.contains ? ` containing "${opts.contains}"` : ""}`,
      },
    );
  }

  async postMention(text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages`, {
      body: { contentType: "html", content: `<at id="0">Open Everywhere</at> ${htmlEscape(text)}` },
      mentions: [
        {
          id: 0,
          mentionText: "Open Everywhere",
          mentioned: {
            application: { id: this.cfg.botAppId, displayName: "Open Everywhere", applicationIdentityType: "bot" },
          },
        },
      ],
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async postPlainRoot(text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages`, {
      body: { contentType: "html", content: htmlEscape(text) },
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async postReply(rootMessageId: string, text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages/${rootMessageId}/replies`, {
      body: { contentType: "html", content: htmlEscape(text) },
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async postMentionReply(rootMessageId: string, text: string): Promise<TeamsMessage> {
    const json = (await this.graph("POST", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages/${rootMessageId}/replies`, {
      body: { contentType: "html", content: `<at id="0">Open Everywhere</at> ${htmlEscape(text)}` },
      mentions: [{ id: 0, mentionText: "Open Everywhere", mentioned: { application: { id: this.cfg.botAppId, displayName: "Open Everywhere", applicationIdentityType: "bot" } } }],
    })) as GraphChatMessage;
    return toMessage(json);
  }

  async replies(rootMessageId: string): Promise<readonly TeamsMessage[]> {
    const pages = await collectGraphPages<GraphChatMessage>(
      `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages/${rootMessageId}/replies`,
      (url) => this.graph("GET", url) as Promise<GraphPage<GraphChatMessage>>,
      MAX_GRAPH_PAGES,
    );
    return pages.map(toMessage);
  }

  async channelRootMessages(top = 30): Promise<readonly TeamsMessage[]> {
    const page = (await this.graph("GET", `/teams/${this.cfg.teamId}/channels/${this.cfg.channelId}/messages?$top=${top}`)) as GraphPage<GraphChatMessage>;
    return (page.value ?? []).map(toMessage);
  }

  isBotAuthored(m: TeamsMessage): boolean {
    return m.fromApplicationId === this.cfg.botAppId;
  }

  isBotReply(m: TeamsMessage): boolean {
    return m.fromApplicationId === this.cfg.botAppId && m.text.trim().length > 0;
  }

  async awaitReply(rootMessageId: string, opts: { timeoutMs: number; afterIso?: string; contains?: string }): Promise<TeamsMessage> {
    return pollUntil(
      async () =>
        (await this.replies(rootMessageId)).find(
          (m) =>
            this.isBotReply(m) &&
            (opts.afterIso === undefined || (m.createdDateTime ?? "") > opts.afterIso!) &&
            (opts.contains === undefined || m.text.includes(opts.contains)),
        ),
      {
        timeoutMs: opts.timeoutMs,
        what:
          `a bot reply in the reply chain of message ${rootMessageId}` +
          `${opts.afterIso ? ` after ${opts.afterIso}` : ""}${opts.contains ? ` containing "${opts.contains}"` : ""}`,
      },
    );
  }
}
