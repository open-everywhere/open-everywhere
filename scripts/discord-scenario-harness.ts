import { createHmac } from "node:crypto";
import { registerDiscordProvider as __regDiscord } from "@open-everywhere/provider-discord/agent/register.js";
__regDiscord();
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { clearDiscordInfoCacheForTest } from "@open-everywhere/provider-discord/agent/channels/discord-channel-info.js";
import { clearTypingThrottleForTest } from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";

export class Timeline {
  private readonly lines: string[] = [];

  add(line: string): void {
    this.lines.push(line);
  }

  addBlock(head: string, body: string): void {
    this.add(head);
    for (const l of body.split("\n")) this.add(`      | ${l}`);
  }

  serialize(): string {
    return (
      this.lines
        .join("\n")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<iso-ts>")
        .replace(/(:oe-sup:g\d+)-[0-9a-f]{6}\b/g, "$1-<salt>") + "\n"
    );
  }
}

export function stubMonotonicNow(): () => void {
  const realNow = Date.now;
  const anchor = realNow();
  let ticks = 0;
  Date.now = () => anchor + 10 * ticks++;
  return () => {
    Date.now = realNow;
  };
}

const DISCORD_API = "https://discord.com/api/v10";
const EYES_ENCODED = encodeURIComponent("👀");

export type ChannelInfoScript = { readonly name: string; readonly type: number; readonly parent_id?: string } | "error-500" | "network-error";

export interface FetchScript {
  failNextThreadCreate?: boolean;
  channelInfo?: Record<string, ChannelInfoScript>;
  guildProbeNetworkError?: readonly string[];
  backscroll?: Record<string, readonly Record<string, unknown>[]>;
}

export interface FetchCapture {
  lastCardCustomIds: string[];
}

export function installFakeDiscordRest(timeline: Timeline, script: FetchScript = {}): { restore: () => void; capture: FetchCapture } {
  const realFetch = globalThis.fetch;
  let threadN = 0;
  let botMsgN = 0;
  const capture: FetchCapture = { lastCardCustomIds: [] };

  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
    if (!url.startsWith(DISCORD_API)) {
      timeline.add(`  → ✗ UNEXPECTED egress ${method} ${url}`);
      throw new Error(`scenario fetch fake: unexpected egress ${method} ${url}`);
    }
    const path = url.slice(DISCORD_API.length).replaceAll(EYES_ENCODED, "👀");
    const body = typeof init?.body === "string" ? init.body : undefined;

    if (method === "POST" && /^\/channels\/[^/]+\/messages\/[^/]+\/threads$/.test(path)) {
      if (script.failNextThreadCreate) {
        script.failNextThreadCreate = false;
        timeline.add(`  → POST ${path} ${body ?? ""} ⇒ 403 (scripted: missing Create Public Threads)`);
        return new Response(JSON.stringify({ message: "Missing Permissions", code: 50013 }), { status: 403 });
      }
      const id = `TH${++threadN}`;
      timeline.add(`  → POST ${path} ${body ?? ""} ⇒ 200 thread ${id}`);
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (method === "POST" && /^\/channels\/[^/]+\/messages$/.test(path)) {
      const id = `BM${++botMsgN}`;
      const parsed = body ? (JSON.parse(body) as { content?: string; components?: { components?: { custom_id?: string; label?: string }[] }[] }) : {};
      const buttons = (parsed.components ?? []).flatMap((row) => row.components ?? []);
      if (buttons.length > 0) {
        capture.lastCardCustomIds = buttons.map((b) => b.custom_id ?? "");
        timeline.addBlock(
          `  → POST ${path} ⇒ 200 message ${id} [buttons: ${buttons.map((b) => b.label ?? "?").join("/")}]`,
          parsed.content ?? "(no content)",
        );
      } else {
        timeline.addBlock(`  → POST ${path} ⇒ 200 message ${id}`, parsed.content ?? "(no content)");
      }
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (method === "POST" && /^\/channels\/[^/]+\/typing$/.test(path)) {
      timeline.add(`  → POST ${path} ⇒ 204`);
      return new Response(null, { status: 204 });
    }
    if ((method === "PUT" || method === "DELETE") && /^\/channels\/[^/]+\/messages\/[^/]+\/reactions\/.+\/@me$/.test(path)) {
      timeline.add(`  → ${method} ${path} ⇒ 204`);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && /^\/channels\/[^/]+\/messages(\?.*)?$/.test(path)) {
      const cid = path.slice("/channels/".length).split(/[/?]/)[0];
      const msgs = script.backscroll?.[cid] ?? [];
      timeline.add(`  → GET ${path} ⇒ 200 (${msgs.length} backscroll msg${msgs.length === 1 ? "" : "s"})`);
      return new Response(JSON.stringify(msgs), { status: 200 });
    }
    if (method === "GET" && /^\/channels\/[^/]+$/.test(path)) {
      const id = path.slice("/channels/".length);
      const scripted = script.channelInfo?.[id];
      if (scripted === "network-error") {
        timeline.add(`  → GET ${path} ⇒ ✗ network error (scripted)`);
        throw new Error("scripted network error");
      }
      if (scripted === "error-500") {
        timeline.add(`  → GET ${path} ⇒ 500 (scripted)`);
        return new Response(JSON.stringify({ message: "Internal Server Error" }), { status: 500 });
      }
      if (scripted) {
        const parentNote = scripted.parent_id ? ` parent=${scripted.parent_id}` : "";
        timeline.add(`  → GET ${path} ⇒ 200 name="${scripted.name}" type=${scripted.type}${parentNote}`);
        return new Response(JSON.stringify(scripted), { status: 200 });
      }
      timeline.add(`  → GET ${path} ⇒ 404 (unscripted — lookup fail-opens)`);
      return new Response(JSON.stringify({ message: "Unknown Channel", code: 10003 }), { status: 404 });
    }
    if (method === "GET" && /^\/guilds\/[^/]+$/.test(path)) {
      const id = path.slice("/guilds/".length);
      if (script.guildProbeNetworkError?.includes(id)) {
        timeline.add(`  → GET ${path} ⇒ ✗ network error (scripted — admin probe explodes)`);
        throw new Error("scripted network error");
      }
      timeline.add(`  → GET ${path} ⇒ 404 (unknown guild — REST admin probe fail-closes)`);
      return new Response(JSON.stringify({ message: "Unknown Guild", code: 10004 }), { status: 404 });
    }
    if (method === "GET" && /^\/guilds\/[^/]+\/members\/[^/]+$/.test(path)) {
      timeline.add(`  → GET ${path} ⇒ 404`);
      return new Response(JSON.stringify({ message: "Unknown Member", code: 10007 }), { status: 404 });
    }
    timeline.add(`  → ✗ UNEXPECTED egress ${method} ${path} (unhandled Discord call)`);
    throw new Error(`scenario fetch fake: unhandled Discord call ${method} ${path}`);
  };

  globalThis.fetch = fake as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
    capture,
  };
}

