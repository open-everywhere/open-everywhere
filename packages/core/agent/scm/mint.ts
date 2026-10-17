import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import type { InstallationToken, MintPermissions } from "./types.js";
import type { RepoCapability } from "../access/repo-capabilities.js";

export const DEFAULT_PERMISSIONS: MintPermissions = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

export const READ_PERMISSIONS: MintPermissions = {
  contents: "read",
  metadata: "read",
};

export const MEMORY_WRITE_PERMISSIONS: MintPermissions = {
  contents: "write",
  metadata: "read",
};

export const PR_READ_PERMISSIONS: MintPermissions = {
  contents: "read",
  pull_requests: "read",
  metadata: "read",
};

export const CONVERSATION_READ_PERMISSIONS: MintPermissions = {
  issues: "read",
  pull_requests: "read",
  metadata: "read",
};

export const CONVERSATION_WRITE_PERMISSIONS: MintPermissions = {
  issues: "write",
  pull_requests: "write",
  metadata: "read",
};

export const ISSUE_WRITE_PERMISSIONS: MintPermissions = {
  issues: "write",
  metadata: "read",
};

export const SCM_MINT_JOB_SETS: Readonly<Record<string, MintPermissions>> = {
  "open a pull request": DEFAULT_PERMISSIONS,
  "check out a repo": READ_PERMISSIONS,
  "write memory": MEMORY_WRITE_PERMISSIONS,
  "read a pull request": PR_READ_PERMISSIONS,
  "read a conversation": CONVERSATION_READ_PERMISSIONS,
  "reply in a conversation": CONVERSATION_WRITE_PERMISSIONS,
  "act on an issue": ISSUE_WRITE_PERMISSIONS,
};

export const EXPANSION_FORBIDDEN_FAMILIES: readonly string[] = ["contents"];

export const REPO_CAPABILITY_PERMISSIONS: Readonly<Record<RepoCapability, MintPermissions>> = {
  "pr-admin": { pull_requests: "write" },
  workflows: { workflows: "write" },
};

function atLeast(a: string | undefined, b: string | undefined): boolean {
  if (b === undefined) return true;
  if (a === undefined) return false;
  return a === "write" || a === b;
}

export function expandMintPermissions(
  plane: MintPermissions,
  capabilities: readonly RepoCapability[] = [],
  table: Readonly<Record<string, MintPermissions>> = REPO_CAPABILITY_PERMISSIONS,
): MintPermissions {
  if (capabilities.length === 0) return plane;
  const out: Record<string, string | undefined> = { ...plane };
  for (const cap of capabilities) {
    const add = table[cap];
    if (!add) {
      throw new Error(
        `unknown repo capability "${cap}" — this build maps ${Object.keys(table).sort().join(", ")}. ` +
          `A capability is a NAME this deployment implements, never a raw GitHub permission string.`,
      );
    }
    for (const [family, grade] of Object.entries(add)) {
      if (EXPANSION_FORBIDDEN_FAMILIES.includes(family)) {
        throw new Error(
          `repo capability "${cap}" maps to the forbidden permission family "${family}" — a capability expansion may never raise it. ` +
            `READ_PERMISSIONS is persisted into a clone's git config, so a raisable "contents" would hand cloned code a pushable token.`,
        );
      }
      if (!atLeast(out[family], grade)) out[family] = grade;
    }
  }
  return out as MintPermissions;
}

export function normalizePrivateKeyPem(pem: string): string {
  return pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
}

export function parsePrivateKey(pem: string): KeyObject {
  return createPrivateKey(normalizePrivateKeyPem(pem));
}

export async function signAppJwt(key: KeyObject, issuer: string, nowSeconds: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + 9 * 60)
    .setIssuer(issuer)
    .sign(key);
}

export function buildMintBody(
  repoNames: readonly string[],
  permissions: MintPermissions,
): { repositories: string[]; permissions: MintPermissions } {
  return { repositories: [...new Set(repoNames)].slice(0, 500), permissions };
}

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

interface MintResponse {
  token: string;
  expires_at: string;
  repository_selection?: string;
  repositories?: { full_name: string }[];
}

export async function mintInstallationToken(opts: {
  jwt: string;
  installationId: string;
  repoNames: readonly string[];
  permissions?: MintPermissions;
  fetchFn?: FetchFn;
  apiBase?: string;
}): Promise<InstallationToken> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/app/installations/${opts.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildMintBody(opts.repoNames, opts.permissions ?? DEFAULT_PERMISSIONS)),
  });
  if (!res.ok) {
    throw new Error(`installation token mint failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as MintResponse;
  return {
    token: json.token,
    expiresAt: json.expires_at,
    repositories: (json.repositories ?? []).map((r) => r.full_name),
  };
}
