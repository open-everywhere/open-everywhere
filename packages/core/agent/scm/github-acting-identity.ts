import { connectorActingIdentityForTurn } from "../connections/own-account-gate.js";
import { ownAccountVendorFor } from "../connections/own-account-vendors.js";
import type { OwnAccountVendor } from "../connections/own-account-ask.js";
import type { BindableContext } from "../identity/binding.js";

export const GITHUB_CONNECTOR = "github";

export const GITHUB_OWN_ACCOUNT_VENDOR: OwnAccountVendor = ownAccountVendorFor(GITHUB_CONNECTOR);

export async function assertGithubActingIdentity(ctx: BindableContext, tool: string): Promise<void> {
  // own-account-gate: github — the marker `npm run lint:own-account-gate` reads (OPE-1598). The
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
