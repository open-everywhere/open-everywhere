import { ingestUntrusted } from "./untrusted.js";

export interface AwsRedactionHit {
  readonly rule: "minted-credential" | "access-key-id" | "labelled-secret";
  readonly count: number;
}

export interface AwsRedactedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly hits: readonly AwsRedactionHit[];
}

const MARKER: Readonly<Record<AwsRedactionHit["rule"], string>> = {
  "minted-credential": "[redacted by Open Everywhere: this call's own minted AWS credential]",
  "access-key-id": "[redacted by Open Everywhere: AWS access key id]",
  "labelled-secret": "[redacted by Open Everywhere: AWS secret/session-token value]",
};

const ACCESS_KEY_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/gu;

const LABELLED_SECRET =
  /((?:aws[_-]?)?(?:secret[_-]?access[_-]?key|session[_-]?token)"?\s*[:=]\s*"?)([^\s"',;}\]]+)/giu;

const MIN_SECRET_LENGTH = 16;

function tally(hits: AwsRedactionHit[], rule: AwsRedactionHit["rule"], count: number): void {
  if (count === 0) return;
  const existing = hits.find((h) => h.rule === rule);
  if (existing === undefined) hits.push({ rule, count });
  else hits[hits.indexOf(existing)] = { rule, count: existing.count + count };
}

function redactKnownSecrets(text: string, secrets: readonly string[], hits: AwsRedactionHit[]): string {
  let out = text;
  let count = 0;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    let idx = out.indexOf(secret);
    while (idx >= 0) {
      count++;
      out = out.slice(0, idx) + MARKER["minted-credential"] + out.slice(idx + secret.length);
      idx = out.indexOf(secret, idx + MARKER["minted-credential"].length);
    }
  }
  tally(hits, "minted-credential", count);
  return out;
}

export function redactAwsCredentialShapes(text: string): { readonly text: string; readonly hits: readonly AwsRedactionHit[] } {
  const hits: AwsRedactionHit[] = [];
  let keyIds = 0;
  let out = text.replace(ACCESS_KEY_ID, () => {
    keyIds++;
    return MARKER["access-key-id"];
  });
  tally(hits, "access-key-id", keyIds);

  let labelled = 0;
  out = out.replace(LABELLED_SECRET, (whole, label: string, value: string) => {
    if (value.length < MIN_SECRET_LENGTH) return whole;
    labelled++;
    return `${label}${MARKER["labelled-secret"]}`;
  });
  tally(hits, "labelled-secret", labelled);
  return { text: out, hits };
}

export function redactAwsOutput(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly secrets?: readonly (string | undefined)[];
}): AwsRedactedOutput {
  const hits: AwsRedactionHit[] = [];
  const secrets = (input.secrets ?? []).filter((s): s is string => typeof s === "string");
  const pass = (text: string): string => {
    const known = redactKnownSecrets(text, secrets, hits);
    const shaped = redactAwsCredentialShapes(known);
    for (const h of shaped.hits) tally(hits, h.rule, h.count);
    return shaped.text;
  };
  return { stdout: pass(input.stdout), stderr: pass(input.stderr), hits };
}

export function redactionCount(hits: readonly { readonly count: number }[]): number {
  return hits.reduce((n, h) => n + h.count, 0);
}

export interface AwsModelResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly roleArn: string;
  readonly identity: string;
  readonly redactions?: readonly { readonly rule: string; readonly count: number }[];
}

export function renderAwsResultForModel(r: AwsModelResult): string {
  const ingestion = { kind: "aws", label: "aws" } as const;
  const out: string[] = [`aws exited ${r.exitCode} (identity: ${r.identity}, role: ${r.roleArn})`];

  out.push("", "stdout:");
  out.push(r.stdout.length === 0 ? "  (empty)" : ingestUntrusted(r.stdout, { source: "aws cli stdout", ingestion }));
  out.push("", "stderr:");
  out.push(r.stderr.length === 0 ? "  (empty)" : ingestUntrusted(r.stderr, { source: "aws cli stderr", ingestion }));

  const hits = r.redactions ?? [];
  if (hits.length > 0) {
    const detail = hits.map((h) => `${h.rule}×${h.count}`).join(", ");
    out.push(
      "",
      `NOTE (Open Everywhere, not the AWS CLI): ${redactionCount(hits)} credential-shaped value(s) were REDACTED from the output above (${detail}). ` +
        "The markers are ours; the account does not contain them. Do not attempt to recover, reconstruct or work around a redacted value.",
    );
  }
  return out.join("\n");
}
