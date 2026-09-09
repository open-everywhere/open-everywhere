import { connectorActingIdentityForTurn, type BindableContext, type OwnAccountVendor } from "@open-everywhere/core/agent/adapter-api.js";

export const GITHUB_CONNECTOR = "github";

export const GITHUB_OWN_ACCOUNT_VENDOR: OwnAccountVendor = { aliases: ["github.com"], connector: GITHUB_CONNECTOR };

export async function assertGithubActingIdentity(ctx: BindableContext, tool: string): Promise<void> {
  const verdict = await connectorActingIdentityForTurn(ctx, GITHUB_OWN_ACCOUNT_VENDOR, tool);
  if (verdict.refusal !== undefined) throw new Error(verdict.refusal);
  if (verdict.identity !== "install") {
    throw new Error(
      `GitHub read "${tool}": the acting-identity gate allowed ${verdict.identity ?? "no"} identity, ` +
        `which this call site cannot spend — it resolves the deployment's own GitHub App installation. ` +
        `A caller that can act as the member must resolve that credential itself.`,
    );
  }
}
