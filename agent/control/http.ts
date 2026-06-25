import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildControlServer } from "./server.js";

export interface AdminHttpOptions {
  readonly authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
  readonly allowUnauthenticated?: boolean;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : undefined;
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
}

export async function handleControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AdminHttpOptions = {},
  parsedBody?: unknown,
): Promise<void> {
  const allowed = opts.authorize
    ? await opts.authorize(req)
    : opts.allowUnauthenticated === true;
  if (!allowed) {
    deny(res, 401, "unauthorized: the remote control plane requires OAuth (RFC 9728) — no authorizer configured");
    return;
  }

  let body = parsedBody;
  if (body === undefined && req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch {
      deny(res, 400, "invalid JSON body");
      return;
    }
  }

  const server = buildControlServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createAdminHttpServer(opts: AdminHttpOptions = {}): Server {
  return createServer((req, res) => {
    void handleControlRequest(req, res, opts).catch((err) => {
      if (!res.headersSent) deny(res, 500, `control server error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}
