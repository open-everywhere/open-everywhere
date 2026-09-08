export interface ApproverPolicyRow {
  readonly kind: string;
  readonly policy: "admin" | "member";
  readonly proposedBy?: string;
}

export interface AdminKindFamily {
  readonly prefix: string;
  readonly noun: string;
}

export const ADMIN_KIND_FAMILIES: readonly AdminKindFamily[] = [
  { prefix: "connector.", noun: "connector" },
  { prefix: "spend.", noun: "spend" },
  { prefix: "halt.", noun: "halt" },
];

const BEGIN = "<!-- BEGIN GENERATED: approver-policy (scripts/approver-policy-docs.ts) -->";
const END = "<!-- END GENERATED: approver-policy -->";

export const APPROVER_POLICY_BEGIN = BEGIN;
export const APPROVER_POLICY_END = END;

export const ADMIN_RULE_ANCHOR = "**Admin kinds are the org config, spend and break-glass mutations**";
export const MEMBER_RULE_ANCHOR = "**Every other kind is a member kind.**";

export function isAdminFamily(kind: string): boolean {
  return ADMIN_KIND_FAMILIES.some((f) => kind.startsWith(f.prefix));
}

function byKind(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function checkApproverPolicyRule(rows: readonly ApproverPolicyRow[]): string[] {
  if (rows.length === 0) {
    return [
      "no ActionKinds were enumerated — refusing to report clean against an empty plane, which would satisfy every rule below by containing nothing",
    ];
  }
  const families = ADMIN_KIND_FAMILIES.map((f) => f.prefix).join(", ");
  const problems: string[] = [];
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const row of rows) {
    if (seen.has(row.kind)) problems.push(`kind "${row.kind}" appears twice — one kind, one row`);
    seen.add(row.kind);
    if (previous !== undefined && byKind(row.kind, previous) < 0) {
      problems.push(`kind "${row.kind}" is out of order (after "${previous}") — the table must be sorted, or a re-run rewrites it`);
    }
    previous = row.kind;

    if (row.policy === "admin" && !isAdminFamily(row.kind)) {
      problems.push(
        `"${row.kind}" registers ApproverPolicy "admin" but is outside the admin family (${families}). ` +
          `The "Who can click" section states the split as a RULE — admin covers the org config/spend mutations, member covers the rest — ` +
          `and this kind makes that sentence false. Say what the new admin family is in the prose and add it to ADMIN_KIND_FAMILIES, or move the kind to the member policy`,
      );
    }
    if (row.policy === "member" && isAdminFamily(row.kind)) {
      problems.push(
        `"${row.kind}" is in the admin family (${families}) but registers ApproverPolicy "member" — ` +
          `the "Who can click" rule says every spend and connector write needs an admin. Either the kind's policy is wrong, or the rule has changed and the prose must say so`,
      );
    }
  }
  if (!rows.some((r) => r.policy === "admin")) {
    problems.push('no kind registers ApproverPolicy "admin" — the prose describes an admin policy that no longer exists, so the rule it states is no longer the code\'s');
  }
  if (!rows.some((r) => r.policy === "member")) {
    problems.push('no kind registers ApproverPolicy "member" — the prose describes a member policy that no longer exists, so the rule it states is no longer the code\'s');
  }
  return problems;
}

export function checkApproverPolicyProse(markdown: string): string[] {
  const problems: string[] = [];
  const count = (needle: string): number => markdown.split(needle).length - 1;

  for (const [label, anchor] of [
    ["admin", ADMIN_RULE_ANCHOR],
    ["member", MEMBER_RULE_ANCHOR],
  ] as const) {
    const n = count(anchor);
    if (n === 0) {
      problems.push(
        `the ${label} half of the "Who can click" rule is gone from the manual — no text matches ${JSON.stringify(anchor)}. ` +
          `The generated table below it says nothing about WHY the split falls where it does, so the rule has to be stated, not implied. ` +
          `Restore the sentence, or change ADMIN_RULE_ANCHOR/MEMBER_RULE_ANCHOR here if it was deliberately reworded`,
      );
    } else if (n > 1) {
      problems.push(`the ${label} half of the "Who can click" rule appears ${n} times — one statement, one place, or a later fix lands on one copy and misses the other`);
    }
  }
  if (problems.length > 0) return problems;

  const adminAt = markdown.indexOf(ADMIN_RULE_ANCHOR);
  const memberAt = markdown.indexOf(MEMBER_RULE_ANCHOR);
  if (memberAt < adminAt) {
    problems.push("the member half of the rule now comes BEFORE the admin half — the admin bullet is what names the families, and this check reads the text between them");
    return problems;
  }
  const adminBullet = markdown.slice(adminAt + ADMIN_RULE_ANCHOR.length, memberAt);
  for (const family of ADMIN_KIND_FAMILIES) {
    if (!adminBullet.includes(family.noun)) {
      problems.push(
        `the admin bullet no longer says "${family.noun}", but \`${family.prefix}*\` kinds still take the admin policy. ` +
          `A reader is told a narrower rule than the code runs, which is the defect OPE-1155 opened against`,
      );
    }
  }
  return problems;
}

export function sortApproverPolicyRows(rows: readonly ApproverPolicyRow[]): ApproverPolicyRow[] {
  return [...rows].sort((a, b) => byKind(a.kind, b.kind));
}

export function renderApproverPolicyTable(rows: readonly ApproverPolicyRow[]): string {
  const body = rows.map(
    (r) => `| \`${r.kind}\` | ${r.proposedBy === undefined ? "— *(no propose tool)*" : `\`${r.proposedBy}\``} | ${r.policy} |`,
  );
  return [BEGIN, "", "| Action kind | Propose tool | Who can click |", "|---|---|---|", ...body, "", END].join("\n");
}

export function spliceApproverPolicyTable(markdown: string, table: string): { readonly updated: string } | { readonly problem: string } {
  const beginAt = markdown.indexOf(BEGIN);
  const endAt = markdown.indexOf(END);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    return {
      problem:
        `the document is missing the generated-section markers. Expected a block delimited by:\n    ${BEGIN}\n    ${END}\n` +
        `  Re-add them where the approver-policy table should live — the generator owns everything between them.`,
    };
  }
  return { updated: markdown.slice(0, beginAt) + table + markdown.slice(endAt + END.length) };
}
