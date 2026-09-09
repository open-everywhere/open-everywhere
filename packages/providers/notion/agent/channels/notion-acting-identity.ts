import { connectorActingIdentityForTurn, type BindableContext, type OwnAccountVendor } from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_PROVIDER } from "./notion-credentials.js";

const NOTION_OWN_ACCOUNT_VENDOR: OwnAccountVendor = { aliases: ["notion.so"], connector: NOTION_PROVIDER };

export async function assertNotionActingIdentity(ctx: BindableContext, tool: string): Promise<void> {
  const verdict = await connectorActingIdentityForTurn(ctx, NOTION_OWN_ACCOUNT_VENDOR, tool);
  if (verdict.refusal !== undefined) throw new Error(verdict.refusal);
  if (verdict.identity !== "install") {
    throw new Error(
      `Notion read "${tool}": the acting-identity gate allowed ${verdict.identity ?? "no"} identity, ` +
        `which this call site cannot spend — it resolves the deployment's own Notion credential. ` +
        `A caller that can act as the member must resolve that credential itself.`,
    );
  }
}
