import type { HttpMethod } from "./bundle.js";

const METHOD_VOCABULARY: Record<HttpMethod, true> = {
  GET: true,
  HEAD: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

export const CREDENTIAL_HTTP_METHODS = Object.keys(METHOD_VOCABULARY) as readonly HttpMethod[];

export interface CredentialEndpointRules {
  readonly hosts: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly methods?: readonly HttpMethod[];
}

export class CredentialEndpointError extends Error {}

export interface CredentialEndpointVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

const ALLOWED = { allowed: true } as const;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function credentialEndpointProblems(rules: CredentialEndpointRules | undefined, where: string): readonly string[] {
  if (rules === undefined) return [];
  const bad: string[] = [];

  if (!Array.isArray(rules.hosts) || rules.hosts.length === 0) {
    bad.push(
      `${where}: endpoints.hosts must be a non-empty array — a credential rule that names no host blocks every request, which is a config error rather than a posture. Omit \`endpoints\` entirely to leave the credential unnarrowed.`,
    );
  } else {
    const seen = new Set<string>();
    for (const raw of rules.hosts) {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        bad.push(`${where}: endpoints.hosts contains a non-string or empty entry — each entry is one exact hostname`);
        continue;
      }
      const host = normalizeHost(raw);
      if (host.includes("*")) {
        bad.push(
          `${where}: endpoints.hosts entry "${raw}" contains a wildcard — hosts are NEVER wildcardable. Name each host you need: a subdomain wildcard admits every name a vendor (or whoever registers one under it) serves.`,
        );
      }
      if (host.includes("/") || host.includes(":") || /\s/.test(host)) {
        bad.push(
          `${where}: endpoints.hosts entry "${raw}" is not a bare hostname — write "api.vendor.com", not a URL, a scheme, or a host:port (ports are not part of the fence).`,
        );
      }
      if (seen.has(host)) bad.push(`${where}: endpoints.hosts lists "${host}" more than once`);
      seen.add(host);
    }
  }

  if (rules.pathPrefixes !== undefined) {
    if (!Array.isArray(rules.pathPrefixes) || rules.pathPrefixes.length === 0) {
      bad.push(
        `${where}: endpoints.pathPrefixes must be a non-empty array when present — omit the field to admit every path`,
      );
    } else {
      for (const p of rules.pathPrefixes) {
        if (typeof p !== "string" || !p.startsWith("/")) {
          bad.push(`${where}: endpoints.pathPrefixes entry ${JSON.stringify(p)} must be a string starting with "/"`);
        } else if (p.includes("*")) {
          bad.push(
            `${where}: endpoints.pathPrefixes entry "${p}" contains a wildcard — a prefix already matches everything below it, so "*" only makes the rule read wider than it is`,
          );
        }
      }
    }
  }

  if (rules.methods !== undefined) {
    if (!Array.isArray(rules.methods) || rules.methods.length === 0) {
      bad.push(
        `${where}: endpoints.methods must be a non-empty array when present — omit the field to admit every method`,
      );
    } else {
      for (const m of rules.methods) {
        if (!(CREDENTIAL_HTTP_METHODS as readonly string[]).includes(m)) {
          bad.push(
            `${where}: endpoints.methods entry ${JSON.stringify(m)} is not an HTTP method — the vocabulary is ${CREDENTIAL_HTTP_METHODS.join(", ")}`,
          );
        }
      }
    }
  }

  return bad;
}

function pathEscapesPrefix(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.split("/").includes("..");
}

