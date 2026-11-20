import { defineTool, type ToolModelOutput } from "eve/tools";
import type { ApprovalContext, ApprovalPolicy } from "eve/tools/approval";
import type { ConnectionAuthResolver } from "eve/connections";
import type { SessionContext } from "eve/context";
import { fenceConnectorResult } from "../access/connector-result-fence.js";
import { outboundInputRefusal } from "../access/outbound-filter.js";
import { resolveConnectorReplay, settleConnectorReplay } from "../access/connector-replay-registry.js";
import { CONNECTOR_REPLAY_CARD_ID_PATTERN, CONNECTOR_REPLAY_INPUT_KEY, mentionsConnectorReplay } from "../approvals/connector-op-offer.js";
import { currentTestRun, noteTestRunBlocked } from "../access/test-run-state.js";
import { recordBlockedCall } from "../access/test-run-fence.js";
import { testRunBlockedMessage, testRunToolVerdict } from "../routines/test-run.js";
import { markConnectorAuthRequired } from "./auth-retry-memo.js";
import {
  callConnectorTool,
  isConnectorUnauthorizedError,
  type ConnectorClientDeps,
  type ListedConnectorTool,
} from "./connector-mcp-client.js";
import { connectorToolName, mountedConnectorToolName } from "./connector-tool-name.js";
import { connectorCatalogEntry, eveCanValidate, namesOnly, type ConnectorCatalogEntry } from "./connector-catalog-text.js";

/**
 * OE-owned connector tools for eve 1.x.
 *
 * eve's MCP connection runtime has no per-result transform, so a connector result that reaches
 * the model through `eve__tool` arrives unfenced. OE therefore offers each connector operation as
 * an authored `deferred: true` tool named `<connection>__<tool>`. The model finds it with
 * `eve__search` and calls it with `eve__tool`. eve resolves the entry and runs it as a direct
 * call, so the approval policy, `toModelOutput` and the hooks see the entry's own name. The
 * `toModelOutput` here applies the connector-result fence.
 *
 * The op's description and input schema are the server's text too, and `eve__search` shows them.
 * So the tool offers eve the host-built pair from `connector-catalog-text.ts`: a host-authored
 * description with the server's text inside the untrusted envelope, and the server's schema
 * reduced to its shape.
 *
 * Each tool is a plain `defineTool`, never a `defineWorkflowTool`. A workflow task whose result
 * arrives after its tool stops being offered skips `toModelOutput`, and the model then reads the
 * raw connector bytes.
 */

export { connectorToolName };

export interface ConnectorToolSource {
  readonly connection: string;
  readonly url: string;
  /** The connection's OE auth resolver (`connector-transport.ts`). Its `getToken` checks the grant and writes the `connector.use` row. */
  readonly auth: ConnectionAuthResolver;
  /** The per-op approval policy. Production passes `connectorApprovalPolicy()`. */
  readonly approval?: ApprovalPolicy;
  readonly client?: ConnectorClientDeps;
}

type ToolCtx = SessionContext & { readonly callId?: string; readonly abortSignal?: AbortSignal };

const APP_PRINCIPAL = { type: "app" } as const;

/**
 * The token for one call. OE asks its own provider on every call and never eve's token cache:
 * eve keys an app-principal token on the connection alone, across sessions, and OE's `getToken`
 * is where the per-surface grant check and its audit row run.
 */
/**
 * After a 401 the call asks the provider for a token a second time. It first calls the provider's
 * `evict` when the provider has one. OE's own providers (`connector-auth.ts`) define no `evict`
 * today, so for them the second request is a plain repeat: a user OAuth provider mints again, and
 * an API-key credential returns the same key, which the server refuses again.
 */
async function connectorToken(source: ConnectorToolSource, ctx: ToolCtx, refresh: boolean): Promise<string> {
  const provider = await source.auth(ctx);
  const opts = { principal: APP_PRINCIPAL, connection: { url: source.url } };
  if (refresh) {
    try {
      await provider.evict?.(opts);
    } catch {
    }
  }
  return (await provider.getToken(opts)).token;
}

