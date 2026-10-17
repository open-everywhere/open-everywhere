import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface SurfaceAppCreateVariant {
  readonly name: string;
  readonly summary: string;
}

export interface SurfaceAppCreateResult {
  readonly env: Readonly<Record<string, string>>;
  readonly appName: string;
  readonly installUrl?: string;
}

export interface SurfaceAppCreateFlow {
  readonly vendor: string;
  readonly variants: readonly SurfaceAppCreateVariant[];
  readonly appNameMax: number;
  readonly ownerProblem: (owner: string) => string | undefined;
  readonly createUrl: (opts: { readonly owner?: string; readonly state: string }) => string;
  readonly manifestField: string;
  readonly manifest: (opts: {
    readonly host: string;
    readonly variant: string;
    readonly redirectUrl: string;
    readonly appName?: string;
  }) => Record<string, unknown>;
  readonly envNames: (variant: string) => readonly string[];
  readonly codeProblem: (code: string) => string | undefined;
  readonly exchange: (opts: { readonly code: string; readonly variant: string; readonly fetchFn: typeof fetch }) => Promise<SurfaceAppCreateResult>;
  readonly after: readonly string[];
}

const FLOWS: Record<string, SurfaceAppCreateFlow> = {};

export function registerSurfaceAppCreateFlow(surface: string, flow: SurfaceAppCreateFlow): void {
  FLOWS[surface] = flow;
}

export function surfaceAppCreateFlow(surface: string): SurfaceAppCreateFlow | undefined {
  return FLOWS[surface];
}

export function surfaceAppCreateSurfaces(): string[] {
  return Object.keys(FLOWS).sort();
}

export function surfaceAppCreateNameProblem(flow: SurfaceAppCreateFlow, raw: string): string | undefined {
  const name = raw.trim();
  if (name === "") return "the app name is empty";
  if (name.length > flow.appNameMax) return `the app name is ${name.length} characters; ${flow.vendor} accepts at most ${flow.appNameMax}`;
  if (/[\x00-\x1f\x7f]/.test(name)) return "the app name holds a control character";
  return undefined;
}

export interface SurfaceAppCreateStatus {
  readonly surface: string;
  readonly variant: string;
  readonly state: "waiting" | "done" | "failed" | "expired";
  readonly openUrl: string;
  readonly expiresAt: string;
  readonly written?: readonly string[];
  readonly appName?: string;
  readonly installUrl?: string;
  readonly problem?: string;
}

interface Session {
  status: SurfaceAppCreateStatus;
  busy: boolean;
  readonly state: string;
  readonly server: Server;
  readonly timer: NodeJS.Timeout;
}

const SESSIONS = new Map<string, Session>();

export async function _stopSurfaceAppCreateForTest(): Promise<void> {
  for (const surface of [...SESSIONS.keys()]) await closeSession(surface);
}

async function closeSession(surface: string): Promise<void> {
  const s = SESSIONS.get(surface);
  if (s === undefined) return;
  clearTimeout(s.timer);
  SESSIONS.delete(surface);
  await new Promise<void>((done) => s.server.close(() => done()));
}

export function surfaceAppCreateStatus(surface: string): SurfaceAppCreateStatus | undefined {
  return SESSIONS.get(surface)?.status ?? FINISHED.get(surface);
}

const FINISHED = new Map<string, SurfaceAppCreateStatus>();

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function page(res: ServerResponse, code: number, title: string, body: string): void {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}` +
      `a.button,button{display:inline-block;padding:.6rem 1rem;border-radius:6px;border:0;background:#1f6feb;color:#fff;text-decoration:none;font:inherit;cursor:pointer}</style>` +
      `</head><body><h1>${esc(title)}</h1>${body}</body></html>`,
  );
}

