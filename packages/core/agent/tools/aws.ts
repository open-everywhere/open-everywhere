import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { requireAwsExecutor } from "../connections/aws-exec.js";
import { resolveAwsIdentity } from "../connections/aws-identity.js";

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
    const resolved = await resolveAwsIdentity(ctx, {
      roleArn: input.roleArn,
      as: input.identity === "me" ? "user-sso" : "domain-role",
    });
    const result = await requireAwsExecutor().run({
      credentials: resolved.credentials,
      region: resolved.region,
      args: input.args,
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
