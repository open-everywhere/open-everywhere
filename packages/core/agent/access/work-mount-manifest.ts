export interface WorkToolFile {
  readonly name: string;
  readonly source: string;
}

export type WorkMountVia = "grant" | "grant-or-source" | "grant-and-source";

export interface WorkMountRule {
  readonly connector: string;
  readonly via: WorkMountVia;
}

export const WORK_TOOL_MOUNTS: Readonly<Record<string, WorkMountRule>> = {
  notion_search: { connector: "notion", via: "grant" },
  read_notion_page: { connector: "notion", via: "grant-or-source" },
  read_linear_issue: { connector: "linear", via: "grant-or-source" },
  checkout_repo: { connector: "github", via: "grant" },
  open_pull_request: { connector: "github", via: "grant" },
  check_pr_status: { connector: "github", via: "grant" },
  get_pr_feedback: { connector: "github", via: "grant" },
  walk_pr: { connector: "github", via: "grant" },
  post_pr_walkthrough: { connector: "github", via: "grant" },
  subscribe_pr: { connector: "github", via: "grant" },
  read_work_channel: { connector: "*", via: "grant-and-source" },
  read_work_thread: { connector: "*", via: "grant-and-source" },
  create_ticket: { connector: "*", via: "grant" },
  set_state: { connector: "*", via: "grant" },
  assign: { connector: "*", via: "grant" },
  add_label: { connector: "*", via: "grant" },
};

export const WORK_MOUNT_GAPS: Readonly<Record<string, string>> = {};

const WORK_SIGNAL = new RegExp(
  [
    "\\brepoAllowed\\b",
    "\\bworkDestinationPlatforms\\b",
    "\\b[A-Za-z]+WorkMount\\b",
    "\\bnotionWorkGrant\\b",
    "\\bnotionWorkCredential\\b",
    "\\blinearWorkOrg\\b",
    "\\bworkGrantCredential\\b",
    "\\bhasWorkGrant\\b",
    "\\bhasGithubWorkGrant\\b",
    "\\bcallerWorkGrant\\b",
    "\\bsurfaceWorkReadMount\\b",
    "\\bassertSurfaceWorkGrant\\b",
  ].join("|"),
  "u",
);

export function isWorkTool(source: string): boolean {
  return WORK_SIGNAL.test(source);
}

function grantMountPredicate(connector: string): string {
  return `${connector}WorkMount`;
}

function namesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`, "u").test(source);
}

function mountsOnUnion(source: string, connector: string): boolean {
  if (connector === "*") return false;
  return namesIdentifier(source, grantMountPredicate(connector)) && namesIdentifier(source, "sourceScopedMount");
}

function mountsOnIntersection(source: string): boolean {
  return namesIdentifier(source, "surfaceWorkReadMount") && namesIdentifier(source, "assertSurfaceWorkGrant");
}

export function checkWorkMounts(
  tools: readonly WorkToolFile[],
  mounts: Readonly<Record<string, WorkMountRule>> = WORK_TOOL_MOUNTS,
  gaps: Readonly<Record<string, string>> = WORK_MOUNT_GAPS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const rule = mounts[tool.name];
    const gap = gaps[tool.name];

    if (rule !== undefined && gap !== undefined) {
      problems.push(
        `tool "${tool.name}" is in BOTH WORK_TOOL_MOUNTS and WORK_MOUNT_GAPS — a work tool either mounts on the grant or is a declared gap, never both`,
      );
    }

    if (rule !== undefined) {
      seen.add(tool.name);
      if (!isWorkTool(tool.source)) {
        problems.push(
          `tool "${tool.name}" is declared in WORK_TOOL_MOUNTS but its source names no work-plane symbol — either it stopped doing provider work (drop the row) or the totality signature missed it`,
        );
      }
      if (rule.via === "grant") {
        if (rule.connector === "*") {
          if (!namesIdentifier(tool.source, "workDestinationPlatforms")) {
            problems.push(
              `tool "${tool.name}" declares via:"grant" with connector:"*" but never names workDestinationPlatforms — a neutral work verb mounts on the GRANT SET (channels/work-destinations.ts), which is the connector-less spelling of the same rule`,
            );
          }
        } else if (!namesIdentifier(tool.source, grantMountPredicate(rule.connector))) {
          problems.push(
            `tool "${tool.name}" declares via:"grant" but its source never names ${grantMountPredicate(rule.connector)} — a grant-only work tool MUST decide its mount with the connector's grant predicate (access/work-grant.ts), not grain and not topology`,
          );
        }
        if (namesIdentifier(tool.source, "sourceScopedMount")) {
          problems.push(
            `tool "${tool.name}" declares via:"grant" but also mounts through sourceScopedMount — chat presence is never a precondition NOR a widening for a work-credential-only tool (OPE-928). Either drop the sources path or reclassify the row via:"grant-or-source"`,
          );
        }
      } else if (rule.via === "grant-and-source") {
        if (!mountsOnIntersection(tool.source)) {
          problems.push(
            `tool "${tool.name}" declares via:"grant-and-source" but its source does not name BOTH surfaceWorkReadMount (the mount) and assertSurfaceWorkGrant (the per-turn check) — a container-fenced work read needs the grant at mount AND on the turn's own platform`,
          );
        }
        if (namesIdentifier(tool.source, "workDestinationPlatforms")) {
          problems.push(
            `tool "${tool.name}" declares via:"grant-and-source" but names workDestinationPlatforms — that predicate is the GRANT SET alone, so it would arm this verb on every granted connector regardless of which one this window actually sources`,
          );
        }
      } else if (!mountsOnUnion(tool.source, rule.connector)) {
        problems.push(
          `tool "${tool.name}" declares via:"grant-or-source" but its source does not name the pair (${grantMountPredicate(rule.connector)} + sourceScopedMount) — since OPE-953 that is the ONE spelling of this class: the container read OR the grant. workDestinationPlatforms is the GRANT SET now and carries no chat arm, so it cannot stand in for the pair`,
        );
      }
      continue;
    }

    if (gap !== undefined) {
      seen.add(tool.name);
      if (!/^OPE-\d+$/u.test(gap)) {
        problems.push(`tool "${tool.name}" is a WORK_MOUNT_GAPS row whose value "${gap}" is not a ticket id (expected OPE-<number>)`);
      }
      if (!namesIdentifier(tool.source, "repoAllowed")) {
        problems.push(
          `tool "${tool.name}" is a WORK_MOUNT_GAPS row but no longer names repoAllowed — a gap row is tolerated ONLY while the execute fence still refuses. Give it a grant mount and move it to WORK_TOOL_MOUNTS`,
        );
      }
      continue;
    }

    if (isWorkTool(tool.source)) {
      problems.push(
        `tool "${tool.name}" does provider WORK (its source names a work-plane symbol) but appears in neither WORK_TOOL_MOUNTS nor WORK_MOUNT_GAPS — classify it: a work tool's mount comes from the caller's work grant (access/work-grant.ts)`,
      );
    }
  }

  for (const name of [...Object.keys(mounts), ...Object.keys(gaps)]) {
    if (!seen.has(name)) {
      problems.push(`"${name}" is declared in the work-mount manifest but no tool file of that name was scanned — stale row (rename or delete it)`);
    }
  }

  return problems;
}