function sameState(given: string | null, want: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface StartSurfaceAppCreateOptions {
  readonly surface: string;
  readonly flow: SurfaceAppCreateFlow;
  readonly host: string;
  readonly variant: string;
  readonly appName?: string;
  readonly owner?: string;
  readonly writeEnv: (values: Readonly<Record<string, string>>) => string | undefined;
  readonly fetchFn?: typeof fetch;
  readonly ttlMs?: number;
}

export async function startSurfaceAppCreate(opts: StartSurfaceAppCreateOptions): Promise<SurfaceAppCreateStatus> {
  await closeSession(opts.surface);
  FINISHED.delete(opts.surface);
  const state = randomBytes(32).toString("hex");
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  const { flow, surface } = opts;

  const finish = (status: SurfaceAppCreateStatus): void => {
    const s = SESSIONS.get(surface);
    if (s === undefined || s.state !== state) return;
    s.status = status;
    FINISHED.set(surface, status);
    setImmediate(() => void closeSession(surface));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const session = SESSIONS.get(surface);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || session === undefined || session.state !== state) {
      page(res, 404, "Not found", "<p>This page is not part of a setup in progress.</p>");
      return;
    }
    if (url.pathname === "/start") {
      if (!sameState(url.searchParams.get("state"), state)) {
        page(res, 404, "Not found", "<p>This link is not from the current setup. Ask your agent for a new one.</p>");
        return;
      }
      const redirectUrl = `${origin}/callback`;
      const manifest = flow.manifest({
        host: opts.host,
        variant: opts.variant,
        redirectUrl,
        ...(opts.appName === undefined ? {} : { appName: opts.appName }),
      });
      const action = flow.createUrl({ state, ...(opts.owner === undefined ? {} : { owner: opts.owner }) });
      page(
        res,
        200,
        `Create the ${flow.vendor} app`,
        `<p>${esc(flow.vendor)} opens next. Check the name, then confirm. You can change the name there.</p>` +
          `<form id="create" method="post" action="${esc(action)}">` +
          `<input type="hidden" name="${esc(flow.manifestField)}" value="${esc(JSON.stringify(manifest))}">` +
          `<button type="submit">Continue to ${esc(flow.vendor)}</button></form>` +
          `<script>document.getElementById("create").submit()</script>`,
      );
      return;
    }
    if (url.pathname === "/callback") {
      if (!sameState(url.searchParams.get("state"), state)) {
        page(res, 400, "Not this setup", "<p>This link did not come from the current setup. Nothing was saved.</p>");
        return;
      }
      if (session.busy) {
        page(res, 409, "Setup in progress", "<p>This setup is still finishing. Go back to your agent: it can see the result.</p>");
        return;
      }
      if (session.status.state !== "waiting") {
        page(res, 409, "Already finished", "<p>This setup already finished. Nothing more was saved.</p>");
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const codeProblem = flow.codeProblem(code);
      if (codeProblem !== undefined) {
        finish({ ...session.status, state: "failed", problem: codeProblem });
        page(res, 400, "Setup failed", `<p>${esc(flow.vendor)} did not send a usable code. Ask your agent to start again.</p>`);
        return;
      }
      session.busy = true;
      let result: SurfaceAppCreateResult;
      try {
        result = await flow.exchange({ code, variant: opts.variant, fetchFn });
      } catch (err) {
        const problem = err instanceof Error ? err.message : String(err);
        finish({ ...session.status, state: "failed", problem });
        page(res, 502, "Setup failed", `<p>${esc(flow.vendor)} did not hand over the app's keys: ${esc(problem)}</p><p>Ask your agent to start again.</p>`);
        return;
      }
      if (SESSIONS.get(surface)?.state !== state) {
        const ended = FINISHED.get(surface);
        const expired = ended?.state === "expired" && ended.openUrl === session.status.openUrl;
        if (expired) FINISHED.set(surface, { ...ended, appName: result.appName, problem: "the setup expired before the keys were saved" });
        page(
          res,
          409,
          "Keys not saved",
          `<p>${esc(result.appName)} exists on ${esc(flow.vendor)}, but ${expired ? "this setup expired" : "a newer setup started"} before its keys were saved. ` +
            `Delete it in your ${esc(flow.vendor)} app settings, then ${expired ? "ask your agent to start again" : "use the newer setup"}.</p>`,
        );
        return;
      }
      let refusal: string | undefined;
      try {
        refusal = opts.writeEnv(result.env);
      } catch {
        refusal = "the env file could not be written";
      }
      if (refusal !== undefined) {
        finish({ ...session.status, state: "failed", appName: result.appName, problem: refusal });
        page(
          res,
          500,
          "Setup failed",
          `<p>${esc(result.appName)} exists on ${esc(flow.vendor)}, but its keys could not be saved: ${esc(refusal)}. ` +
            `Delete it in your ${esc(flow.vendor)} app settings, then ask your agent to start again.</p>`,
        );
        return;
      }
      finish({
        ...session.status,
        state: "done",
        written: Object.keys(result.env).sort(),
        appName: result.appName,
        ...(result.installUrl === undefined ? {} : { installUrl: result.installUrl }),
      });
      page(
        res,
        200,
        `${result.appName} is ready`,
        `<p>The app's keys are saved on this computer. Next, install the app on the repositories it should work in.</p>` +
          (result.installUrl === undefined ? "" : `<p><a class="button" href="${esc(result.installUrl)}">Install ${esc(result.appName)}</a></p>`) +
          `<p>Then go back to your agent.</p>`,
      );
      return;
    }
    page(res, 404, "Not found", "<p>This page is not part of a setup in progress.</p>");
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) page(res, 500, "Setup failed", "<p>Something went wrong. Ask your agent to start again.</p>");
    });
  });
  await new Promise<void>((ready, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ready());
  });
  server.unref();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const timer = setTimeout(() => {
    const s = SESSIONS.get(surface);
    if (s === undefined || s.state !== state) return;
    FINISHED.set(surface, { ...s.status, state: "expired" });
    void closeSession(surface);
  }, ttlMs);
  timer.unref();
  const status: SurfaceAppCreateStatus = { surface, variant: opts.variant, state: "waiting", openUrl: `${origin}/start?state=${state}`, expiresAt };
  SESSIONS.set(surface, { status, state, server, timer, busy: false });
  return status;
}