/**
 * A failure on the wire (no answer, a refused connection, the deadline, an HTTP error) can carry
 * server bytes in its message, so the tool returns it for the fence to wrap. `transport: true`
 * tells the fence that no MCP result arrived, so the host fact must not say the call ran.
 */
function failedCall(err: unknown): { readonly isError: true; readonly transport: true; readonly error: string } {
  return { isError: true, transport: true, error: err instanceof Error ? err.message : String(err) };
}

async function runConnectorCall(
  source: ConnectorToolSource,
  listed: ListedConnectorTool,
  input: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<unknown> {
  const call = { tool: listed.name, arguments: input, hasOutputSchema: listed.hasOutputSchema };
  const endpoint = { connection: source.connection, url: source.url };
  let token = await connectorToken(source, ctx, false);
  try {
    return await callConnectorTool(endpoint, call, token, source.client, ctx.abortSignal);
  } catch (err) {
    if (!isConnectorUnauthorizedError(err)) return failedCall(err);
  }
  token = await connectorToken(source, ctx, true);
  try {
    return await callConnectorTool(endpoint, call, token, source.client, ctx.abortSignal);
  } catch (err) {
    if (!isConnectorUnauthorizedError(err)) return failedCall(err);
    markConnectorAuthRequired(source.connection);
    throw new Error(
      `connection "${source.connection}": the server refused a fresh token too (HTTP 401). The connector needs a new sign-in. ` +
        "Say that this action needs the connector to be signed in again, then stop.",
    );
  }
}

/**
 * The approval policy with the outbound filter in front of it. eve runs approval before
 * `execute`, and a carded op stores its input on the card. So a withheld or held input is refused
 * here, before any card exists. `execute` checks the input again, and checks an approved card's
 * stored input before it leaves.
 */
// approval-chain: exempt — a PASS-THROUGH guard. Its only own verdict is a DENY of a withheld or held
// input, and a deny never suspends a run. Every other call goes to the wrapped policy, which owns the
// attendedness question (connectorApprovalPolicy runs withUnattendedConnectorFence).
function outboundFirst(name: string, policy: ApprovalPolicy, opSchema: Record<string, unknown>): ApprovalPolicy {
  return async (ctx: ApprovalContext) => {
    if (mentionsConnectorReplay(ctx.toolInput)) return policy(ctx);
    const input = fillOpDefaults(opSchema, ctx.toolInput) as ApprovalContext["toolInput"];
    if (mentionsConnectorReplay(input)) return { type: "denied", reason: filledReplayRefusal(name) };
    const refusal = await outboundInputRefusal(name, input);
    if (refusal !== undefined) return { type: "denied", reason: refusal.message };
    return policy(input === ctx.toolInput ? ctx : { ...ctx, toolInput: input });
  };
}

/**
 * The call's input with the op's own `default`s filled in, by eve's own rule for a tool's root
 * schema (`eve/dist/src/tools/schema.js#applyDefaults`): each property that the input leaves out
 * takes its `default`, a `$ref` is followed to find one, and a present object or array is filled
 * the same way, one level at a time. The input itself is never changed: a filled input is a copy.
 *
 * eve fills no default into a connector op's input, because the op's schema sits in the first
 * branch of the wrapper (`connectorOpInputSchema`). So OE fills them, before the approval policy
 * and before `execute`. The approval card then stores and shows the input that the server gets.
 * A field that the server lists with a default, such as `dry_run: true`, reaches the server even
 * when the server does not apply its own default. Only a default that the reduction kept is
 * filled: a scalar short token (`connector-catalog-text.ts`). A replay input is never filled: it
 * holds the card id alone, and the card stores the filled input. The root `oe_approved_card` key
 * is never filled either, so a server's default never turns a plain call into a replay.
 */
export function fillOpDefaults(opSchema: Record<string, unknown>, input: unknown): unknown {
  return applyOpDefaults(opSchema, opSchema, input, 0);
}

/**
 * The refusal for a call that only a fill would turn into a replay. `fillOpDefaults` never fills
 * the root `oe_approved_card` key, so a server's default can never choose a card for a plain call.
 * This check holds that rule at both sites, the approval policy and `execute`.
 */
function filledReplayRefusal(name: string): string {
  return `The call to "${name}" was refused, because the op's own defaults would make it a replay of an approved card. Nothing ran.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The node that a local pointer names in `root`, or `undefined`. It reads own keys only. */
function localRefTarget(root: unknown, ref: unknown): unknown {
  if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) return undefined;
  let node: unknown = root;
  for (const raw of ref.split("/").slice(1)) {
    let seg = raw;
    try {
      seg = decodeURIComponent(raw);
    } catch {
    }
    seg = seg.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, seg)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** The node, then each node its `$ref` chain names, once each. */
function* refChain(root: unknown, node: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let at = node;
  while (isRecord(at) && !seen.has(at)) {
    seen.add(at);
    yield at;
    at = localRefTarget(root, at["$ref"]);
  }
}

/** The op's schemas nest at most this deep (the reduction's own cap is 32). A deeper value is left as it is. */
const DEFAULTS_DEPTH_MAX = 64;

function applyOpDefaults(root: unknown, node: unknown, value: unknown, depth: number): unknown {
  if (depth > DEFAULTS_DEPTH_MAX) return value;
  let out = value;
  for (const n of refChain(root, node)) {
    const props = n["properties"];
    const items = n["items"];
    if (isRecord(out) && isRecord(props)) out = fillProperties(root, props, out, depth);
    else if (Array.isArray(out) && isRecord(items)) {
      const before = out;
      const after = before.map((v) => applyOpDefaults(root, items, v, depth + 1));
      if (after.some((v, i) => v !== before[i])) out = after;
    }
  }
  return out;
}

function fillProperties(root: unknown, props: Record<string, unknown>, value: Record<string, unknown>, depth: number): Record<string, unknown> {
  let out = value;
  for (const [key, sub] of Object.entries(props)) {
    // A server's default for the root replay key would choose a card for a plain call.
    if (depth === 0 && key === CONNECTOR_REPLAY_INPUT_KEY) continue;
    const current = Object.hasOwn(value, key) ? value[key] : undefined;
    const next = current === undefined ? defaultOf(root, sub) : applyOpDefaults(root, sub, current, depth + 1);
    if (next === current) continue;
    if (out === value) out = { ...value };
    setOwn(out, key, next);
  }
  return out;
}

function defaultOf(root: unknown, node: unknown): unknown {
  for (const n of refChain(root, node)) if (Object.hasOwn(n, "default")) return structuredClone(n["default"]);
  return undefined;
}

/**
 * The root keys that stay at the wrapper's root. `$schema`, `$id` and `id` name the schema resource,
 * so a relative `$id` keeps its base. `$defs` and `definitions` hold no rule of their own, so the
 * replay form does not meet them, and a `#/$defs/...` pointer resolves from the root as before:
 * eve's signature renders such a field by its real shape.
 */
const ROOT_RESOURCE_KEYS = ["$schema", "$id", "id", "$defs", "definitions"] as const;

/** The keywords whose values are data, not schemas: a `$ref` text inside them is a literal. */
const LITERAL_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

/**
 * The keywords whose value is a map of NAMES to schemas. A name there is no keyword: a property
 * called `default` or a `$defs` entry called `enum` holds a schema, so its `$ref`s are rewritten too.
 */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

const OWN_BRANCH = "#/anyOf/0";

/** The pointer, moved into the op's own branch, unless it points into the definitions at the root. */
function intoOwnBranch(ref: string): string {
  if (ref === "#/$defs" || ref.startsWith("#/$defs/") || ref === "#/definitions" || ref.startsWith("#/definitions/")) return ref;
  return OWN_BRANCH + ref.slice(1);
}

/**
 * An own property, whatever the key. A plain assignment to `__proto__` sets the prototype instead,
 * and a server can list a `$defs` entry of that name (`connector-catalog-text.ts` keeps it as an own key).
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value });
}

/** Every local `$ref` in `node`, rewritten to point into the op's own branch: `#` → `#/anyOf/0`, `#/x` → `#/anyOf/0/x`. */
function refsIntoOwnBranch(node: unknown, map = false): unknown {
  if (Array.isArray(node)) return node.map((v) => refsIntoOwnBranch(v));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (map) setOwn(out, key, refsIntoOwnBranch(value));
    else if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) setOwn(out, key, intoOwnBranch(value));
    else if (LITERAL_KEYWORDS.has(key)) setOwn(out, key, value);
    else setOwn(out, key, refsIntoOwnBranch(value, SCHEMA_MAP_KEYWORDS.has(key)));
  }
  return out;
}

