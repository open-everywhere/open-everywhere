import { defineDynamic, defineTool, type DynamicToolResult } from "eve/tools";
import type { ApprovalPolicy } from "eve/tools/approval";
import type { ConnectionAuthResolver } from "eve/connections";
import type { SessionContext } from "eve/context";
import { connectorApprovalPolicy } from "./connector-auth.js";
import { recordConnectorListing, registerMountedConnector } from "./connector-catalogue.js";
import {
  isConnectorUnauthorizedError,
  listConnectorTools,
  type ConnectorClientDeps,
  type ListedConnectorTool,
} from "./connector-mcp-client.js";
import { connectorToolName } from "./connector-tool-name.js";
import { isConnectorSignInRequiredError, listingTokenRequest } from "./connector-listing.js";
import { connectorToolSet } from "./connector-tools.js";

/**
 * The OE connector mount: one connection, offered to the model as OE's own deferred connector
 * tools (`connector-tools.ts`), whose `toModelOutput` applies the connector-result fence.
 *
 * eve 1.x's MCP connection runtime has no per-result transform, so a connection mounted with
 * `defineMcpClientConnection` hands connector bytes to the model unfenced. This mount replaces
 * it. It is a `defineDynamic` tool file: before each model call it lists the connection's ops
 * with OE's own MCP client and returns `connectorToolSet`, keyed `<connection>__<tool>`. The
 * roster shim passes it through `seatCut`, so every seat cut applies to each op by name.
 *
 * - **The eve connection must go.** eve refuses a dynamic tool whose name starts with
 *   `<connection>__` while a connection of that name is mounted
 *   (`connections/ownership.js#assertNotConnectionOwned`). So a connection is either an eve
 *   connection or an OE connector mount, never both.
 * - **The listing is memoised** per session and principal: the dynamic resolver runs before
 *   every model call, and one MCP round trip per call costs too much. An anonymous listing, a
 *   listing that needs sign-in, and a listing that the gate refuses are memoised for the turn only,
 *   so the next turn lists again (for example, after a sign-in). A listing that fails for another
 *   reason is not memoised.
 * - **The listing is a probe.** It asks the connection's OE auth resolver for a token with a
 *   listing marker (`connector-listing.ts`). The resolver then starts no sign-in and writes no
 *   audit row, because no op runs. A missing sign-in (`ConnectorSignInRequiredError`) makes the
 *   listing go anonymous, as eve's runtime goes anonymous only on its own authorization-required
 *   error. Any other refusal (a halt, an ungranted surface, the DM-only rule, the personal-surface
 *   fence) offers no op and sends nothing to the server. The evidence of an attempt on an ungranted
 *   connection comes from the catalogue tools instead (`hooks/connector-audit.ts`, `call.requested`).
 * - **A listing that needs sign-in.** When the server refuses the anonymous listing (HTTP 401), the
 *   mount offers one deferred tool, `<connection>__sign_in`. Its call asks the resolver for a token
 *   without the marker: OE's resolver runs the sign-in card and returns the host-authored message.
 * - **The annotations.** Each good listing goes to the connector catalogue
 *   (`connector-catalogue.ts`), so the connector-op hints lookup reads the listed `annotations`.
 */

export interface ConnectorMountSpec {
  readonly connection: string;
  readonly url: string;
  /** The connection's own description. The `<connection>__sign_in` tool shows it. */
  readonly description?: string;
  /** The connection's OE auth resolver (`connector-transport.ts`). */
  readonly auth: ConnectionAuthResolver;
  /**
   * A refusal the listing checks first, with no audit row (for example the personal-surface fence).
   * A string refuses the listing: no op is offered and nothing reaches the server.
   */
  readonly listingRefusal?: (ctx: SessionContext) => Promise<string | undefined>;
  /** The per-op approval policy. Defaults to `connectorApprovalPolicy()`. */
  readonly approval?: ApprovalPolicy;
  readonly client?: ConnectorClientDeps;
}

const APP_PRINCIPAL = { type: "app" } as const;

const SIGN_IN_OP = "sign_in";

const MAX_MEMOISED_LISTINGS = 1024;

type MountCtx = SessionContext & { readonly abortSignal?: AbortSignal };

interface AuthPrincipal {
  readonly authenticator?: unknown;
  readonly principalType?: unknown;
  readonly principalId?: unknown;
}

/** The memo key: the session, then the principal the session acts for now. */
export function listingMemoKey(ctx: unknown): string | undefined {
  const session = (ctx as { session?: { id?: unknown; auth?: { current?: AuthPrincipal | null; initiator?: AuthPrincipal | null } | null } } | undefined)?.session;
  if (typeof session?.id !== "string" || session.id.length === 0) return undefined;
  const who = session.auth?.current ?? session.auth?.initiator ?? null;
  return JSON.stringify([session.id, who?.authenticator ?? null, who?.principalType ?? null, who?.principalId ?? null]);
}

type ListingToken = { readonly kind: "token"; readonly token: string | undefined } | { readonly kind: "refused" };

async function listingToken(spec: ConnectorMountSpec, ctx: MountCtx): Promise<ListingToken> {
  try {
    if (spec.listingRefusal !== undefined && (await spec.listingRefusal(ctx)) !== undefined) return { kind: "refused" };
    const provider = await spec.auth(ctx);
    const opts = listingTokenRequest({ principal: APP_PRINCIPAL, connection: { url: spec.url } });
    return { kind: "token", token: (await provider.getToken(opts)).token };
  } catch (err) {
    return isConnectorSignInRequiredError(err) ? { kind: "token", token: undefined } : { kind: "refused" };
  }
}

