/**
 * The token request that a connector mount makes to LIST a connection's ops
 * (`connector-mount.ts`), as distinct from the request that a connector tool makes to CALL one.
 *
 * A listing runs before a model call, for every mounted connection, whether or not the turn uses
 * it. So OE's auth resolvers (`connector-auth.ts`) treat a listing request as a probe:
 *
 * - it starts no sign-in: no authorization URL, no sign-in card, no consent carriage, and no
 *   "auth required this turn" mark;
 * - it writes no audit row: no `connector.use` (no op ran), no `connector.refused`, and no mint row;
 * - a missing sign-in throws `ConnectorSignInRequiredError`, and any other refusal (a halt, an
 *   ungranted surface, the DM-only rule, the personal-surface fence) throws as before.
 *
 * The mount lists anonymously only after a `ConnectorSignInRequiredError`, as eve's runtime goes
 * anonymous only on its own authorization-required error. On any other refusal it offers no op and
 * sends nothing to the server.
 */

const LISTING = Symbol.for("open-everywhere.connector-listing");

/** Mark a `getToken` options object as a listing probe. */
export function listingTokenRequest<T extends object>(opts: T): T {
  return Object.assign({}, opts, { [LISTING]: true });
}

/** True when a `getToken` options object came from a connector mount's listing. */
export function isListingTokenRequest(opts: unknown): boolean {
  return opts !== null && typeof opts === "object" && (opts as Record<symbol, unknown>)[LISTING] === true;
}

export class ConnectorSignInRequiredError extends Error {
  constructor(connection: string) {
    super(`connection "${connection}": no sign-in is available for this principal, so the listing goes anonymous.`);
    this.name = "ConnectorSignInRequiredError";
  }
}

export function isConnectorSignInRequiredError(err: unknown): err is ConnectorSignInRequiredError {
  return err instanceof Error && err.name === "ConnectorSignInRequiredError";
}
