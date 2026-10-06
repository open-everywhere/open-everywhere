import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalIdOf, unattendedOf } from "../access/request.js";
import { approvalModeForDomain, resolveApproverChain } from "../access/approver-chain.js";
import { haltScopeForCtx, resolveHalt } from "../access/halt.js";
import { awsCommandVerdict } from "../access/aws-screen.js";
import { redactAwsOutput, redactionCount, renderAwsResultForModel } from "../access/aws-output.js";
import { auditToolAction } from "../audit/tool-action.js";
import type { BindableContext } from "../identity/binding.js";
import { requireAwsExecutor } from "../connections/aws-exec.js";
import { mintPlannedAwsIdentity, planAwsIdentityFor } from "../connections/aws-identity.js";

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
    "Run an AWS CLI command under this channel's granted AWS role (e.g. read CloudWatch logs, query DynamoDB). Credentials are resolved host-side from the verified identity and never enter the sandbox. `args` are the arguments after `aws` (e.g. [\"logs\",\"start-query\",\"--log-group-name\",\"/x\",...]). Fails closed if this channel has no AWS role granted, and refuses commands outside the grant's allow list (plus, always: credential-echo subcommands and request-redirect options). Reach is bounded by the role's IAM policy.",
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
    redactions: z
      .array(z.object({ rule: z.string(), count: z.number().int() }))
      .describe("Credential-shaped values the agent removed from stdout/stderr before returning them — rule names and counts, never the removed values. Empty on an ordinary call."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const unattended = unattendedOf(ctx);
    const command = awsCommandLabel(input.args);

    const plan = planAwsIdentityFor(ctx as BindableContext, {
      roleArn: input.roleArn,
      as: input.identity === "me" ? "user-sso" : "domain-role",
    });

    const resolution = await resolveApproverChain({
      tool: "aws",
      args: input.args,
      principalId: actingPrincipalIdOf(ctx),
      unattended,
      ...(plan.domain !== undefined ? { domain: plan.domain, mode: approvalModeForDomain(plan.domain) } : {}),
      halted: (await resolveHalt(haltScopeForCtx(ctx as BindableContext))).halted,
      aws: { argv: input.args, allow: plan.grant.allow },
    });

    if (resolution.verdict !== "allow") {
      const screen = awsCommandVerdict({ argv: input.args, allow: plan.grant.allow });
      const reason = screen.ok ? "mode" : screen.code;
      await auditToolAction(ctx as BindableContext, "aws.refused", {
        roleArn: plan.grant.roleArn,
        identity: plan.kind,
        domain: plan.domain ?? null,
        sessionId: sessionIdOf(ctx),
        command,
        unattended,
        reason,
        allow: plan.grant.allow ?? null,
        resolvedBy: resolution.resolvedBy,
        transforms: resolution.transforms.map((t) => t.name),
      });
      const detail = screen.ok
        ? `this domain's approval mode (${resolution.transforms.map((t) => t.name).join(", ") || resolution.resolvedBy}) stops it — a config decision, lifted only by a config diff`
        : screen.reason;
      throw new Error(
        screen.ok || screen.code !== "allow-list"
          ? `aws command "${command}" was refused before anything ran: ${detail}. Fail-closed: the command was NOT run and no credential was minted.`
          : `aws command "${command}" is not permitted by this channel's AWS grant: the role "${plan.grant.roleArn}" ` +
            `carries a host-side allow-list (${(plan.grant.allow ?? []).join(", ")}) and it does not cover this command. ` +
            `This is a reviewed narrowing on top of the IAM role — an admin must widen the grant's \`allow\` list ` +
            `(access/bundle.ts awsRoles) to run it. Fail-closed: the command was NOT run and no credential was minted.`,
      );
    }

    const resolved = await mintPlannedAwsIdentity(plan);
    const result = await requireAwsExecutor().run({
      credentials: resolved.credentials,
      region: resolved.region,
      args: input.args,
    });
    const redacted = redactAwsOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      secrets: [resolved.credentials.accessKeyId, resolved.credentials.secretAccessKey, resolved.credentials.sessionToken],
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
      redactions: redactionCount(redacted.hits),
    });
    return {
      exitCode: result.exitCode,
      stdout: redacted.stdout,
      stderr: redacted.stderr,
      roleArn: resolved.roleArn,
      identity: resolved.boundAs,
      redactions: redacted.hits.map((h) => ({ rule: h.rule, count: h.count })),
    };
  },
  toModelOutput(output) {
    return { type: "text" as const, value: renderAwsResultForModel(output) };
  },
});
