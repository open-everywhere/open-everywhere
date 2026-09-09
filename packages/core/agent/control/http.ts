import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildControlServer } from "./server.js";
import { SERVICE_TOKEN_ISSUER, type AdminIdentity } from "./auth.js";
import type { TranscriptExportReader } from "./transcript-export.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export interface AdminHttpOptions {
  readonly authenticate?: (req: IncomingMessage) => Promise<AdminIdentity | null>;
  readonly requiredRole?: string;
  readonly includeWrites?: boolean;
  readonly allowUnauthenticated?: boolean;
  readonly readTranscript?: TranscriptExportReader;
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
  let actor = "local-operator";
  let roles: readonly string[] = ["admin"];
  let identity: AdminIdentity | null = null;
  if (opts.allowUnauthenticated !== true) {
    if (!opts.authenticate) {
      deny(res, 401, "unauthorized: the remote control plane requires OAuth (RFC 9728) — no authenticator configured");
      return;
    }
    identity = await opts.authenticate(req).catch(() => null);
    if (!identity) {
      deny(res, 401, "unauthorized: missing or invalid bearer token");
      return;
    }
    if (opts.requiredRole && !identity.roles.includes(opts.requiredRole)) {
      deny(res, 403, `forbidden: role "${opts.requiredRole}" required`);
      return;
    }
    actor = `${identity.issuer}#${identity.subject}`;
    roles = identity.roles;
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

  if (identity?.issuer === SERVICE_TOKEN_ISSUER) {
    const rpc = (typeof body === "object" && body !== null ? body : {}) as { method?: unknown; params?: { name?: unknown } };
    await appendAudit({
      org: deploymentOrg(),
      platform: "control",
      workspace: "control",
      principalId: identity.subject,
      action: "control.service_call",
      detail: {
        service: identity.subject,
        ...(typeof rpc.method === "string" ? { method: rpc.method } : {}),
        ...(typeof rpc.params?.name === "string" ? { tool: rpc.params.name } : {}),
      },
    });
  }

  const server = buildControlServer({
    includeWrites: opts.includeWrites,
    actor,
    roles,
    readOnly: identity?.readOnly === true,
    ...(opts.readTranscript ? { readTranscript: opts.readTranscript } : {}),
  });
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
