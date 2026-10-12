export function subjectLabel(subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" }): string {
  return subject.type === "app" ? "app" : `user:${subject.id}`;
}

export class OeOauthNeedsConsentError extends Error {
  readonly code = "oe_oauth_needs_consent";
  constructor(providerRef: string, subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" }) {
    super(`connection "${providerRef}": ${subjectLabel(subject)} has not authorized this account — user authorization required.`);
    this.name = "OeOauthNeedsConsentError";
  }
}

export class OeOauthNeedsReconsentError extends Error {
  readonly code = "oe_oauth_needs_reconsent";
  constructor(providerRef: string, subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" }, why: string) {
    super(`connection "${providerRef}": ${subjectLabel(subject)} must re-authorize — ${why}.`);
    this.name = "OeOauthNeedsReconsentError";
  }
}

export class OeOauthRefreshContendedError extends Error {
  readonly code = "oe_oauth_refresh_contended";
  constructor(providerRef: string, subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" }) {
    super(`connection "${providerRef}": ${subjectLabel(subject)} token refresh is in progress on another instance and did not complete in time — retry.`);
    this.name = "OeOauthRefreshContendedError";
  }
}

export class OeOauthAccessRemovedError extends Error {
  readonly code = "oe_oauth_access_removed";
  readonly oauthError?: string;
  constructor(providerRef: string, subject: { readonly type: "user"; readonly id: string } | { readonly type: "app" }, where: "idp" | "app", oauthError?: string) {
    super(
      `connection "${providerRef}": ${subjectLabel(subject)} — the ${where === "idp" ? "identity provider" : "app"} refused access` +
        `${oauthError ? ` (${oauthError})` : ""}. Your identity-provider admin manages this access; a new sign-in will not restore it.`,
    );
    this.name = "OeOauthAccessRemovedError";
    if (oauthError) this.oauthError = oauthError;
  }
}

export class OeOauthError extends Error {
  readonly code = "oe_oauth_error";
  readonly oauthError?: string;
  readonly httpStatus?: number;
  constructor(message: string, opts: { readonly oauthError?: string; readonly httpStatus?: number } = {}) {
    super(message);
    this.name = "OeOauthError";
    if (opts.oauthError) this.oauthError = opts.oauthError;
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
  }
}

export function isInvalidGrant(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const oauthError = (e as { oauthError?: unknown }).oauthError;
  return typeof oauthError === "string" && oauthError.toLowerCase() === "invalid_grant";
}

export function isUserAuthRequiredError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return (
    (typeof code === "string" && (code === "oe_oauth_needs_consent" || code === "oe_oauth_needs_reconsent")) ||
    e.name === "OeOauthNeedsConsentError" ||
    e.name === "OeOauthNeedsReconsentError" ||
    /user[_ ]?authorization[_ ]?required/i.test(e.message)
  );
}
