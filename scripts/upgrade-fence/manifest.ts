import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ProtectedPathRule {
  readonly id: string;
  readonly paths: readonly string[];
  readonly why: string;
}

export const PROTECTED_PATH_RULES: readonly ProtectedPathRule[] = [
  {
    id: "core-access-plane",
    paths: ["packages/core/agent/access/"],
    why:
      "The access plane itself — the bundle resolver, capability sets, taint tiers, the seat shape, " +
      "the egress fence and the human-only-invariants manifest. An edit here changes what the agent may reach.",
  },
  {
    id: "core-approvals-plane",
    paths: ["packages/core/agent/approvals/"],
    why:
      "The approvals plane — the gate that requires a human. session-grant.ts alone decides which " +
      "pending kinds may carry a standing grant, so an edit here can make a new action ungated.",
  },
  {
    id: "core-audit-chain",
    paths: ["packages/core/agent/audit/"],
    why: "The hash-chained audit record. An edit here changes what evidence exists that the agent did anything.",
  },
  {
    id: "github-permission-sets",
    paths: ["packages/core/agent/scm/mint.ts"],
    why:
      "The GitHub installation-token mint bodies. A mint narrows to its request body, so these " +
      "constants decide what the agent's own credential may do — including the write set the pull-request flow uses.",
  },
  {
    id: "deployment-access-config",
    paths: ["agent/access/"],
    why:
      "The operator's own hand-written access config — bundles, grants, credential bindings, network access. " +
      "A per-binding capability expansion (OPE-1024) is deliberately reachable ONLY from a hand-written config " +
      "pull request; an upgrade that edits this file would be exactly the path that property forbids.",
  },
  {
    id: "ci-workflows",
    paths: [".github/workflows/"],
    why: "Every CI gate, this fence included. A diff here can disarm the thing that is judging it.",
  },
  {
    id: "the-fence-itself",
    paths: ["scripts/upgrade-fence/", "scripts/upgrade-diff-fence.ts", "scripts/upgrade-diff-fence-test.ts"],
    why: "This fence. An upgrade that may rewrite its own fence has no fence.",
  },
  {
    id: "security-lint-drivers",
    paths: [
      "scripts/human-only-invariants-lint.ts",
      "scripts/access-lint.ts",
      "scripts/consequence-lint.ts",
      "scripts/window-gate-lint.ts",
      "scripts/source-gate-lint.ts",
      "scripts/principal-gate-lint.ts",
    ],
    why:
      "The drivers of the security lints whose manifests live in the access plane above. The manifest is " +
      "protected but the driver that reads it is not, and a neutered driver reports a clean scan.",
  },
];

export const UPGRADE_MARKER_RE = /^[ \t]*oe-upgrade:[ \t]*\S/im;

export function checkManifestPaths(root: string): string[] {
  const missing: string[] = [];
  for (const rule of PROTECTED_PATH_RULES) {
    for (const p of rule.paths) {
      const onDisk = join(root, p.endsWith("/") ? p.slice(0, -1) : p);
      if (!existsSync(onDisk)) missing.push(`${rule.id}: ${p}`);
    }
  }
  return missing;
}
