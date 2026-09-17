import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { findConnectorCredential, vercelConnectorOf } from "../access/connector-credentials.js";
import { assertCredentialEndpointHostAllowed } from "../access/credential-endpoints.js";
import { CREDENTIAL_GRANT_ROLES } from "../access/credential-grant.js";
import { fenceMcpBorrowFetch } from "../access/mcp-call-fence.js";
import { withRetryAfter, type RetryPolicy } from "../channels/rate-limit-retry.js";
import type { GrantJsonObject } from "../operational/credential-grant-rows.js";
import { connectorTransportSpec, type ConnectorTransportSpec } from "./connector-transport.js";
import { requireUserAuthFlow, userAuthFlowProvider, type UserAuthSubject } from "./user-auth-flow.js";

export const BORROW_APPROVE_READ_BUDGET_MS = 5_000;

export interface BorrowDeadline {
  remainingMs(): number;
  markSpent(): void;
}

export function borrowDeadline(budgetMs: number = BORROW_APPROVE_READ_BUDGET_MS, nowMs: number = Date.now()): BorrowDeadline {
  const endsAt = nowMs + budgetMs;
  let spent = false;
  return {
    remainingMs: () => (spent ? 0 : Math.max(0, endsAt - Date.now())),
    markSpent: () => {
      spent = true;
    },
  };
}

export async function withinBorrowDeadline<T>(deadline: BorrowDeadline, what: string, leg: () => Promise<T>): Promise<T> {
  const left = deadline.remainingMs();
  if (left <= 0) throw new Error(`granted call: the approve-time budget was spent before ${what} could run (connections/grant-mcp-borrow.ts).`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      leg(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadline.markSpent();
          reject(new Error(`granted call: ${what} did not answer within the approve-time budget (connections/grant-mcp-borrow.ts).`));
        }, left);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const BORROW_CLIENT_INFO = { name: "open-everywhere-grant-borrow", version: "1.0.0" } as const;

export interface GrantBorrowDeps {
  readonly connectorSpec?: (connector: string) => ConnectorTransportSpec | undefined;
  readonly mintOwnerToken?: (provider: string, providerRef: string, vaultSubject: string) => Promise<string>;
  readonly fetch?: FetchLike;
  readonly retry?: RetryPolicy;
}

export interface BorrowConnection {
  readonly connector: string;
  readonly directUrl: string;
  readonly url: URL;
  readonly provider: string;
  readonly providerRef: string;
}

function grantRoleCredential(connector: string): string | undefined {
  return CREDENTIAL_GRANT_ROLES.find((r) => r.connector === connector)?.role;
}

export function resolveBorrowConnection(connector: string, deps: GrantBorrowDeps = {}): BorrowConnection {
  const spec = (deps.connectorSpec ?? connectorTransportSpec)(connector);
  if (spec === undefined) {
    throw new Error(
      `granted call: this deployment carries no "${connector}" connection, so there is no MCP server to borrow the ` +
        "tool from (connections/grant-mcp-borrow.ts).",
    );
  }
  let url: URL;
  try {
    url = new URL(spec.directUrl);
  } catch {
    throw new Error(`granted call: the "${connector}" connection's URL does not parse, so the borrow cannot be dialled (connections/grant-mcp-borrow.ts).`);
  }
  const provider = spec.provider ?? connector;
  const credentialId = grantRoleCredential(connector);
  if (credentialId === undefined) {
    throw new Error(
      `granted call: "${connector}" is not in CREDENTIAL_GRANT_ROLES, so no personal credential is admitted for it ` +
        "(access/credential-grant.ts).",
    );
  }
  const cred = findConnectorCredential(provider, credentialId);
  if (cred === undefined) {
    throw new Error(
      `granted call: this deployment configures no "${credentialId}" ${provider} credential, so there is no per-user ` +
        "credential to spend. Declare one in agent/access/connector-credentials.ts (connections/grant-mcp-borrow.ts).",
    );
  }
  const providerRef = vercelConnectorOf(cred);
  if (providerRef === undefined) {
    throw new Error(
      `granted call: the "${credentialId}" ${provider} credential declares no OAuth home, so no per-user token can be ` +
        "minted from it (connections/grant-mcp-borrow.ts).",
    );
  }
  assertCredentialEndpointHostAllowed(cred.endpoints, spec.directUrl, `granted ${provider} credential "${credentialId}"`);
  return { connector, directUrl: spec.directUrl, provider, providerRef, url };
}

export async function mintBorrowToken(conn: BorrowConnection, vaultSubject: string, deps: GrantBorrowDeps = {}): Promise<string> {
  const mint =
    deps.mintOwnerToken ??
    (async (label: string, ref: string, subject: string): Promise<string> =>
      (await requireUserAuthFlow(label).mintUserToken(ref, { subject: { id: subject, type: "user" } })).token);
  return await mint(conn.provider, conn.providerRef, vaultSubject);
}

export function grantBorrowFetch(row: { readonly mcpTool?: string; readonly frozenArgs?: GrantJsonObject }, directUrl: string, base: FetchLike): FetchLike {
  const url = new URL(directUrl);
  return fenceMcpBorrowFetch({ frozenArgs: row.frozenArgs ?? {}, host: url.host, tool: row.mcpTool ?? "" }, base);
}

export function borrowRetryFetch(connector: string, base: FetchLike, deps: GrantBorrowDeps = {}, deadline?: BorrowDeadline): FetchLike {
  return (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "DELETE") return base(url, init);
    const budget = deadline?.remainingMs();
    return withRetryAfter(async () => await base(url, init), {
      surface: "grant-borrow",
      operation: `POST /mcp (${connector})`,
      ...deps.retry,
      ...(budget === undefined ? {} : { totalBudgetMs: budget }),
    });
  };
}

