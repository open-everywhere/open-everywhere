import { surfaceAppManifest } from "@open-everywhere/core/agent/adapter-api.js";
import { registerSlackOps } from "../agent/ops.js";
import { manifestVariants, pastedManifest, VARIANT_HOST, type ManifestVariant } from "./_manifest-variants.js";

const VALIDATE_URL = "https://slack.com/api/apps.manifest.validate";

interface ValidateAnswer {
  readonly ok: boolean;
  readonly error?: string;
  readonly errors?: readonly { readonly message?: string; readonly pointer?: string }[];
}

const TOKEN_ERRORS = new Set(["not_authed", "invalid_auth", "token_expired", "token_revoked", "account_inactive", "not_allowed_token_type"]);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const token = await readStdin();
if (!token.startsWith("xoxe")) {
  console.error("✗ pipe an app configuration token (xoxe…) on stdin — see the header of this file for where to get one");
  process.exit(2);
}

function cannotRun(why: string): never {
  console.error(`✗ the check could not run: ${why}`);
  process.exit(2);
}

async function validateOnce(manifest: Record<string, unknown>, retried = false): Promise<ValidateAnswer> {
  let res: Response;
  let answer: ValidateAnswer;
  try {
    res = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ manifest: JSON.stringify(manifest) }),
      signal: AbortSignal.timeout(30_000),
    });
    answer = (await res.json()) as ValidateAnswer;
  } catch (err) {
    cannotRun(`the request to Slack failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (answer.error === "ratelimited" || res.status === 429) {
    if (retried) cannotRun("Slack rate-limited the check twice — run it again in a minute");
    const wait = Math.min(Number(res.headers.get("retry-after") ?? "30") || 30, 120);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return await validateOnce(manifest, true);
  }
  return answer;
}

registerSlackOps();
const served = surfaceAppManifest("slack", { host: VARIANT_HOST });
if (served === undefined) cannotRun("registerSlackOps() registered no slack manifest");
const variants: readonly ManifestVariant[] = [
  ...manifestVariants(),
  { label: "the manifest surface_manifest serves (shipped settings)", manifest: pastedManifest(String(served.manifest)) },
];
let refused = 0;
for (const v of variants) {
  const answer = await validateOnce(v.manifest);
  if (answer.ok) {
    console.log(`✓ ${v.label}`);
    continue;
  }
  if (answer.error !== undefined && TOKEN_ERRORS.has(answer.error)) {
    cannotRun(`Slack refused the token (${answer.error}) — generate a fresh app configuration token`);
  }
  if (answer.error !== "invalid_manifest" && (answer.errors ?? []).length === 0) {
    cannotRun(`Slack answered ${answer.error ?? "ok:false with no error"}, which is not a verdict on the manifest`);
  }
  refused++;
  console.error(`✗ ${v.label}: ${answer.error ?? "refused"}`);
  for (const e of answer.errors ?? []) console.error(`    ${e.pointer ?? "/"} — ${e.message ?? ""}`);
}

if (refused > 0) {
  console.error(`✗ slack-manifest-validate-live: Slack refused ${refused} of ${variants.length} manifests`);
  process.exit(1);
}
console.log(`✓ slack-manifest-validate-live: Slack's apps.manifest.validate accepts all ${variants.length} manifests`);
