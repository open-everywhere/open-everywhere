import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { auditToolAction } from "../audit/tool-action.js";
import type { BindableContext } from "../identity/binding.js";
import { requireAwsExecutor } from "../connections/aws-exec.js";
import { isAwsCommandAllowed, resolveAwsIdentity } from "../connections/aws-identity.js";

function awsCommandLabel(args: readonly string[]): string {
  const service = args[0] ?? "(none)";
  const operation = args[1];
  return operation ? `${service}:${operation}` : service;
}

function sessionIdOf(ctx: unknown): string | null {
  const id = (ctx as { session?: { id?: unknown } }).session?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export default defineTool({
  description:
    "Run an AWS CLI command under this channel's granted AWS role (e.g. read CloudWatch logs, query DynamoDB). Credentials are resolved host-side from the verified identity and never enter the sandbox. `args` are the arguments after `aws` (e.g. [\"logs\",\"start-query\",\"--log-group-name\",\"/x\",...]). Fails closed if this channel has no AWS role granted. Reach is bounded by the role's IAM policy.",
  inputSchema: z.object({
    args: z
      .array(z.string())
      .min(1)
      .describe('The `aws` CLI arguments AFTER the word `aws`, e.g. ["sts","get-caller-identity"] or ["logs","start-query","--log-group-name","/prod","--start-time","...","--query-string","..."].'),
    roleArn: z
      .string()
      .optional()
      .describe("If this channel is granted more than one AWS role, name which to use. Must be one of the granted roles."),
    identity: z
      .enum(["domain", "me"])
      .optional()
      .describe('Whose identity to act as: "domain" (default) uses the channel domain\'s service role; "me" uses your own AWS SSO identity (DM only, attended — not available to a routine fire or in a shared channel).'),
  }),
  outputSchema: z.object({
    exitCode: z.number().int().describe("The aws CLI exit code (0 = success). Non-zero returns the CLI's own error in stderr rather than throwing."),
    stdout: z.string(),
    stderr: z.string(),
    roleArn: z.string().describe("The role actually assumed for this call."),
    identity: z.enum(["domain-role", "user-sso"]).describe("Which identity mode the call ran under."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const unattended = actingPrincipalIdOf(ctx) === undefined;
    const command = awsCommandLabel(input.args);
    const resolved = await resolveAwsIdentity(ctx, {
      roleArn: input.roleArn,
      as: input.identity === "me" ? "user-sso" : "domain-role",
    });
    if (!isAwsCommandAllowed(input.args, resolved.allow)) {
      const service = input.args[0] ?? "(none)";
      const operation = input.args[1];
      const attempted = operation ? `${service} ${operation}` : service;
      await auditToolAction(ctx as BindableContext, "aws.refused", {
        roleArn: resolved.roleArn,
        identity: resolved.boundAs,
        domain: resolved.domain ?? null,
        sessionId: sessionIdOf(ctx),
        command,
        unattended,
        reason: "allow-list",
        allow: resolved.allow ?? null,
      });
      throw new Error(
        `aws command "${attempted}" is not permitted by this channel's AWS grant: the role "${resolved.roleArn}" ` +
          `carries a host-side allow-list (${resolved.allow!.join(", ")}) and \`${operation ? `${service}:${operation}` : service}\` ` +
          `is not on it. This is a reviewed narrowing on top of the IAM role — an admin must widen the grant's ` +
          `\`allow\` list (access/bundle.ts awsRoles) to run it. Fail-closed: the command was NOT run.`,
      );
    }
    const result = await requireAwsExecutor().run({
      credentials: resolved.credentials,
      region: resolved.region,
      args: input.args,
    });
    await auditToolAction(ctx as BindableContext, "aws.exec", {
      roleArn: resolved.roleArn,
      identity: resolved.boundAs,
      domain: resolved.domain ?? null,
      sessionId: sessionIdOf(ctx),
      region: resolved.region ?? null,
      command,
      exitCode: result.exitCode,
      unattended,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      roleArn: resolved.roleArn,
      identity: resolved.boundAs,
    };
  },
});
