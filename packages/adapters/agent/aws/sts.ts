import { warmCredential, type AwsCredentials, type AwsIdentityProvider, type AwsIdentityRequest } from "@open-everywhere/core/agent/adapter-api.js";
import { readFileSync } from "node:fs";

export type FetchLike = typeof fetch;
export type TokenFileReader = (path: string) => string;

export interface AwsStsProviderOptions {
  readonly fetch?: FetchLike;
  readonly readTokenFile?: TokenFileReader;
  readonly durationSeconds?: number;
  readonly defaultRegion?: string;
  readonly mintUserSso?: (req: AwsIdentityRequest) => Promise<AwsCredentials>;
}

const AWS_WEB_IDENTITY_TOKEN_FILE_ENV = "AWS_WEB_IDENTITY_TOKEN_FILE";
const OE_AWS_WEB_IDENTITY_TOKEN_ENV = "OE_AWS_WEB_IDENTITY_TOKEN";

function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u"));
  return m?.[1]?.trim();
}

function regionFor(req: AwsIdentityRequest, defaultRegion: string | undefined): string {
  return req.region ?? defaultRegion ?? process.env.AWS_REGION ?? "us-east-1";
}

function readWebIdentityToken(readTokenFile: TokenFileReader): string {
  const path = process.env[AWS_WEB_IDENTITY_TOKEN_FILE_ENV]?.trim();
  if (path) {
    let raw: string;
    try {
      raw = readTokenFile(path);
    } catch (err) {
      throw new Error(
        `AWS OIDC token file (${AWS_WEB_IDENTITY_TOKEN_FILE_ENV}=${path}) is unreadable: ${
          err instanceof Error ? err.message : String(err)
        }. Fail-closed: no AWS access.`,
      );
    }
    const token = raw.trim();
    if (!token) throw new Error(`AWS OIDC token file (${path}) is empty. Fail-closed: no AWS access.`);
    return token;
  }
  const inline = process.env[OE_AWS_WEB_IDENTITY_TOKEN_ENV]?.trim();
  if (inline) return inline;
  throw new Error(
    `no AWS OIDC token available — set ${AWS_WEB_IDENTITY_TOKEN_FILE_ENV} (the deployment's web-identity ` +
      `token file) or ${OE_AWS_WEB_IDENTITY_TOKEN_ENV}. Fail-closed: no AWS access.`,
  );
}

async function assumeRoleWithWebIdentity(
  req: AwsIdentityRequest,
  fetchImpl: FetchLike,
  readTokenFile: TokenFileReader,
  durationSeconds: number,
  defaultRegion: string | undefined,
): Promise<AwsCredentials> {
  const token = readWebIdentityToken(readTokenFile);
  const region = regionFor(req, defaultRegion);
  const endpoint = `https://sts.${region}.amazonaws.com/`;
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: req.roleArn,
    RoleSessionName: req.roleSessionName,
    WebIdentityToken: token,
    DurationSeconds: String(durationSeconds),
    ...(req.sessionPolicy !== undefined ? { Policy: req.sessionPolicy } : {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/xml" },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(
      `STS AssumeRoleWithWebIdentity transport error against ${endpoint}: ${
        err instanceof Error ? err.message : String(err)
      }. Fail-closed: no AWS access.`,
    );
  }

  const text = await res.text();
  if (!res.ok || xmlTag(text, "Error") !== undefined || /<ErrorResponse[\s>]/u.test(text)) {
    const code = xmlTag(text, "Code");
    const message = xmlTag(text, "Message");
    throw new Error(
      `STS AssumeRoleWithWebIdentity failed (HTTP ${res.status}${code ? `, ${code}` : ""})${
        message ? `: ${message}` : `: ${text.slice(0, 300)}`
      }. Fail-closed: no AWS access.`,
    );
  }

  const accessKeyId = xmlTag(text, "AccessKeyId");
  const secretAccessKey = xmlTag(text, "SecretAccessKey");
  const sessionToken = xmlTag(text, "SessionToken");
  const expiration = xmlTag(text, "Expiration");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error(
      `STS response missing credential fields (AccessKeyId/SecretAccessKey/SessionToken): ${text.slice(
        0,
        300,
      )}. Fail-closed: no AWS access.`,
    );
  }
  const expiresAtMs = expiration ? Date.parse(expiration) : NaN;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    ...(Number.isFinite(expiresAtMs) ? { expiresAtMs } : {}),
  };
}

export function makeAwsStsProvider(opts: AwsStsProviderOptions = {}): AwsIdentityProvider {
  const fetchImpl = opts.fetch ?? fetch;
  const readTokenFile = opts.readTokenFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const durationSeconds = opts.durationSeconds ?? 3600;
  const defaultRegion = opts.defaultRegion;
  const mintUserSso = opts.mintUserSso;

  const warm = warmCredential<AwsIdentityRequest>({
    name: "aws.sts-web-identity",
    platform: "aws",
    auditAction: "aws.sts.mint_failed",
    refresh: "re-mint",
    fallbackTtlSeconds: durationSeconds,
    key: (req) =>
      `${req.kind}:${req.org ?? ""}:${req.roleArn}:${req.roleSessionName}:${req.principalSubject ?? ""}:${req.sessionPolicy ?? ""}`,
    mint: async (req) => {
      const creds = await assumeRoleWithWebIdentity(req, fetchImpl, readTokenFile, durationSeconds, defaultRegion);
      return { value: JSON.stringify(creds), ...(creds.expiresAtMs !== undefined ? { expiresAtMs: creds.expiresAtMs } : {}) };
    },
  });

  return {
    async mint(req: AwsIdentityRequest): Promise<AwsCredentials> {
      if (req.kind === "user-sso") {
        if (mintUserSso) return mintUserSso(req);
        throw new Error(
          "AWS SSO per-user identity linking is not configured (Phase 1). " +
            "Use the domain role.",
        );
      }
      const serialised = await warm.get(req);
      return JSON.parse(serialised) as AwsCredentials;
    },
  };
}