export async function withBorrowClient<T>(
  conn: BorrowConnection,
  pin: { readonly mcpTool: string; readonly frozenArgs?: GrantJsonObject },
  token: string,
  deps: GrantBorrowDeps,
  body: (client: Client) => Promise<T>,
  deadline?: BorrowDeadline,
): Promise<T> {
  const base = borrowRetryFetch(conn.connector, deps.fetch ?? (globalThis.fetch as FetchLike), deps, deadline);
  const fenced = grantBorrowFetch(pin, conn.directUrl, base);
  const transport = new StreamableHTTPClientTransport(conn.url, {
    fetch: fenced,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client(BORROW_CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, deadline === undefined ? undefined : { timeout: deadline.remainingMs() });
    return await body(client);
  } finally {
    try {
      await transport.terminateSession();
    } catch {
    }
    try {
      await client.close();
    } catch {
    }
  }
}

export type BorrowCatalogueEntry =
  | { readonly found: true; readonly inputSchema: GrantJsonObject }
  | { readonly found: false; readonly published: readonly string[] };

export async function readBorrowToolSchema(
  conn: BorrowConnection,
  mcpTool: string,
  frozenArgs: GrantJsonObject,
  token: string,
  deps: GrantBorrowDeps = {},
  deadline: BorrowDeadline = borrowDeadline(),
): Promise<BorrowCatalogueEntry> {
  return await withBorrowClient(
    conn,
    { frozenArgs, mcpTool },
    token,
    deps,
    async (client) => {
      const listed = await client.listTools(undefined, { timeout: deadline.remainingMs() });
      const published: string[] = [];
      let schema: GrantJsonObject | undefined;
      for (const tool of listed.tools) {
        published.push(tool.name);
        if (tool.name !== mcpTool) continue;
        const declared: unknown = tool.inputSchema;
        if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) schema = declared as GrantJsonObject;
      }
      return schema === undefined ? { found: false, published: published.sort() } : { found: true, inputSchema: schema };
    },
    deadline,
  );
}

export async function ownerHasConnectorConsent(conn: BorrowConnection, vaultSubject: string): Promise<boolean | undefined> {
  const flow = userAuthFlowProvider();
  const probe = flow?.hasFreshGrant;
  if (flow === undefined || probe === undefined) return undefined;
  try {
    return await probe.call(flow, conn.providerRef, ownerSubject(vaultSubject));
  } catch {
    return undefined;
  }
}

export async function startOwnerConnectorAuthorization(conn: BorrowConnection, vaultSubject: string, expiresInMs: number): Promise<string> {
  const flow = requireUserAuthFlow(conn.connector);
  const { url } = await flow.startAuthorization(conn.providerRef, { subject: ownerSubject(vaultSubject) }, { expiresInMs });
  return url;
}

function ownerSubject(vaultSubject: string): UserAuthSubject {
  return { id: vaultSubject, type: "user" };
}
