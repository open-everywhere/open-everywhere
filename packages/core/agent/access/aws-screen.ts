export interface AwsScreenInput {
  readonly argv: readonly string[];
  readonly allow: readonly string[] | undefined;
}

export type AwsScreenVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "credential-read" | "argv-option" | "allow-list"; readonly reason: string };

const AWS_REFUSED_ARGV_OPTIONS: readonly string[] = [
  "--endpoint-url",
  "--ca-bundle",
  "--no-verify-ssl",
  "--profile",
  "--outfile",
  "--debug",
];

const AWS_CREDENTIAL_SELF_READ_SUBCOMMANDS: readonly string[] = ["export-credentials", "list"];

const CLI_SERVICE_TO_IAM_PREFIX: Readonly<Record<string, string>> = {
  s3api: "s3",
};

export const AWS_S3_HIGH_LEVEL_FANOUT: Readonly<Record<string, readonly string[]>> = {
  ls: ["s3:ListBucket", "s3:ListAllMyBuckets"],
  cp: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
  mv: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
  sync: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
  rm: ["s3:DeleteObject", "s3:ListBucket"],
  mb: ["s3:CreateBucket"],
  rb: ["s3:DeleteBucket"],
  presign: ["s3:GetObject"],
};

export function cliOpToIamAction(op: string): string {
  return op
    .trim()
    .split(/[-_]/u)
    .map((seg) => (seg.length === 0 ? "" : seg[0]!.toUpperCase() + seg.slice(1)))
    .join("");
}

function globMatch(pattern: string, value: string): boolean {
  const rx = new RegExp(
    "^" + pattern.toLowerCase().split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*") + "$",
    "u",
  );
  return rx.test(value.toLowerCase());
}

function normCliOp(op: string): string {
  return op.trim().toLowerCase().replace(/_/gu, "-");
}

function entryMatches(entry: string, service: string, cliOp: string | undefined, iamPrefix: string, iamAction: string | undefined): boolean {
  const sep = entry.indexOf(":");
  if (sep < 0) {
    return globMatch(entry.trim(), service) || globMatch(entry.trim(), iamPrefix);
  }
  const entryService = entry.slice(0, sep).trim();
  const entryOp = entry.slice(sep + 1).trim();
  const serviceOk = globMatch(entryService, service) || globMatch(entryService, iamPrefix);
  if (!serviceOk) return false;
  if (cliOp !== undefined && globMatch(normCliOp(entryOp), normCliOp(cliOp))) return true;
  if (iamAction !== undefined && globMatch(entryOp, iamAction)) return true;
  if (iamAction !== undefined && globMatch(cliOpToIamAction(entryOp), iamAction)) return true;
  return false;
}

export function awsCommandVerdict(input: AwsScreenInput): AwsScreenVerdict {
  const argv = input.argv;
  const service = argv[0]?.trim().toLowerCase();
  if (service === undefined || service.length === 0) {
    return { ok: false, code: "allow-list", reason: "no service named — nothing to allow" };
  }

  if (service === "configure") {
    const sub = argv[1]?.trim().toLowerCase();
    if (sub !== undefined && AWS_CREDENTIAL_SELF_READ_SUBCOMMANDS.includes(sub)) {
      return {
        ok: false,
        code: "credential-read",
        reason: `\`aws configure ${sub}\` echoes the injected credentials to the model and is refused unconditionally`,
      };
    }
  }

  for (const raw of argv) {
    const token = raw.trim();
    const optName = token.startsWith("--") ? token.split("=", 1)[0]!.toLowerCase() : undefined;
    if (optName !== undefined && AWS_REFUSED_ARGV_OPTIONS.includes(optName)) {
      return {
        ok: false,
        code: optName === "--debug" ? "credential-read" : "argv-option",
        reason: `\`${optName}\` is refused on every aws command — it ${
          optName === "--debug" ? "logs the resolved credential chain to output the model reads" : "redirects the signed request or reads/writes host state outside the injected credentials"
        }`,
      };
    }
    if (token.toLowerCase().includes("file://")) {
      return { ok: false, code: "argv-option", reason: "a `file://`-valued argument reads a host file into the request and is refused" };
    }
  }

  const allow = input.allow;
  if (allow === undefined || allow.length === 0) {
    return {
      ok: false,
      code: "allow-list",
      reason: "this grant carries no `allow` list — unrestricted access must be spelled `allow: [\"*\"]` explicitly (access/bundle.ts awsRoles)",
    };
  }
  if (allow.some((e) => e.trim() === "*")) return { ok: true };

  const cliOp = argv[1]?.trim();
  const iamPrefix = CLI_SERVICE_TO_IAM_PREFIX[service] ?? service;

  const fanout = service === "s3" && cliOp !== undefined ? AWS_S3_HIGH_LEVEL_FANOUT[cliOp.toLowerCase()] : undefined;
  if (fanout !== undefined) {
    const allOk = fanout.every((qualified) => {
      const [fanPrefix, fanAction] = qualified.split(":") as [string, string];
      return allow.some((entry) => entryMatches(entry, service, cliOp, fanPrefix, fanAction));
    });
    if (allOk) return { ok: true };
    return {
      ok: false,
      code: "allow-list",
      reason: `\`${service} ${cliOp}\` fans out to ${fanout.join(", ")} and the grant's allow list does not cover all of them`,
    };
  }

  const iamAction = cliOp === undefined ? undefined : cliOpToIamAction(cliOp);
  if (allow.some((entry) => entryMatches(entry, service, cliOp, iamPrefix, iamAction))) return { ok: true };
  return {
    ok: false,
    code: "allow-list",
    reason: `\`${cliOp !== undefined ? `${service}:${cliOp}` : service}\` matches no entry of the grant's allow list`,
  };
}

export function awsSessionPolicyFromAllow(allow: readonly string[]): string | undefined {
  if (allow.length === 0) return undefined;
  if (allow.some((e) => e.trim() === "*")) return undefined;
  const actions: string[] = [];
  for (const entry of allow) {
    const sep = entry.indexOf(":");
    if (sep < 0) {
      const service = entry.trim().toLowerCase();
      if (service.includes("*")) return undefined;
      actions.push(`${CLI_SERVICE_TO_IAM_PREFIX[service] ?? service}:*`);
      continue;
    }
    const service = entry.slice(0, sep).trim().toLowerCase();
    const op = entry.slice(sep + 1).trim();
    if (service.includes("*")) return undefined;
    const iamPrefix = CLI_SERVICE_TO_IAM_PREFIX[service] ?? service;
    const fanout = service === "s3" ? AWS_S3_HIGH_LEVEL_FANOUT[op.toLowerCase()] : undefined;
    if (fanout !== undefined) {
      actions.push(...fanout);
      continue;
    }
    actions.push(`${iamPrefix}:${cliOpToIamAction(op)}`);
  }
  const unique = [...new Set(actions)].sort();
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: unique, Resource: "*" }],
  });
}