/**
 * The input schema eve checks for one connector op: the op's own (reduced) schema, OR the replay
 * form, an object whose ONLY key is `oe_approved_card` with a card id as its value.
 *
 * eve 1.x's `eve__tool` checks the call's `input` against the entry's schema before the approval
 * policy and `execute` run. The replay of an approved card (`connector-op-offer.ts#connectorReplayCall`)
 * sends the card id alone, so an op whose schema requires a field would refuse every replay. The
 * root `anyOf` accepts either form, and eve's signature shows both as a union.
 *
 * The op's own schema moves into the first branch. Its `$defs` and `definitions` stay at the root,
 * with their pointers as they were. Every other local `$ref` is rewritten to point into the first
 * branch (`#/properties/x` → `#/anyOf/0/properties/x`). So a normal call is checked by the same rules
 * and the same `$ref` targets as the op's own schema. eve's signature cannot follow a pointer through
 * `anyOf`, so it shows a field whose `$ref` points outside the definitions as `unknown`.
 *
 * The rewrite is exact only for a schema whose every `$ref` is a local pointer from the root that
 * resolves, with no `$id` below the root, no `$anchor`, and no `$recursiveRef` or `$dynamicRef`
 * (`connector-catalog-text.ts#eveCanValidate`). A `$ref` below an embedded `$id` resolves against
 * that id, so a rewrite to `#/anyOf/0/...` names nothing, and eve's validator then lets every call
 * through unchecked. A `$recursiveRef` or a `$dynamicRef` would resolve against the wrapper, which
 * holds the replay form. The reduction already turns such a schema into its property names alone
 * (`reduceInputSchema`). When the wrapper gets such a schema anyway, the first branch takes that
 * names-only form too. eve checks it, and it accepts every call, as eve does for the server's own schema.
 *
 * eve fills a `default` only from the root `properties`, and the root has none, so eve fills no
 * `default` into a connector op's input. OE fills the op's own defaults itself (`fillOpDefaults`).
 */