class FakeEveContext {
  private readonly durable = new Map<string, unknown>();
  private readonly virtual = new Map<string, unknown>();

  constructor(sessionId: string) {
    this.durable.set("eve.session", { sessionId, auth: null, turn: 1, parent: undefined });
  }

  get<T>(key: { name: string }): T | undefined {
    return (this.virtual.has(key.name) ? this.virtual.get(key.name) : this.durable.get(key.name)) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.virtual.has(key.name) || this.durable.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`Context key "${key.name}" is not set.`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, valueOrUpdater: T | ((current: T | undefined) => T)): T {
    const next = typeof valueOrUpdater === "function" ? (valueOrUpdater as (c: T | undefined) => T)(this.get(key)) : valueOrUpdater;
    this.durable.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {
    this.virtual.clear();
  }
  setVirtualContext<T>(key: { name: string }, value: T): void {
    this.virtual.set(key.name, value);
  }
  *entries(): Generator<readonly [unknown, unknown]> {
  }
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

export interface RelayMessageInput {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
  readonly channelType?: string;
  readonly guildId?: string;
  readonly authorId: string;
  readonly authorUsername?: string;
  readonly mentionsBot: boolean;
  readonly authorIsBot?: boolean;
}

interface SessionSim {
  readonly state: Record<string, unknown>;
  readonly ctx: FakeEveContext;
}

interface ChannelRuntime {
  readonly routes: readonly { readonly path: string; readonly method: string; readonly handler: unknown }[];
  readonly adapter: {
    createAdapterContext(args: { state: unknown; session: unknown; ctx: unknown }): unknown;
  } & Record<string, unknown>;
}

type RouteHandler = (req: Request, args: Record<string, unknown>) => Promise<Response>;

export class ScenarioDriver {
  readonly timeline = new Timeline();
  private readonly sessions = new Map<string, SessionSim>();
  private readonly channel: ChannelRuntime;
  private readonly secret: string;

  constructor(channelDefault: unknown, relaySecret: string) {
    this.channel = channelDefault as ChannelRuntime;
    this.secret = relaySecret;
  }

  note(text: string): void {
    this.timeline.add(`SEED ${text}`);
  }

  async inbound(msg: RelayMessageInput): Promise<void> {
    const kind = msg.channelType === "1" || msg.channelType === "3" ? "dm" : msg.mentionsBot ? "mention" : "plain";
    const bot = msg.authorIsBot ? " (BOT author)" : "";
    const where = msg.guildId ? `guild ${msg.guildId} channel ${msg.channelId} (type ${msg.channelType ?? "?"})` : `dm channel ${msg.channelId}`;
    this.timeline.addBlock(`IN  relay message ${msg.id} · ${where} · from ${msg.authorId}${bot} · ${kind}`, msg.content);

    const rawBody = JSON.stringify({
      source: "discord-gateway-relay",
      message: {
        id: msg.id,
        content: msg.content,
        channelId: msg.channelId,
        channelType: msg.channelType,
        guildId: msg.guildId,
        author: { id: msg.authorId, username: msg.authorUsername ?? msg.authorId.toLowerCase(), bot: msg.authorIsBot === true },
        mentionsBot: msg.mentionsBot,
      },
    });
    const signature = "sha256=" + createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");
    await this.post(rawBody, signature);
  }

  async inboundRaw(label: string, rawBody: string, signature: string | null): Promise<void> {
    this.timeline.add(`IN  ${label}`);
    await this.post(rawBody, signature);
  }

  signBody(rawBody: string): string {
    return "sha256=" + createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");
  }

  private async post(rawBody: string, signature: string | null): Promise<void> {
    const background: Promise<unknown>[] = [];
    const sendTo = async (continuationToken: string, message: string, options: { auth: unknown; state: Record<string, unknown> }) => {
      const existing = this.sessions.get(continuationToken);
      const auth = options.auth as { principalId?: string; attributes?: Record<string, string> };
      const attrs = auth.attributes ?? {};
      const parent = attrs.parent_channel_id ? ` parent=${attrs.parent_channel_id}` : "";
      const authLabel = `${auth.principalId ?? "?"} @ ${attrs.guild_id ?? "(no guild)"}/${attrs.channel_id ?? "?"} type=${attrs.channel_type ?? "?"}${parent}`;
      if (existing) {
        this.timeline.addBlock(`  ⇢ DISPATCH resume ${continuationToken} · auth ${authLabel} (state option dropped — resume keeps session state)`, message);
      } else {
        this.sessions.set(continuationToken, {
          state: options.state,
          ctx: new FakeEveContext(`session-${this.sessions.size + 1}`),
        });
        this.timeline.addBlock(`  ⇢ DISPATCH start ${continuationToken} · auth ${authLabel} · state ${JSON.stringify(options.state)}`, message);
      }
      return {};
    };
    const from = (continuationToken: string) => ({
      send: (message: string, options: { auth: unknown; state: Record<string, unknown> }) => sendTo(continuationToken, message, options),
    });

    const route = this.channel.routes.find((r) => r.method === "POST");
    if (!route) throw new Error("discord-gateway channel has no POST route");
    const res = await (route.handler as RouteHandler)(
      new Request(`https://oe.example${route.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(signature !== null ? { "x-oe-relay-signature": signature } : {}) },
        body: rawBody,
      }),
      {
        from,
        resolveSession: () => {
          throw new Error("scenario driver: resolveSession is not modeled");
        },
        waitUntil: (p: Promise<unknown>) => {
          background.push(p);
        },
        attachSession: () => {
          throw new Error("scenario driver: attachSession is not modeled");
        },
        to: (_channel: unknown, target: { token?: string; wakeId?: string; surfaceKey?: string; origin?: Record<string, unknown> }) => ({
          send: async (message: string) => {
            const origin = target.origin ?? {};
            this.timeline.addBlock(
              `  ⇢ DIVERT unified · token ${target.token ?? "?"} · surface ${target.surfaceKey ?? "?"} · origin ${String(origin.platform)}/${String(origin.channelId)}${origin.dm === true ? " dm" : ""}`,
              message,
            );
            return {} as never;
          },
        }),
        params: {},
        requestIp: null,
      },
    );
    for (const p of background) await p;
    this.timeline.add(`  ⇠ ${res.status} ${await res.text()}`);
  }

  async event(continuationToken: string, name: string, data?: unknown): Promise<void> {
    const session = this.mustSession(continuationToken);
    const dataNote = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    this.timeline.add(`EVT ${name} on ${continuationToken}${dataNote}`);
    const wrapped = this.channel.adapter[name] as ((d: unknown, i: unknown) => unknown) | undefined;
    if (!wrapped) throw new Error(`channel has no handler for event "${name}"`);
    const adapterCtx = this.channel.adapter.createAdapterContext({
      state: session.state,
      session: { continuation: { token: continuationToken, rekey: () => undefined } },
      ctx: undefined,
    });
    await eveContextStorage().run(session.ctx, async () => {
      await wrapped(data, adapterCtx);
    });
  }

  async markCardPosted(continuationToken: string, mark: () => void): Promise<void> {
    const session = this.mustSession(continuationToken);
    this.timeline.add(`ACT propose tool posts an approval card on ${continuationToken} (card-signal armed)`);
    await eveContextStorage().run(session.ctx, async () => {
      mark();
    });
  }

  private mustSession(token: string): SessionSim {
    const s = this.sessions.get(token);
    if (!s) throw new Error(`no session was started with continuation token "${token}" — dispatch it first`);
    return s;
  }
}

const GOLDENS_DIR = join(import.meta.dirname, "goldens");

export function unifiedDiff(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  const collapsed: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 6) {
      collapsed.push(...run.slice(0, 3), `  … ${run.length - 6} unchanged lines …`, ...run.slice(-3));
    } else {
      collapsed.push(...run);
    }
    run = [];
  };
  for (const line of out) {
    if (line.startsWith("  ")) run.push(line);
    else {
      flush();
      collapsed.push(line);
    }
  }
  flush();
  return collapsed.join("\n");
}

export function checkGolden(name: string, timeline: Timeline): boolean {
  const actual = timeline.serialize();
  const file = join(GOLDENS_DIR, `${name}.golden.txt`);
  if (process.env.UPDATE_GOLDENS === "1") {
    mkdirSync(GOLDENS_DIR, { recursive: true });
    writeFileSync(file, actual);
    console.log(`✎ golden updated: ${name}`);
    return true;
  }
  if (!existsSync(file)) {
    console.error(`✗ ${name}: golden file missing (${file}). Run with UPDATE_GOLDENS=1 to create it, then review + commit.`);
    console.error(`--- produced timeline ---\n${actual}`);
    return false;
  }
  const expected = readFileSync(file, "utf8");
  if (expected === actual) {
    console.log(`✓ ${name}`);
    return true;
  }
  console.error(`✗ ${name}: timeline diverged from golden (- expected / + actual):`);
  console.error(unifiedDiff(expected, actual));
  return false;
}

export class ScenarioRunner {
  private failures = 0;
  private ran = 0;

  constructor(
    private readonly channelDefault: unknown,
    private readonly relaySecret: string,
  ) {}

  async scenario(
    name: string,
    body: (s: ScenarioDriver, capture: FetchCapture) => Promise<void>,
    script: FetchScript = {},
  ): Promise<void> {
    const driver = new ScenarioDriver(this.channelDefault, this.relaySecret);
    const rest = installFakeDiscordRest(driver.timeline, script);
    const restoreNow = stubMonotonicNow();
    clearDiscordInfoCacheForTest();
    clearTypingThrottleForTest();
    try {
      await body(driver, rest.capture);
    } catch (err) {
      this.failures++;
      this.ran++;
      console.error(`✗ ${name}: scenario threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return;
    } finally {
      rest.restore();
      restoreNow();
    }
    this.ran++;
    if (!checkGolden(name, driver.timeline)) this.failures++;
  }

  finish(suiteLabel: string, extraFailures = 0): void {
    if (this.failures > 0 || extraFailures > 0) {
      const parts = [`${this.failures}/${this.ran} golden timeline(s) diverged`];
      if (extraFailures > 0) parts.push(`${extraFailures} post-scenario assertion(s) failed`);
      console.error(`\n✗ ${suiteLabel}: ${parts.join("; ")}\n`);
      process.exit(1);
    }
    console.log(`\n✓ ${suiteLabel}: ${this.ran} golden timelines matched\n`);
  }
}
