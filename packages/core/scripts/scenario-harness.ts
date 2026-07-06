import { createHmac } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<iso-ts>") + "\n"
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

export interface FetchScript {
  failNextThreadCreate?: boolean;
}

export function installFakeDiscordRest(timeline: Timeline, script: FetchScript = {}): { restore: () => void } {
  const realFetch = globalThis.fetch;
  let threadN = 0;
  let botMsgN = 0;

  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
    if (!url.startsWith(DISCORD_API)) {
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
      const content = body ? (JSON.parse(body) as { content?: string }).content : undefined;
      timeline.addBlock(`  → POST ${path} ⇒ 200 message ${id}`, content ?? "(no content)");
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
    if (method === "GET" && /^\/guilds\/[^/]+$/.test(path)) {
      timeline.add(`  → GET ${path} ⇒ 404 (unknown guild — REST admin probe fail-closes)`);
      return new Response(JSON.stringify({ message: "Unknown Guild", code: 10004 }), { status: 404 });
    }
    if (method === "GET" && /^\/guilds\/[^/]+\/members\/[^/]+$/.test(path)) {
      timeline.add(`  → GET ${path} ⇒ 404`);
      return new Response(JSON.stringify({ message: "Unknown Member", code: 10007 }), { status: 404 });
    }
    throw new Error(`scenario fetch fake: unhandled Discord call ${method} ${path}`);
  };

  globalThis.fetch = fake as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
    },
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
    const where = msg.guildId ? `guild ${msg.guildId} channel ${msg.channelId} (type ${msg.channelType ?? "?"})` : `dm channel ${msg.channelId}`;
    this.timeline.addBlock(`IN  relay message ${msg.id} · ${where} · from ${msg.authorId} · ${kind}`, msg.content);

    const rawBody = JSON.stringify({
      source: "discord-gateway-relay",
      message: {
        id: msg.id,
        content: msg.content,
        channelId: msg.channelId,
        channelType: msg.channelType,
        guildId: msg.guildId,
        author: { id: msg.authorId, username: msg.authorUsername ?? msg.authorId.toLowerCase(), bot: false },
        mentionsBot: msg.mentionsBot,
      },
    });
    const signature = "sha256=" + createHmac("sha256", this.secret).update(rawBody, "utf8").digest("hex");

    const background: Promise<unknown>[] = [];
    const send = async (message: string, options: { auth: unknown; continuationToken: string; state: Record<string, unknown> }) => {
      const existing = this.sessions.get(options.continuationToken);
      if (existing) {
        this.timeline.addBlock(`  ⇢ DISPATCH resume ${options.continuationToken} (state option dropped — resume keeps session state)`, message);
      } else {
        this.sessions.set(options.continuationToken, {
          state: options.state,
          ctx: new FakeEveContext(`session-${this.sessions.size + 1}`),
        });
        const auth = options.auth as { principalId?: string; attributes?: Record<string, string> };
        const attrs = auth.attributes ?? {};
        const authLabel = `${auth.principalId ?? "?"} @ ${attrs.guild_id ?? "(no guild)"}/${attrs.channel_id ?? "?"} type=${attrs.channel_type ?? "?"}`;
        this.timeline.addBlock(`  ⇢ DISPATCH start ${options.continuationToken} · auth ${authLabel} · state ${JSON.stringify(options.state)}`, message);
      }
      return {};
    };

    const route = this.channel.routes.find((r) => r.method === "POST");
    if (!route) throw new Error("discord-gateway channel has no POST route");
    const res = await (route.handler as RouteHandler)(
      new Request(`https://oe.example${route.path}`, {
        method: "POST",
        headers: { "x-oe-relay-signature": signature, "content-type": "application/json" },
        body: rawBody,
      }),
      {
        send,
        waitUntil: (p: Promise<unknown>) => {
          background.push(p);
        },
        getSession: () => {
          throw new Error("scenario driver: getSession is not modeled");
        },
        receive: () => {
          throw new Error("scenario driver: cross-channel receive is not modeled");
        },
        params: {},
        requestIp: null,
      },
    );
    if (res.status !== 200) this.timeline.add(`  ⇠ route responded ${res.status} ${await res.text()}`);
    for (const p of background) await p;
  }

  async event(continuationToken: string, name: string, data?: unknown): Promise<void> {
    const session = this.mustSession(continuationToken);
    const dataNote = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    this.timeline.add(`EVT ${name} on ${continuationToken}${dataNote}`);
    const wrapped = this.channel.adapter[name] as ((d: unknown, i: unknown) => unknown) | undefined;
    if (!wrapped) throw new Error(`channel has no handler for event "${name}"`);
    const adapterCtx = this.channel.adapter.createAdapterContext({
      state: session.state,
      session: { continuationToken, setContinuationToken: () => undefined },
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
