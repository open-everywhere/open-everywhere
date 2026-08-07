import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-aws-audit-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
delete process.env.OE_ORG;

const { registerConfig } = await import("../agent/access/config.js");
const { registerAwsIdentityProvider, resetAwsIdentityProvider } = await import("../agent/connections/aws-identity.js");
const { registerAwsExecutor, resetAwsExecutor } = await import("../agent/connections/aws-exec.js");
const { readAudit } = await import("../agent/audit/audit.js");
const awsTool = (await import("../agent/tools/aws.js")).default as {
  execute(input: { args: string[]; roleArn?: string; identity?: "domain" | "me" }, ctx: unknown): Promise<unknown>;
};

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

registerConfig({
  loadBundles: () => [
    { name: "aws-ops", awsRoles: [{ roleArn: "arn:aws:iam::123456789012:role/oe-ops", region: "eu-west-2", allow: ["logs", "s3:cp"] }] },
  ],
  loadBindings: () => [{ bundle: "aws-ops", scope: { level: "domain", domain: "ops" } }],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => ["ops"],
});

registerAwsIdentityProvider({
  async mint() {
    return { accessKeyId: "AKIA_FAKE", secretAccessKey: "fake-secret", sessionToken: "fake-session-token" };
  },
});

const runs: { args: readonly string[] }[] = [];
registerAwsExecutor({
  async run(req: { args: readonly string[] }) {
    runs.push({ args: req.args });
    return { exitCode: 3, stdout: "{\"secretish\":\"account data\"}", stderr: "boom" };
  },
});

const attendedCtx = {
  channel: { kind: "local" },
  session: { id: "sess_attended", auth: { current: { attributes: {}, principalId: "U_OPERATOR" } } },
};

const fireCtx = {
  channel: { kind: "local" },
  session: {
    id: "sess_fire",
    auth: {
      current: {
        principalType: "service",
        principalId: "U_CREATOR",
        attributes: { oe_fire_principal: "U_CREATOR", oe_fire_unattended: "true" },
      },
    },
  },
};

type Row = { action: string; principalId?: string; detail?: Record<string, unknown> };
async function rowsFor(action: string): Promise<Row[]> {
  return (await readAudit({})).filter((r) => r.action === action) as Row[];
}

try {
  await awsTool.execute({ args: ["logs", "start-query", "--log-group-name", "/prod"] }, attendedCtx);

  const exec = await rowsFor("aws.exec");
  ok(exec.length === 1, `exec: exactly one aws.exec row (got ${exec.length})`);
  const d = exec[0]?.detail ?? {};
  ok(d["roleArn"] === "arn:aws:iam::123456789012:role/oe-ops", "exec: the row names the role actually assumed");
  ok(d["identity"] === "domain-role", "exec: the row names the identity MODE — a domain service role, not a borrowed human");
  ok(d["region"] === "eu-west-2", "exec: the granted region rides onto the row");
  ok(d["command"] === "logs:start-query", "exec: the command is recorded at `service:operation` grain — the same grain the allow-list narrows on");
  ok(d["exitCode"] === 3, "exec: the CLI's own verdict is recorded, so a failing call is not indistinguishable from a passing one");
  ok(d["unattended"] === false, "exec: a human-acting turn is recorded as attended");
  ok(exec[0]?.principalId === "U_OPERATOR", "exec: the row is ATTRIBUTED — one audit row per consequential action, naming who asked");
  ok(d["sessionId"] === "sess_attended", "exec: the eve session id rides on the row — the join key to the transcript (design §9)");
  ok(d["domain"] === "ops", "exec: the row names the DOMAIN whose role was assumed, taken from the plan rather than re-derived, so it cannot disagree with the RoleSessionName CloudTrail sees");
  ok(
    !JSON.stringify(d).includes("account data") && !JSON.stringify(d).includes("boom"),
    "exec: 🔴 NEITHER stdout NOR stderr is in the row — the audit log is append-only and outside the erasure path, so the account's own bytes must never be parked in it",
  );
  ok(runs.length === 1 && runs[0]?.args[1] === "start-query", "exec: the CLI ran exactly once, with the caller's args");

  let threw = "";
  try {
    await awsTool.execute({ args: ["iam", "create-user", "--user-name", "mallory"] }, attendedCtx);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(threw.includes("is not permitted by this channel's AWS grant"), `refused: the tool still fails closed (message: "${threw}")`);
  ok(runs.length === 1, "refused: 🔴 the executor was NOT reached — the allow-list refuses BEFORE the CLI runs, so the row records an attempt and never an effect");

  const refused = await rowsFor("aws.refused");
  ok(refused.length === 1, `refused: exactly one aws.refused row (got ${refused.length})`);
  const rd = refused[0]?.detail ?? {};
  ok(rd["command"] === "iam:create-user", "refused: the row names what was attempted, at the same grain as the exec row");
  ok(rd["reason"] === "allow-list", "refused: the row names WHICH fence refused — there is more than one way this tool can say no");
  ok(
    JSON.stringify(rd["allow"]) === JSON.stringify(["logs", "s3:cp"]),
    "refused: the row carries the VERIFIED grant's own list, which is what tells a probe apart from a grant that is simply too narrow",
  );
  ok((await rowsFor("aws.exec")).length === 1, "refused: …and it wrote NO aws.exec row — a refusal must never read as an execution");

  await awsTool.execute({ args: ["logs", "describe-log-groups"] }, fireCtx);
  const fired = (await rowsFor("aws.exec")).find((r) => r.detail?.["command"] === "logs:describe-log-groups");
  ok(fired !== undefined, "unattended: a routine fire's aws call is audited like any other");
  ok(
    fired?.detail?.["unattended"] === true,
    "unattended: 🔴 …and it is FLAGGED as unattended — the fire binds a real person's id as its attested creator, so the principal alone can never answer 'was anyone actually there'",
  );
  ok(fired?.detail?.["sessionId"] === "sess_fire", "unattended: the fire's own session id rides too — a fire has no conversation to reconstruct it from, so the transcript join is the only route left");
  ok(fired?.principalId === "U_CREATOR", "unattended: the row still names the attested creator — non-empty, which is exactly why `unattended` cannot be inferred from the principal column");
} finally {
  resetAwsIdentityProvider();
  resetAwsExecutor();
}

console.log(`✓ ${passed} aws-audit assertions passed`);
rmSync(tmp, { recursive: true, force: true });
