import type { SandboxNetworkPolicy } from "eve/sandbox";
import { lockCommand, unlockCommand } from "../memory/readonly.js";

export const EGRESS_DIR = "egress";
export const EGRESS_STATUS_PATH = `${EGRESS_DIR}/STATUS.json`;
export const EGRESS_README_PATH = `${EGRESS_DIR}/README.md`;

export type EgressEnforcementState = "enforced" | "dry-run" | "unenforced";

export interface EgressAllowEntry {
  readonly host: string;
  readonly methods?: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly credentialInjected: boolean;
}

export interface EgressPolicySummary {
  readonly defaultAction: "deny" | "allow";
  readonly allow: readonly EgressAllowEntry[];
}

export interface EgressStatusInput {
  readonly policy: SandboxNetworkPolicy;
  readonly state: EgressEnforcementState;
  readonly fingerprint: string;
  readonly compileError: boolean;
}

interface OpaqueRule {
  readonly match?: { readonly method?: readonly string[]; readonly path?: { readonly startsWith?: string } };
  readonly transform?: readonly { readonly headers?: Record<string, string> }[];
}

export function summariseEgressPolicy(policy: SandboxNetworkPolicy): EgressPolicySummary {
  if (typeof policy === "string") {
    return { defaultAction: policy === "allow-all" ? "allow" : "deny", allow: [] };
  }
  const allowMap = (policy as { allow?: Record<string, readonly OpaqueRule[]> }).allow ?? {};
  const allow: EgressAllowEntry[] = [];
  for (const host of Object.keys(allowMap).sort((a, b) => a.localeCompare(b))) {
    const rules = allowMap[host] ?? [];
    const methods = new Set<string>();
    const prefixes = new Set<string>();
    let credentialInjected = false;
    for (const rule of rules) {
      for (const m of rule.match?.method ?? []) methods.add(m);
      const prefix = rule.match?.path?.startsWith;
      if (typeof prefix === "string" && prefix.length > 0) prefixes.add(prefix);
      for (const t of rule.transform ?? []) {
        if (t.headers !== undefined && Object.keys(t.headers).length > 0) credentialInjected = true;
      }
    }
    allow.push({
      host,
      ...(methods.size > 0 ? { methods: [...methods].sort() } : {}),
      ...(prefixes.size > 0 ? { pathPrefixes: [...prefixes].sort() } : {}),
      credentialInjected,
    });
  }
  return { defaultAction: "deny", allow };
}

export function renderEgressStatus(input: EgressStatusInput): string {
  const summary = summariseEgressPolicy(input.policy);
  return `${JSON.stringify(
    {
      enforcement: input.state,
      defaultAction: summary.defaultAction,
      policyFingerprint: input.fingerprint,
      compileError: input.compileError,
      allow: summary.allow,
      readme: `./${EGRESS_README_PATH.split("/").pop()}`,
    },
    null,
    2,
  )}\n`;
}

export const EGRESS_README = `# Egress from this sandbox

Network access out of this sandbox is **default-deny**. Only the hosts listed in
\`STATUS.json\` (beside this file) are reachable; everything else fails at the firewall,
before it reaches the network.

Read \`STATUS.json\` first. It carries the enforcement state, every allowed host with any
method/path narrowing on it, and \`policyFingerprint\` — the id of the exact policy in force.

## If a request was blocked

**Do not retry it, and do not try to route around it.** A denial here is policy, not an
outage: a retry, a mirror, a proxy, a different port and a different DNS name all fail the
same way, and the only thing they cost is your turn. Nothing about the block is transient.

**Report it instead**, in your answer, naming the host you needed and what you needed it
for. That report matters more than it looks: the policy that denied you is on the record —
an \`egress.policy\` audit row carries the \`policyFingerprint\` above — but **the individual
blocked request is not**. The firewall denies out of band and Open Everywhere never sees the
attempt, so no automatic loop will ever notice it. (\`permission_fit_report\`, the loop that
does propose widenings, reads AWS and approval refusals; egress denials are not among them.)
Your report is the only signal that exists.

Widening is deliberately not something either of us can do at runtime: a reachable host is
config-as-code, and it changes by reviewed pull request against the bundle that grants it —
a \`domains\` entry for an uncredentialed host, or a connection's \`allowedWebsites\` for a
credentialed one. It then lands on the session's next turn.

## Two things that will save you a wrong guess

**Never add an \`Authorization\` header yourself.** Where \`credentialInjected\` is true in
\`STATUS.json\`, the firewall stamps the credential onto the request as it leaves. You do not
hold that secret and cannot read it — that is the design, not a gap. A 401 from such a host
means the credential is wrong or expired upstream, so report it; do not go looking for a key.

**\`web_fetch\` and \`web_search\` do not run in here.** They execute host-side, outside this
sandbox. That changes WHO enforces, not WHAT is allowed: \`web_fetch\` is fenced against this
same allow-list before it dispatches, so a host absent from \`STATUS.json\` is refused there
too — audibly, naming the host, unlike the silent failure you get in here. \`web_search\` runs
inside the model call and is bounded by neither. This file describes commands **you** run in
this sandbox: \`curl\`, \`git\`, \`npm\`, and anything else you shell out to.

## If \`enforcement\` is not "enforced"

\`dry-run\` means the intended policy was computed but not applied (\`OE_EGRESS_ENFORCE=0\`);
\`unenforced\` means the backend refused it and the operator accepted that. In both cases the
list is what the operator INTENDS you to reach. Stay inside it, and say so if you notice you
did not have to.
`;

export interface EgressStatusSandbox {
  writeTextFile(options: { path: string; content: string }): PromiseLike<unknown>;
  run(options: { command: string }): PromiseLike<unknown>;
}

export async function publishEgressStatus(sandbox: EgressStatusSandbox, input: EgressStatusInput): Promise<void> {
  await sandbox.run({ command: `${unlockCommand(EGRESS_DIR)} 2>/dev/null || true` });
  await sandbox.writeTextFile({ path: EGRESS_STATUS_PATH, content: renderEgressStatus(input) });
  await sandbox.writeTextFile({ path: EGRESS_README_PATH, content: EGRESS_README });
  await sandbox.run({ command: `${lockCommand(EGRESS_DIR)} 2>/dev/null || true` });
}