export function connectorOpInputSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (!eveCanValidate(inputSchema, { reduced: true })) return wrapOpSchema(namesOnly(inputSchema));
  return wrapOpSchema(inputSchema);
}

function wrapOpSchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const own: Record<string, unknown> = { ...inputSchema };
  for (const key of ROOT_RESOURCE_KEYS) {
    if (key in own) {
      root[key] = key === "$defs" || key === "definitions" ? refsIntoOwnBranch(own[key], true) : own[key];
      delete own[key];
    }
  }
  root["anyOf"] = [
    refsIntoOwnBranch(own),
    {
      type: "object",
      properties: {
        [CONNECTOR_REPLAY_INPUT_KEY]: {
          type: "string",
          pattern: CONNECTOR_REPLAY_CARD_ID_PATTERN,
          description: "Only to replay an approved card: the card id, as the input's only key.",
        },
      },
      required: [CONNECTOR_REPLAY_INPUT_KEY],
      additionalProperties: false,
    },
  ];
  return root;
}

function catalogEntryOf(source: ConnectorToolSource, listed: ListedConnectorTool): ConnectorCatalogEntry {
  return connectorCatalogEntry(source.connection, listed.name, listed.description, listed.inputSchema);
}

/**
 * One connector op as a deferred tool. `name` is the name eve mounts it under: the qualified
 * `<connection>__<tool>`, or its registered short name (`connector-tool-name.ts`). It throws for
 * an op whose input schema names a property that is not a short token: `connectorToolSet` leaves
 * that op out before it gets here.
 */
