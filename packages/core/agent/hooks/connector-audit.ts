import { defineHook, type HookContext } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { connectorOpName, isConnectorOpTool, parseQualifiedToolName } from "../access/consequence.js";
import { connectorOpConsequenceOfTier, connectorOpTierParts } from "../access/connector-op-gating.js";

interface ToolResultLike {
  readonly kind?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

async function auditOpResult(event: unknown, ctx: HookContext): Promise<void> {
  try {
    const data = (event as { data?: { result?: ToolResultLike; status?: unknown } })?.data;
    const result = data?.result;
    if (!result || result.kind !== "tool-result") return;
    const toolName = result.toolName;
    if (typeof toolName !== "string" || !isConnectorOpTool(toolName)) return;
    if (parseQualifiedToolName(toolName)?.namespace !== undefined) return;

    const connection = toolName.slice(0, toolName.indexOf("__"));
    const op = connectorOpName(toolName);
    const status = typeof data?.status === "string" ? data.status : undefined;
    const tiers = connectorOpTierParts(toolName);

    let org = deploymentOrg();
    let platform = "unknown";
    let workspace = "unknown";
    let surface: string | undefined;
    let principalId: string | undefined;
    try {
      const p = resolvePartition(ctx as unknown as BindableContext);
      org = p.org;
      platform = p.platform;
      workspace = p.workspace;
      surface = p.surface;
      principalId = bindFrom(ctx as unknown as BindableContext).principalId;
    } catch {
    }

    await appendAudit({
      org,
      platform,
      workspace,
      surface,
      principalId,
      action: "connector.op",
      detail: {
        connection,
        op,
        tier: connectorOpConsequenceOfTier(tiers.tier),
        opTier: tiers.tier,
        ...(tiers.tier !== tiers.base ? { baseOpTier: tiers.base } : {}),
        ...(tiers.armPresent ? { opTierArm: true } : {}),
        ...(tiers.arm !== undefined ? { armOpTier: tiers.arm } : {}),
        ...(tiers.armLowered ? { opTierArmLowered: true, opTierBasis: tiers.basis } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(result.isError ? { isError: true } : {}),
      },
    });
  } catch {
  }
}

export default defineHook({
  events: {
    "action.result": (event, ctx) => auditOpResult(event, ctx),
  },
});
