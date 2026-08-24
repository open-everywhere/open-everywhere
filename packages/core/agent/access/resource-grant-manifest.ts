export interface ResourceGrantToolFile {
  readonly name: string;
  readonly source: string;
}

export type ResourceGrantTier = "P1" | "P2";

interface TierGate {
  readonly mount: string;
  readonly fence: string;
  readonly summary: string;
}

const TIER_GATES: Readonly<Record<ResourceGrantTier, TierGate>> = Object.freeze({
  P1: Object.freeze({
    mount: "chatWriteMount",
    fence: "assertChatWriteAllowed",
    summary: "post into another container in this domain (access/chat-write-grant.ts)",
  }),
  P2: Object.freeze({
    mount: "chatDmMount",
    fence: "assertChatDmAllowed",
    summary: "direct-message a granted person (access/chat-dm-grant.ts)",
  }),
});

export const RESOURCE_GRANT_TIERS: readonly ResourceGrantTier[] = (Object.keys(TIER_GATES) as ResourceGrantTier[]).sort();

export function tierGate(tier: ResourceGrantTier): { readonly mount: string; readonly fence: string; readonly summary: string } {
  return TIER_GATES[tier];
}

export const RESOURCE_GRANT_TOOL_MOUNTS: Readonly<Record<string, ResourceGrantTier>> = Object.freeze({
  post_message: "P1",
  dm_person: "P2",
});

const RESOURCE_GRANT_SIGNAL = new RegExp(
  [
    "\\bchatWriteMount\\b",
    "\\bchatWriteTargets\\b",
    "\\bchatWriteTargetsFrom\\b",
    "\\bassertChatWriteAllowed\\b",
    "\\bresolveChatWriteTarget\\b",
    "\\bchatDmMount\\b",
    "\\bchatDmTargets\\b",
    "\\bchatDmTargetsFrom\\b",
    "\\bassertChatDmAllowed\\b",
    "\\bresolveChatDmTarget\\b",
  ].join("|"),
  "u",
);

export function isResourceGrantTool(source: string): boolean {
  return RESOURCE_GRANT_SIGNAL.test(source);
}

function namesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`, "u").test(source);
}

export function checkResourceGrantMounts(
  tools: readonly ResourceGrantToolFile[],
  mounts: Readonly<Record<string, ResourceGrantTier>> = RESOURCE_GRANT_TOOL_MOUNTS,
): string[] {
  const problems: string[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const tierList = RESOURCE_GRANT_TIERS.join(", ");

  for (const [name, tier] of Object.entries(mounts)) {
    const gate = TIER_GATES[tier];
    if (!gate) {
      problems.push(`tool "${name}" declares unknown tier ${JSON.stringify(tier)} — the classifiable tiers are ${tierList}`);
      continue;
    }
    const tool = byName.get(name);
    if (!tool) {
      problems.push(
        `tool "${name}" is declared in RESOURCE_GRANT_TOOL_MOUNTS but no such tool file was scanned — delete the row, or restore the tool`,
      );
      continue;
    }
    if (!namesIdentifier(tool.source, gate.mount)) {
      problems.push(
        `tool "${name}" is declared tier ${tier} (${gate.summary}) but never names ${gate.mount} — a verb whose grant is absent must be UNMOUNTED, not merely refused, ` +
          `because a tool the model can see and can never use is what produces a false capability claim in a member-facing reply (OPE-927)`,
      );
    }
    if (!namesIdentifier(tool.source, gate.fence)) {
      problems.push(
        `tool "${name}" is declared tier ${tier} (${gate.summary}) but never names ${gate.fence} — the mount alone is not a gate. ` +
          `The mount decides what the model SEES; the fence decides whether ONE named target is admitted, and only the fence audits its refusal`,
      );
    }
    for (const other of RESOURCE_GRANT_TIERS) {
      if (other === tier) continue;
      const crossed = TIER_GATES[other];
      if (namesIdentifier(tool.source, crossed.fence)) {
        problems.push(
          `tool "${name}" is declared tier ${tier} but names tier ${other}'s fence ${crossed.fence} — one tool, one tier. ` +
            `The two tiers share no code and gate different things (${gate.summary} vs ${crossed.summary})`,
        );
      }
    }
  }

  for (const tool of tools) {
    if (!isResourceGrantTool(tool.source)) continue;
    if (Object.hasOwn(mounts, tool.name)) continue;
    problems.push(
      `tool "${tool.name}" mounts or fences on the RESOURCE-GRANT plane (its source names a chat-write or chat-dm grant symbol) but appears in ` +
        `RESOURCE_GRANT_TOOL_MOUNTS under no tier — classify it as one of ${tierList}. A verb on this plane owes a mount AND a fence; ` +
        `see access/resource-grant-manifest.ts for why that pair is the invariant`,
    );
  }

  return problems;
}
