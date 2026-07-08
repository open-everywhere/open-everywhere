import http from "node:http";
import { PolicyStore } from "./acl.ts";
import { handlePolicyPush, handleAcl } from "./handlers.ts";

const store = new PolicyStore();
const TOKEN = process.env.OE_EGRESS_PROXY_TOKEN?.trim() || undefined;
const PORT = Number(process.env.OE_EGRESS_CONTROL_PORT ?? 8080);
const HOST = process.env.OE_EGRESS_CONTROL_HOST ?? "0.0.0.0";

function authOk(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  const h = req.headers["authorization"];
  return typeof h === "string" && h === `Bearer ${TOKEN}`;
}

function remoteAddr(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "";
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, policies: store.size() });

    if (path === "/policy" && req.method === "POST") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      const result = handlePolicyPush(store, { body, remoteAddr: remoteAddr(req), authOk: authOk(req) });
      if (result.keyed) console.log(`[oe-egress-control] policy set for ${result.keyed} (${store.size()} active)`);
      return send(res, result.status, result.body);
    }

    if (path === "/policy" && req.method === "DELETE") {
      if (!authOk(req)) return send(res, 401, { error: "unauthorized" });
      const src = url.searchParams.get("sourceIp") ?? remoteAddr(req);
      const removed = store.delete(src);
      return send(res, 200, { ok: true, removed });
    }

    if (path === "/acl" && req.method === "GET") {
      const q = {
        src: url.searchParams.get("src") ?? undefined,
        host: url.searchParams.get("host") ?? undefined,
        method: url.searchParams.get("method") ?? undefined,
        path: url.searchParams.get("path") ?? undefined,
      };
      const { decision } = handleAcl(store, q);
      return send(res, 200, { allow: decision.allow, headers: decision.headers ?? null, matchedHost: decision.matchedHost ?? null });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(`[oe-egress-control] error: ${String(err)}`);
    return send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[oe-egress-control] listening on ${HOST}:${PORT}${TOKEN ? " (auth required)" : " (no auth token set)"}`);
});
