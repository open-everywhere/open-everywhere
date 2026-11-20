import { createHash } from "node:crypto";
import { OE_ADDRESSING_ATTR, OE_DELIVERY_ID_ATTR, OE_REPLY_ANCHOR_ATTR, OE_WAKE_ID_ATTR } from "./unified-window.js";

// The framework lets a delivery of the SAME principal join a running turn (a turn held on a person,
// a `steer` window, and a message that answers a delegated child's question), and the joining
// delivery's auth then replaces the turn's attribute bag. It also folds queued deliveries of one
// principal into one turn, which then runs with the latest bag. The principal is
// [authenticator, issuer, principalType, principalId]; the bag is not part of it.
//
// This fence makes the bag part of the principal for a seat window. It writes a digest of every
// attribute that is not a per-wake stamp into `issuer`, so a delivery whose authority attributes
// differ from the running turn's is a different principal. The framework's own gate then holds it
// for a turn of its own, where it runs with its own bag. A delivery that differs only in its
// per-wake stamps still joins, and its stamps replace the earlier ones, as they should.
//
// The wake id is a per-wake stamp, but it is also a key: `work`, `cancel_work`, the task wake and
// the approval decision resolve the wake's AUTHORITY row (the requester verdict, the non-member mark
// and the binding) from it. The receive writes that row per wake, and a worker's requester can come
// from the message envelope. So the digest also folds the wake's resolved authority: a delivery whose
// row differs is another principal even when its bag is the same. An attribute that is present but
// undefined hashes apart from an absent one.
//
// The cost: most surfaces stamp a per-message id into the bag (Slack `working_signs_ts`, Discord
// `message_id`, Google Chat `gchat_message`, email `email_message_id`, Linear and Notion
// `comment_id`). So on those surfaces a person's later message is another principal too: it neither
// joins a parked seat turn nor folds into one turn with the earlier message. It waits and runs as a
// turn of its own.
//
// Who reads `issuer`: no OE production code. The framework reads it in the principal tuple; in
// connection principal resolution only for a principal of type `user`, which no window delivery has;
// in the approval requester check, which a window never reaches (the unified channel has no answer
// road); and in derived keys — the tool-session id, the model-provider safety identifier and the
// principal a child inherits — which now change with the bag digest and grant nothing.

export const TURN_JOIN_ISSUER_PREFIX = "oe-join:";

// The per-wake stamps: each names the delivery that carries it, never the turn's authority. A join
// replaces them, and the reply of the joining delivery needs its own. Any other attribute is
// authority, so an attribute that this list does not name blocks a join (fail-closed).
export const TURN_JOIN_PER_WAKE_ATTRS: ReadonlySet<string> = new Set([OE_WAKE_ID_ATTR, OE_DELIVERY_ID_ATTR, OE_REPLY_ANCHOR_ATTR, OE_ADDRESSING_ATTR]);

interface JoinableAuth {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly authenticator?: string;
  readonly issuer?: string;
  readonly principalId?: string;
  readonly principalType?: string;
}

const EXPLICIT_UNDEFINED = "\u0000oe-join:undefined";

function canonical(value: unknown): unknown {
  if (value === undefined) return EXPLICIT_UNDEFINED;
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function turnJoinIssuer(auth: JoinableAuth, wakeAuthority?: unknown): string {
  const authority: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(auth.attributes ?? {})) {
    if (!TURN_JOIN_PER_WAKE_ATTRS.has(key)) authority[key] = value;
  }
  const original = auth.issuer !== undefined && auth.issuer.startsWith(TURN_JOIN_ISSUER_PREFIX) ? undefined : auth.issuer;
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical({ attributes: authority, wakeAuthority: wakeAuthority ?? null, authenticator: auth.authenticator ?? null, issuer: original ?? null, principalId: auth.principalId ?? null, principalType: auth.principalType ?? null })))
    .digest("hex")
    .slice(0, 32);
  return `${TURN_JOIN_ISSUER_PREFIX}${digest}`;
}

export function fenceTurnJoin<A extends JoinableAuth | null>(auth: A, wakeAuthority?: unknown): A {
  if (auth === null) return auth;
  return { ...auth, issuer: turnJoinIssuer(auth, wakeAuthority) } as A;
}
