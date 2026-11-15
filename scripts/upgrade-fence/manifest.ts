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
      "The access plane itself — the bundle resolver, capability sets, the untrusted-content envelope, the seat shape, " +
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
      "A per-binding capability expansion (OPE-1024) is a guardrail change, not an upgrade; an upgrade that " +
      "edits this file is exactly the path that property forbids.",
  },
  {
    id: "merge-gate-surface",
    paths: [
      "scripts/deploy/",
      "scripts/deploy-ci-gate-test.ts",
      "scripts/deploy-cloud-proof-verify-test.ts",
      "scripts/deploy-cloud-proof-post-test.ts",
      ".github/CODEOWNERS",
    ],
    why:
      "Everything that decides whether a change may merge. `scripts/deploy/` holds the enforcement scripts — the CI gate, " +
      "and the cloud-proof verify and post that decide whether a run proved anything. The three " +
      "`scripts/deploy-*-test.ts` entries are those enforcers' own proving suites (OPE-1174), named by exact path because " +
      "they sit at `scripts/` root, outside the prefix. A test rides with its enforcer for the reason security-lint-drivers " +
      "gives below: a neutered test reports a clean scan. `.github/CODEOWNERS` is inert while the repo has no branch " +
      "protection, and becomes a merge gate once a branch rule requires code-owner review. The post-deploy suites stay OUT — they gate a deploy, " +
      "not a merge.",
  },
  {
    id: "the-fence-itself",
    paths: [
      "scripts/upgrade-fence/",
      "scripts/upgrade-diff-fence.ts",
      "scripts/upgrade-diff-fence-test.ts",
      "scripts/deploy-merge-fence-test.ts",
      "scripts/deploy-merge-attest-test.ts",
    ],
    why:
      "This fence: the judgement, its driver, and the three suites that hold it up. An upgrade that may rewrite its own fence has no fence. " +
      "The RUNNERS (scripts/deploy/merge-fence*.ts and scripts/deploy/merge-attest*.ts) are covered by merge-gate-surface above; the suites are " +
      "named here by exact path because they sit at `scripts/` root, outside that prefix. scripts/deploy-merge-fence-test.ts is what proves the " +
      "in-session rung is REACHED — delete it and its chain leg and nothing reds, after which the rung itself can be dropped with no suite left " +
      "to notice (OPE-1172). scripts/deploy-merge-attest-test.ts does the same for the out-of-session attestation, which is the rung that makes " +
      "the fence's verdict visible on the pull request head at all (OPE-1182).",
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
