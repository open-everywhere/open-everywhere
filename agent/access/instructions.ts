import type { EffectiveAccess } from "./resolver.js";

export function assembleAccessInstructions(access: EffectiveAccess): string | null {
  const parts: string[] = [];

  if (access.instructionStack.length > 0) {
    const lines = access.instructionStack.map((l) => `- (${l.source}) ${l.text}`).join("\n");
    parts.push(
      `### Standing instructions for this scope\n\n` +
        `These are scope-level rules and **outrank channel memory**. Where layers differ, ` +
        `the narrower/later scope wins. Follow them:\n\n${lines}`,
    );
  }

  const caps: string[] = [];
  if (access.reachableHosts.length > 0) {
    caps.push(
      `- Hosts you can reach: ` +
        access.reachableHosts
          .map((h) => `\`${h.host}\`${h.viaConnection ? " (authenticated)" : ""}`)
          .join(", "),
    );
  }
  if (access.repos.length > 0) {
    caps.push(`- Repositories granted: ${access.repos.map((r) => `\`${r}\``).join(", ")}`);
  }
  if (access.plugins.length > 0) {
    caps.push(`- Plugins available: ${access.plugins.map((p) => `\`${p.id}\``).join(", ")}`);
  }
  if (caps.length > 0) {
    parts.push(
      `### What you can access in this channel\n\n${caps.join("\n")}\n\n` +
        `Anything not listed is blocked at the firewall. If a task needs something you don't ` +
        `have, say so plainly — don't try to route around the restriction.`,
    );
  }

  if (parts.length === 0) return null;
  return `## Channel scope: \`${access.scopeKey}\` (mode: ${access.mode})\n\n${parts.join("\n\n")}`;
}