export function credentialEndpointVerdict(
  rules: CredentialEndpointRules | undefined,
  url: string,
  method: string = "GET",
): CredentialEndpointVerdict {
  if (rules === undefined) return ALLOWED;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `refusing to attach a scoped credential to an unparseable URL` };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      allowed: false,
      reason: `refusing to attach a scoped credential to a "${parsed.protocol}" URL — endpoint rules govern http(s) requests only`,
    };
  }

  const host = normalizeHost(parsed.hostname);
  const allowedHosts = rules.hosts.map(normalizeHost);
  if (!allowedHosts.includes(host)) {
    return {
      allowed: false,
      reason:
        `host "${host}" is not in this credential's allowed hosts (${allowedHosts.join(", ")}) — ` +
        `hosts match exactly, with no subdomain or wildcard widening`,
    };
  }

  const requestMethod = method.toUpperCase();
  if (rules.methods !== undefined && !(rules.methods as readonly string[]).includes(requestMethod)) {
    return {
      allowed: false,
      reason: `method ${requestMethod} is not in this credential's allowed methods (${rules.methods.join(", ")})`,
    };
  }

  if (rules.pathPrefixes !== undefined) {
    const path = parsed.pathname;
    if (pathEscapesPrefix(path)) {
      return {
        allowed: false,
        reason: `path "${path}" contains an encoded parent-directory segment — refusing a path that decodes outside the prefix it matches`,
      };
    }
    if (!rules.pathPrefixes.some((p) => path.startsWith(p))) {
      return {
        allowed: false,
        reason: `path "${path}" does not start with any of this credential's allowed prefixes (${rules.pathPrefixes.join(", ")})`,
      };
    }
  }

  return ALLOWED;
}

export function credentialEndpointHostVerdict(
  rules: CredentialEndpointRules | undefined,
  url: string,
): CredentialEndpointVerdict {
  if (rules === undefined) return ALLOWED;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `refusing to bind a scoped credential to an unparseable URL` };
  }

  const host = normalizeHost(parsed.hostname);
  const allowedHosts = rules.hosts.map(normalizeHost);
  if (!allowedHosts.includes(host)) {
    return {
      allowed: false,
      reason:
        `host "${host}" is not in this credential's allowed hosts (${allowedHosts.join(", ")}) — ` +
        `hosts match exactly, with no subdomain or wildcard widening`,
    };
  }

  return ALLOWED;
}

export function assertCredentialEndpointHostAllowed(rules: CredentialEndpointRules | undefined, url: string, where: string): void {
  const verdict = credentialEndpointHostVerdict(rules, url);
  if (verdict.allowed) return;
  throw new CredentialEndpointError(
    `${where}: BLOCKED MCP transport to ${url} — ${verdict.reason}. ` +
      `The credential was NOT returned. This is the connector plane's boot-time transport check ` +
      `(access/credential-endpoints.ts), so it blocks a wrong-credential/wrong-connection bug before ` +
      `eve's MCP client ever dials out. Correct the connection's directUrl, or widen the credential's ` +
      `\`endpoints.hosts\` in agent/access/connector-credentials.ts.`,
  );
}

export function assertCredentialEndpointAllowed(
  rules: CredentialEndpointRules | undefined,
  url: string,
  method: string,
  where: string,
): void {
  const verdict = credentialEndpointVerdict(rules, url, method);
  if (verdict.allowed) return;
  let target = "(unparseable URL)";
  try {
    const parsed = new URL(url);
    target = `${parsed.origin}${parsed.pathname}`;
  } catch {
  }
  throw new CredentialEndpointError(
    `${where}: BLOCKED ${method.toUpperCase()} ${target} — ${verdict.reason}. ` +
      `The credential was NOT attached. This is an endpoint rule on the credential itself ` +
      `(access/credential-endpoints.ts), so it blocks a wrong-credential bug in the calling code rather ` +
      `than a network policy. Correct the call, or widen the credential's \`endpoints\` in agent/access/connector-credentials.ts.`,
  );
}

export type GuardableFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function guardCredentialFetch(
  rules: CredentialEndpointRules | undefined,
  where: string,
  base: GuardableFetch,
): GuardableFetch {
  if (rules === undefined) return base;
  return async (input, init) => {
    assertCredentialEndpointAllowed(rules, input, init?.method ?? "GET", where);
    return base(input, init);
  };
}
