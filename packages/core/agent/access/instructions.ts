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
    caps.push(`- Plugins granted: ${access.plugins.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (access.skills.length > 0) {
    caps.push(`- Skills available: ${access.skills.map((s) => `\`${s}\``).join(", ")}`);
  }
  if (caps.length > 0) {
    parts.push(
      `### What you can access in this channel\n\n${caps.join("\n")}\n\n` +
        `Anything not listed is blocked at the firewall. If a task needs something you don't ` +
        `have, say so plainly — don't try to route around the restriction.`,
    );
  }

  if (caps.length > 0 || access.connectors.length > 0) {
    const granted = access.connectors;
    const list = granted.length > 0 ? granted.map((c) => `\`${c}\``).join(", ") : "(none)";
    parts.push(
      `### Connections you may use\n\n` +
        `- Allowed connections for this channel: ${list}\n\n` +
        `Use **only** the connections listed above. \`connection_search\` may surface other ` +
        `connections that exist on this deployment — you are **not** authorized to use them here. ` +
        `If a task needs a connection you haven't been granted, say so plainly; do not invoke it.`,
    );
  }

  if (parts.length === 0) return null;
  return `## Channel scope: \`${access.scopeKey}\` (mode: ${access.mode})\n\n${parts.join("\n\n")}`;
}