/**
 * The turn's id. eve gives a dynamic value and a hook the session frame, whose turn is `ctx.turn`
 * (`null` before the first turn). eve gives a tool's `execute` the session context, whose turn is
 * `ctx.session.turn`. The mount reads both: the listing runs in the frame, and the sign-in tool's
 * `forgetTurn` runs in a tool call.
 */
function turnIdOf(ctx: unknown): unknown {
  const c = ctx as { turn?: { id?: unknown } | null; session?: { turn?: { id?: unknown } } } | undefined;
  return c?.turn?.id ?? c?.session?.turn?.id;
}

function turnKeyOf(key: string | undefined, ctx: unknown): string | undefined {
  const turn = turnIdOf(ctx);
  return key === undefined || typeof turn !== "string" || turn.length === 0 ? undefined : `${key}\0${turn}`;
}

/**
 * The one tool a connection offers while its listing needs sign-in. Its output is host-authored
 * (no connector bytes), so it carries no fence.
 */
function connectorSignInTool(spec: ConnectorMountSpec, signedIn: (ctx: unknown) => void) {
  const name = connectorToolName(spec.connection, SIGN_IN_OP);
  return {
    [name]: defineTool({
      deferred: true,
      description:
        (spec.description === undefined ? "" : `${spec.description}\n\n`) +
        `The ${spec.connection} connection needs sign-in before it lists its operations. ` +
        "Call this when the user asks for something on this connection. It starts the sign-in, or reports that the connection is signed in now.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as Parameters<typeof defineTool<unknown>>[0]["inputSchema"],
      async execute(_input: unknown, ctx) {
        const provider = await spec.auth(ctx as unknown as SessionContext);
        await provider.getToken({ principal: APP_PRINCIPAL, connection: { url: spec.url } });
        signedIn(ctx);
        return {
          signedIn: true,
          note: `The ${spec.connection} connection is signed in. Its operations are offered from the next step: find them with eve__search.`,
        };
      },
    }),
  };
}

type Listing =
  | { readonly kind: "listed"; readonly listed: readonly ListedConnectorTool[] }
  | { readonly kind: "sign-in" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed" };

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= MAX_MEMOISED_LISTINGS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function defineConnectorMount(spec: ConnectorMountSpec) {
  const source = {
    connection: spec.connection,
    url: spec.url,
    auth: spec.auth,
    approval: spec.approval ?? connectorApprovalPolicy(),
    ...(spec.client === undefined ? {} : { client: spec.client }),
  };
  const memo = new Map<string, readonly ListedConnectorTool[]>();
  const turnMemo = new Map<string, "sign-in" | "refused">();
  const anonymousTurnMemo = new Map<string, readonly ListedConnectorTool[]>();
  const list = async (rawCtx: unknown): Promise<Listing> => {
    const ctx = rawCtx as MountCtx;
    const key = listingMemoKey(ctx);
    const known = key === undefined ? undefined : memo.get(key);
    if (known !== undefined) return { kind: "listed", listed: known };
    const turnKey = turnKeyOf(key, ctx);
    const thisTurn = turnKey === undefined ? undefined : turnMemo.get(turnKey);
    if (thisTurn !== undefined) return { kind: thisTurn };
    const anonymous = turnKey === undefined ? undefined : anonymousTurnMemo.get(turnKey);
    if (anonymous !== undefined) return { kind: "listed", listed: anonymous };
    const settle = (kind: "sign-in" | "refused"): Listing => {
      if (turnKey !== undefined) bounded(turnMemo, turnKey, kind);
      return { kind };
    };
    const token = await listingToken(spec, ctx);
    if (token.kind === "refused") return settle("refused");
    const endpoint = { connection: spec.connection, url: spec.url };
    let listed: readonly ListedConnectorTool[];
    try {
      listed = await listConnectorTools(endpoint, token.token, spec.client, ctx.abortSignal);
    } catch (err) {
      if (isConnectorUnauthorizedError(err)) return settle("sign-in");
      console.warn(
        `[open-everywhere:connector-mount] connection "${spec.connection}": the listing failed, so no op is offered this step: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "failed" };
    }
    // An anonymous listing (no sign-in yet) holds for the turn only: after a sign-in, the next
    // turn lists again with the token and sees the ops that need it.
    if (token.token === undefined) {
      if (turnKey !== undefined) bounded(anonymousTurnMemo, turnKey, listed);
    } else if (key !== undefined) bounded(memo, key, listed);
    recordConnectorListing(spec.connection, listed);
    return { kind: "listed", listed };
  };
  const forgetTurn = (ctx: unknown): void => {
    const turnKey = turnKeyOf(listingMemoKey(ctx), ctx);
    if (turnKey !== undefined) {
      turnMemo.delete(turnKey);
      anonymousTurnMemo.delete(turnKey);
    }
  };
  registerMountedConnector(spec.connection, async (ctx) => {
    const listing = await list(ctx);
    return listing.kind === "listed" ? listing.listed : undefined;
  });
  return defineDynamic(async (ctx) => {
    const listing = await list(ctx);
    if (listing.kind === "sign-in") return connectorSignInTool(spec, forgetTurn) as unknown as DynamicToolResult;
    if (listing.kind === "failed" || listing.kind === "refused") return null;
    return connectorToolSet(source, listing.listed) as unknown as DynamicToolResult;
  });
}
