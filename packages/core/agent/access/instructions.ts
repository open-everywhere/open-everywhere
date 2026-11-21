import { workGrantedConnectors } from "./work-grant.js";
import type { CredentialBoundDomain } from "./domain-credentials.js";
import type { EffectiveAccess } from "./resolver.js";

export function assembleAccessInstructions(access: EffectiveAccess, domains: readonly (CredentialBoundDomain | undefined)[] = []): string | null {
  const parts: string[] = [];
  const workConnectors = workGrantedConnectors(domains, access.repos);

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
  const workList = workConnectors.map((w) => `\`${w}\``).join(", ");
  if (workConnectors.length > 0) {
    caps.push(
      `- Work surfaces your domain is granted: ${workList} — your domain may do work on each of ` +
        `these from this channel. That work runs on the provider's own tools, never on a connection.`,
    );
  }
  if (access.optInTools.length > 0) {
    caps.push(`- Opt-in tools switched on here: ${access.optInTools.map((t) => `\`${t}\``).join(", ")}`);
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
        `have, say so plainly — don't try to route around the restriction.\n\n` +
        `A blocked request is policy, never a blip: **don't retry it**, and don't reach for a ` +
        `mirror or a proxy. Report which host you needed and why — the individual block isn't ` +
        `recorded anywhere, so your report is the only signal it happened, and widening is a ` +
        `reviewed config change either way. Inside the sandbox, \`egress/STATUS.json\` lists what ` +
        `is reachable right now and \`egress/README.md\` explains the rest.`,
    );
  }

  if (caps.length > 0 || access.connectors.length > 0) {
    const granted = access.connectors;
    const list = granted.length > 0 ? granted.map((c) => `\`${c}\``).join(", ") : "(none)";
    const workReconciliation =
      workConnectors.length > 0
        ? `\n\nThat connection list governs CONNECTIONS only. It does not narrow the work surfaces ` +
          `in **What you can access in this channel**. Your domain is granted ${workList}. Work on ` +
          `those runs on each provider's own tools, and no connection grant governs them. So an ` +
          `empty connection list is never a reason to call a granted work surface unavailable. ` +
          `Check your own tools for that provider first. If this session cannot call them but can ` +
          `delegate, delegate.`
        : "";
    parts.push(
      `### Connections you may use\n\n` +
        `- Allowed connections for this channel: ${list}\n\n` +
        `Use **only** the connections listed above. \`eve__search\` may surface other ` +
        `connections that exist on this deployment — you are **not** authorized to use them here. ` +
        `If a task needs a connection you haven't been granted, say so plainly; do not invoke it.` +
        workReconciliation,
    );
  }

  if (parts.length === 0) return null;
  return `## Channel scope: \`${access.scopeKey}\` (mode: ${access.mode})\n\n${parts.join("\n\n")}`;
}