export function defineConnectorTool(
  source: ConnectorToolSource,
  listed: ListedConnectorTool,
  name: string = connectorToolName(source.connection, listed.name),
  catalog: ConnectorCatalogEntry = catalogEntryOf(source, listed),
) {
  if (!catalog.ok) throw new Error(`connector op "${connectorToolName(source.connection, listed.name)}": ${catalog.reason}`);
  const target = { connection: source.connection, tool: listed.name };
  return defineTool({
    deferred: true,
    description: catalog.description,
    inputSchema: connectorOpInputSchema(catalog.inputSchema) as Parameters<typeof defineTool<unknown>>[0]["inputSchema"],
    ...(source.approval === undefined ? {} : { approval: outboundFirst(name, source.approval, catalog.inputSchema) }),
    async execute(called: Record<string, unknown>, ctx) {
      const toolCtx = ctx as unknown as ToolCtx;
      const input = mentionsConnectorReplay(called) ? called : (fillOpDefaults(catalog.inputSchema, called) as Record<string, unknown>);
      if (input !== called && mentionsConnectorReplay(input)) throw new Error(filledReplayRefusal(name));
      const stamp = currentTestRun();
      if (stamp !== null && testRunToolVerdict(name, input) === "block") {
        noteTestRunBlocked();
        await recordBlockedCall(stamp, name, input);
        throw new Error(testRunBlockedMessage(name));
      }
      const refusal = await outboundInputRefusal(name, input);
      if (refusal !== undefined) throw refusal;
      if (!mentionsConnectorReplay(input)) return await runConnectorCall(source, listed, input, toolCtx);
      const replayed = { ...target, input };
      const stored = await resolveConnectorReplay(toolCtx.callId, replayed);
      try {
        const storedInput = stored["input"] as Record<string, unknown>;
        const storedRefusal = await outboundInputRefusal(name, storedInput);
        if (storedRefusal !== undefined) throw storedRefusal;
        return await runConnectorCall(source, listed, storedInput, toolCtx);
      } finally {
        await settleConnectorReplay(replayed);
      }
    },
    toModelOutput: async (output: unknown) => (await fenceConnectorResult({ toolName: name, output })) as ToolModelOutput,
  });
}

/**
 * One deferred tool per listed op, keyed `<connection>__<tool>`: the map a `defineDynamic` tool file
 * returns. eve refuses the whole map for one illegal key, so:
 *
 * - an op whose qualified name is longer than eve's 64-character limit is keyed by its stable short
 *   name (`connector-tool-name.ts#mountedConnectorToolName`), and every rule that keys on the
 *   qualified name resolves the short name back to it;
 * - an op whose name has a character eve refuses, or whose name another op of the map already
 *   holds, is left out with a warning, so it does not take every other op of the connection with it;
 * - an op whose input schema names a property or a `required` entry that is not a short token is
 *   left out with a warning too, because eve's signature or a validation error would show that
 *   name to the model outside the fence
 *   (`connector-catalog-text.ts`).
 */
export function connectorToolSet(source: ConnectorToolSource, listed: readonly ListedConnectorTool[]): Record<string, ReturnType<typeof defineConnectorTool>> {
  const out: Record<string, ReturnType<typeof defineConnectorTool>> = {};
  for (const tool of listed) {
    const qualified = connectorToolName(source.connection, tool.name);
    const mounted = mountedConnectorToolName(source.connection, tool.name);
    if (!mounted.ok || Object.hasOwn(out, mounted.name)) {
      const why = mounted.ok ? `another op of the connection already holds the name "${mounted.name}"` : mounted.reason;
      console.warn(`[open-everywhere:connector-tools] left out "${qualified}": ${why}`);
      continue;
    }
    const catalog = catalogEntryOf(source, tool);
    if (!catalog.ok) {
      console.warn(`[open-everywhere:connector-tools] left out "${qualified}": ${catalog.reason}`);
      continue;
    }
    out[mounted.name] = defineConnectorTool(source, tool, mounted.name, catalog);
  }
  return out;
}
