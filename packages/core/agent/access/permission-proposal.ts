import {
  MIN_TIGHTEN_OBSERVATIONS,
  MIN_TIGHTEN_WINDOW_DAYS,
  MIN_WIDEN_REFUSALS,
  entryCoversCommand,
  type AwsGrantUsage,
  type ConnectorGrantUsage,
  type ConnectorRefusalEvidence,
  type PermissionEvidence,
} from "./permission-evidence.js";

export const PERMISSION_CONFIG_FILE = "agent/access/bundles.ts";

export interface PermissionDiff {
  readonly file: string;
  readonly bundles: readonly string[];
  readonly path: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly text: string;
}

export interface PermissionProposal {
  readonly id: string;
  readonly direction: "widen" | "tighten";
  readonly subject: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly diff?: PermissionDiff;
  readonly remedy?: string;
}

function renderDiffText(path: string, bundles: readonly string[], before: readonly string[], after: readonly string[]): string {
  const head = `--- ${PERMISSION_CONFIG_FILE}  (bundle ${bundles.map((b) => JSON.stringify(b)).join(" | ")})`;
  const lines = [head, `@@ ${path} @@`];
  for (const entry of before) lines.push(`${after.includes(entry) ? " " : "-"}  ${JSON.stringify(entry)},`);
  for (const entry of after) if (!before.includes(entry)) lines.push(`+  ${JSON.stringify(entry)},`);
  return lines.join("\n");
}

function diff(bundles: readonly string[], path: string, before: readonly string[], after: readonly string[]): PermissionDiff {
  return { file: PERMISSION_CONFIG_FILE, bundles, path, before, after, text: renderDiffText(path, bundles, before, after) };
}

function awsAllowPath(roleArn: string): string {
  return `awsRoles[roleArn=${JSON.stringify(roleArn)}].allow`;
}

function widenProposals(ev: PermissionEvidence): PermissionProposal[] {
  const out: PermissionProposal[] = [];
  const awsUsage = new Map<string, AwsGrantUsage>();
  for (const u of ev.usage) if (u.kind === "aws-role") awsUsage.set(u.roleArn, u);

  for (const r of ev.refusals) {
    if (r.kind === "aws-allow-list") {
      if (r.refusals < MIN_WIDEN_REFUSALS) continue;
      const declared = awsUsage.get(r.roleArn);
      const before = declared?.allow ?? r.allow;
      const bundles = declared?.bundles ?? [];
      if (before.some((entry) => entryCoversCommand(entry, r.command))) continue;
      const after = [...before, r.iamEntry];
      out.push({
        id: `widen:aws:${r.roleArn}:${r.command}`,
        direction: "widen",
        subject: `AWS grant ${r.roleArn} — \`${r.command}\``,
        summary:
          `\`${r.command}\` (\`aws ${r.command.replace(":", " ")}\`) was refused ${r.refusals}× by this grant's host-side allow-list ` +
          `(${r.unattendedRefusals} of them on an unattended run). The allow-list does not cover it; the IAM role behind it may well.`,
        evidence: [
          `${r.refusals} \`aws.refused\` row(s) with reason \`allow-list\`, ${r.firstSeen} → ${r.lastSeen}.`,
          `${r.unattendedRefusals} of those had no human behind the turn.`,
          `Allow-list at refusal time: ${r.allow.length > 0 ? r.allow.map((a) => `\`${a}\``).join(", ") : "(none recorded)"}.`,
        ],
        diff: diff(bundles, awsAllowPath(r.roleArn), before, after),
        remedy:
          "Widening the allow-list re-permits only what the IAM role already allows — the screen can never widen past the role. " +
          "If the role itself lacks the action, the diff will merge and the command will still fail, in AWS, which is the right place for it to fail.",
      });
      continue;
    }

    if (r.kind === "egress-denied") {
      if (r.denials < MIN_WIDEN_REFUSALS) continue;
      const burst = r.windows === 1;
      out.push({
        id: `widen:egress:${r.host}`,
        direction: "widen",
        subject: `Egress to \`${r.host}\``,
        summary:
          `${r.denials} request(s) to \`${r.host}\` were refused by the egress firewall across ${r.windows} observation window(s)` +
          `${burst ? " — all inside ONE window, so this may be a single crash-loop rather than a standing need" : ""}. ` +
          `The host is not in this scope's compiled allow-list.`,
        evidence: [
          `${r.denials} denied request(s) in ${r.windows} \`egress.denied\` row(s), ${r.firstSeen} → ${r.lastSeen}.`,
          r.fingerprints.length > 1
            ? `Denied under ${r.fingerprints.length} distinct policy generations — the host stayed unreachable across a config change.`
            : `Policy generation: ${r.fingerprints[0] !== undefined ? `\`${r.fingerprints[0].slice(0, 12)}…\`` : "(not recorded)"}.`,
          `Host only: the firewall's log is reduced to a host and a count before it reaches the audit log, so there is no path, method or query string behind this — and no way to tell WHICH request wanted it. The worker's own report is still the place that detail comes from.`,
        ],
        remedy:
          `Not a mechanical diff, so none is offered. A reachable host is config-as-code in one of two places, and which one is the reviewer's call: add \`${r.host}\` to the bundle's \`domains\` if the call needs no credential, or to the relevant connection's \`allowedWebsites\` if the firewall should inject one. ` +
          `⚠ This evidence family only exists where the proxy is ours (the self-host egress tier, deploy/egress-proxy). On the Vercel tier the sandbox host denies out of band and NO row is written, so an empty egress section there means "not observed", never "nothing was blocked".`,
      });
      continue;
    }

    if (r.kind === "connector-refused") {
      const declared = ev.usage.some((u) => u.kind === "connector" && u.connector === r.connection);
      const reasonsSeen = r.reasons.map((x) => `${x.label} ×${x.count}`).join(", ");
      const opsSeen = r.ops.length > 0 ? r.ops.map((x) => `${x.label} ×${x.count}`).join(", ") : "(no op named — the grant gate refuses before one is)";
      if (r.ungranted >= MIN_WIDEN_REFUSALS && !declared) {
        out.push({
          id: `widen:connector:ungranted:${r.connection}`,
          direction: "widen",
          subject: `Connector \`${r.connection}\` — not granted to this scope`,
          summary:
            `${r.ungranted} operation(s) on \`${r.connection}\` were refused by the credential gate: the connection is not in this ` +
            `scope's granted set, and no bundle EFFECTIVE IN THIS SCOPE declares it. The work keeps arriving; the grant does not exist.`,
          evidence: [
            `${r.refusals} \`connector.refused\` row(s) for \`${r.connection}\`, ${r.firstSeen} → ${r.lastSeen}; ${r.ungranted} with reason \`ungranted\`.`,
            `Reasons: ${reasonsSeen}.`,
            `Ops: ${opsSeen}.`,
          ],
          remedy:
            `Not a mechanical diff, so none is offered — an ungranted connector is in none of the bundles effective in this scope, and the ` +
            `declaration needs a credential id that no refusal row carries. Add ` +
            `\`{ name: "${r.connection}", credential: "<id>", contentOrigin: "internal" | "external" }\` to the \`connectors\` array of a ` +
            `bundle bound to this scope in \`${PERMISSION_CONFIG_FILE}\`; the credential ids come from that connector's catalogue in ` +
            `\`agent/access/connector-credentials.ts\`. ⚠ A break-glass \`revoke_connector\` produces this same reason code from the ` +
            `override store, and no config edit defeats it — check the overrides before merging a widening.`,
        });
      }
      if (r.liftableUnattended >= MIN_WIDEN_REFUSALS && declared) {
        out.push({
          id: `widen:connector:unattended:${r.connection}`,
          direction: "widen",
          subject: `Connector \`${r.connection}\` — write ops on unattended runs`,
          summary:
            `${r.liftableUnattended} unattended \`write\`-tier operation(s) on \`${r.connection}\` were refused because an approval card ` +
            `has nobody to answer it. This scope holds the connector grant; what is missing is a standing permission for the fire.`,
          evidence: [
            `${r.refusals} \`connector.refused\` row(s) for \`${r.connection}\`, ${r.firstSeen} → ${r.lastSeen}; ${r.liftableUnattended} with reason \`ask-unattended\` at the \`write\` tier, a routine behind the turn AND no later row granting the permission.`,
            ...(r.unroutedUnattended > 0
              ? [
                  `${r.unroutedUnattended} further \`ask-unattended\`/\`write\` row(s) carried NO routine (a webhook or job wake, \`routine: null\`). They are NOT counted above, because a standing routine permission is not their actuator — there is no routine card to re-arm.`,
                ]
              : []),
            ...(r.armedSinceUnattended > 0
              ? [
                  `${r.armedSinceUnattended} further \`ask-unattended\`/\`write\` row(s) were followed by the permission ARRIVING — a \`connector.unattended_lift\` on the same op under the same ROUTINE, whatever generation of its instruction, so the refusal was already answered (the grant has since been armed, or it was there all along and a transient store read said otherwise). They are NOT counted above, and this proposal stands only on what is still unarmed.`,
                ]
              : []),
            `Reasons: ${reasonsSeen}.`,
            `Tiers: ${r.tiers.length > 0 ? r.tiers.map((x) => `${x.label} ×${x.count}`).join(", ") : "(none recorded)"}.`,
            `Ops: ${opsSeen}.`,
          ],
          remedy:
            `This one is NOT a config-file diff, so none is offered. The standing permission is a per-tool declared permission on the routine — a human tap on ` +
            `the routine's own card — not bundle config. Re-arm it with \`edit_routine\`/the creation card. ` +
            `⚠ Only the \`write\` tier is liftable: a \`destructive\` op and a TAINTED turn are never lifted by any grant ` +
            `(\`ask-unattended-tainted\` is its own reason code), so any of those rows in the counts above are a control working, not a gap.`,
        });
      }
      continue;
    }

    const unattendedReason = r.reasons.find((x) => x.label === "ask-unattended");
    if (unattendedReason === undefined || unattendedReason.count < MIN_WIDEN_REFUSALS) continue;
    out.push({
      id: `widen:unattended:${r.tool}`,
      direction: "widen",
      subject: `\`${r.tool}\` on unattended runs`,
      summary:
        `${unattendedReason.count} unattended run(s) were denied \`${r.tool}\` because an approval card has nobody to answer it. ` +
        `The work keeps arriving; the standing permission does not exist.`,
      evidence: [
        `${r.denies} \`approval.chain\` deny row(s) for \`${r.tool}\`, ${r.firstSeen} → ${r.lastSeen}; ${r.unattendedDenies} unattended.`,
        `Reasons: ${r.reasons.map((x) => `${x.label} ×${x.count}`).join(", ")}.`,
        `Decided by: ${r.resolvedBy.map((x) => `${x.label} ×${x.count}`).join(", ") || "(not recorded)"}.`,
        ...(r.domains.length > 0 ? [`Domains: ${r.domains.join(", ")}.`] : []),
      ],
      remedy:
        `This one is NOT a config-file diff, so none is offered. An unattended deny means the fire lacked a STANDING permission for ` +
        `\`${r.tool}\`, and standing permissions are armed by a human tap on the routine's own creation card (they are per-routine ` +
        `store rows, not bundle config). Re-arm it with \`edit_routine\`/the creation card, or — if this scope should never card ` +
        `\`${r.tool}\` at all — add an operator approver to the bundle's \`approvers\` in a reviewed PR, which IS a config diff but one ` +
        `only a human should author, because it changes policy for every caller in the scope rather than for one routine.`,
    });
  }
  return out;
}

function tightenAws(u: AwsGrantUsage): PermissionProposal | undefined {
  if (u.uses === 0) {
    return {
      id: `tighten:aws:${u.roleArn}`,
      direction: "tighten",
      subject: `AWS grant ${u.roleArn} — unused`,
      summary: `This scope may assume ${u.roleArn}, and did not, once, in the window — while other AWS calls were made. The grant is a standing capability nobody is using.`,
      evidence: [
        `0 \`aws.exec\` rows for this roleArn in the window.`,
        `Granted allow-list: ${u.allow.map((a) => `\`${a}\``).join(", ")}.`,
      ],
      diff: diff(u.bundles, `awsRoles[roleArn=${JSON.stringify(u.roleArn)}]`, u.allow, []),
      remedy: "Remove the whole `awsRoles` entry (the `allow` lines above are shown as the body being deleted, not as a narrowing to an empty list — an empty `allow` is a config error, never the tightened form).",
    };
  }
  if (u.allow.some((e) => e.trim() === "*") && u.services.length > 0) {
    const after = u.services;
    return {
      id: `tighten:aws:${u.roleArn}`,
      direction: "tighten",
      subject: `AWS grant ${u.roleArn} — unrestricted, narrowly used`,
      summary: `The grant is spelled \`["*"]\` (unrestricted) but ${u.uses} call(s) in the window touched only ${u.services.map((s) => `\`${s}\``).join(", ")}.`,
      evidence: [
        `${u.uses} \`aws.exec\` row(s); commands: ${u.commands.map((c) => `${c.label} ×${c.count}`).join(", ")}.`,
      ],
      diff: diff(u.bundles, awsAllowPath(u.roleArn), u.allow, after),
      remedy: "Narrowed to the SERVICES observed, not to the exact operations — service grain is the least likely to send the next ordinary call straight back through loop 1. Tighten further by hand if the operations are genuinely fixed.",
    };
  }
  if (u.unexercised.length > 0 && u.covering.length > 0) {
    return {
      id: `tighten:aws:${u.roleArn}`,
      direction: "tighten",
      subject: `AWS grant ${u.roleArn} — ${u.unexercised.length} unexercised allow entr${u.unexercised.length === 1 ? "y" : "ies"}`,
      summary: `${u.unexercised.map((e) => `\`${e}\``).join(", ")} covered nothing this scope ran in the window; ${u.covering.length} other entr${u.covering.length === 1 ? "y" : "ies"} carried all ${u.uses} call(s).`,
      evidence: [
        `${u.uses} \`aws.exec\` row(s); commands: ${u.commands.map((c) => `${c.label} ×${c.count}`).join(", ")}.`,
        `Coverage was tested with the live screen (\`awsCommandVerdict\`), one allow entry at a time — the same function that refuses a command at runtime.`,
      ],
      diff: diff(u.bundles, awsAllowPath(u.roleArn), u.allow, u.covering),
    };
  }
  return undefined;
}

function tightenConnector(u: ConnectorGrantUsage, refused: ConnectorRefusalEvidence | undefined): PermissionProposal | undefined {
  if (u.uses > 0) return undefined;
  const after = u.bundleConnectors.filter((c) => c !== u.connector);
  const reached = refused !== undefined && refused.refusals > 0;
  return {
    id: `tighten:connector:${u.bundle}:${u.connector}`,
    direction: "tighten",
    subject: reached ? `Connector \`${u.connector}\` — unused, but REFUSED ${refused.refusals}×` : `Connector \`${u.connector}\` — unused`,
    summary: reached
      ? `Bundle \`${u.bundle}\` grants \`${u.connector}\` and no operation on it SUCCEEDED in the window, while other connectors were used — ` +
        `but ${refused.refusals} operation(s) on it were REFUSED in the same window. This connection is being reached for, not sitting idle, so ` +
        `read the refusal reasons below before removing the grant.`
      : `Bundle \`${u.bundle}\` grants \`${u.connector}\` and no operation on it was recorded in the window, while other connectors were used.`,
    evidence: reached
      ? [
          `0 \`connector.op\` rows for \`${u.connector}\` in the window — a refused op writes \`connector.refused\`, never \`connector.op\`, so a wholly-refused connection reads as an idle one on this counter alone.`,
          `${refused.refusals} \`connector.refused\` row(s) for \`${u.connector}\`, ${refused.firstSeen} → ${refused.lastSeen}.`,
          `Reasons: ${refused.reasons.map((x) => `${x.label} ×${x.count}`).join(", ")}.`,
        ]
      : [`0 \`connector.op\` rows for \`${u.connector}\` in the window.`],
    diff: diff([u.bundle], "connectors", u.bundleConnectors, after),
    ...(reached
      ? {
          remedy:
            `Removing the grant is still a defensible call — a connection refused by a context wall and never otherwise used may be a grant nobody should hold. ` +
            `But decide it against the reasons above, not against the zero: a WIDTH reason (\`ungranted\`, or \`ask-unattended\` at the \`write\` tier) means the work is asking for MORE ` +
            `access to this connection, so removing the grant answers the opposite question from the one being asked. A context wall (\`dm_only\`, the disclosure gate's \`audience_floor\` and \`audience_unverified\` refusals, the member plane) ` +
            `is a control no grant can open, so those refusals say nothing about whether the grant is wanted.`,
        }
      : {}),
  };
}

function tightenProposals(ev: PermissionEvidence): PermissionProposal[] {
  const out: PermissionProposal[] = [];
  if (ev.window.days < MIN_TIGHTEN_WINDOW_DAYS) return out;
  const refusedByConnection = new Map<string, ConnectorRefusalEvidence>();
  for (const r of ev.refusals) if (r.kind === "connector-refused") refusedByConnection.set(r.connection, r);
  for (const u of ev.usage) {
    if (u.kind === "aws-role") {
      if (ev.activity.awsExec < MIN_TIGHTEN_OBSERVATIONS) continue;
      const p = tightenAws(u);
      if (p !== undefined) out.push(p);
    } else {
      if (ev.activity.connectorOps < MIN_TIGHTEN_OBSERVATIONS) continue;
      const p = tightenConnector(u, refusedByConnection.get(u.connector));
      if (p !== undefined) out.push(p);
    }
  }
  return out;
}

export type ProposalDirection = "both" | "widen" | "tighten";

export function proposePermissionChanges(ev: PermissionEvidence, direction: ProposalDirection = "both"): readonly PermissionProposal[] {
  return [
    ...(direction === "tighten" ? [] : widenProposals(ev)),
    ...(direction === "widen" ? [] : tightenProposals(ev)),
  ];
}

export function renderPermissionProposals(ev: PermissionEvidence, proposals: readonly PermissionProposal[]): string {
  const lines: string[] = [];
  lines.push(`Permission fit — ${ev.window.since} → ${ev.window.until} (${ev.window.days}d)`);
  lines.push(
    `evidence: ${ev.rowsConsidered} audit row(s) in window · ${ev.activity.awsExec} aws execution(s) · ` +
      `${ev.activity.connectorOps} connector op(s) · ${ev.activity.chainResolutions} approval-chain resolution(s) · ` +
      `${ev.activity.egressDenialRows} egress-denial row(s)`,
  );
  lines.push(`grants examined: ${ev.usage.length} · refusal clusters: ${ev.refusals.length}`);
  lines.push("");

  if (proposals.length === 0) {
    lines.push("No proposals.");
    if (ev.rowsConsidered === 0) {
      lines.push("Nothing was recorded in this window at all — that is an absence of evidence, not evidence that the grants fit.");
    } else if (ev.window.days < MIN_TIGHTEN_WINDOW_DAYS) {
      lines.push(`Tightening was not evaluated: the window is shorter than the ${MIN_TIGHTEN_WINDOW_DAYS}-day floor.`);
    } else {
      lines.push("Grants that were exercised drew no refusals, and nothing granted went unused against enough activity to say so.");
    }
    lines.push("");
    lines.push("Nothing here gates anything: this is a scan, and every proposal it can make is a config PR a human merges.");
    return lines.join("\n");
  }

  for (const p of proposals) {
    lines.push(`[${p.direction.toUpperCase()}] ${p.subject}`);
    lines.push(`  ${p.summary}`);
    for (const e of p.evidence) lines.push(`  · ${e}`);
    if (p.diff !== undefined) {
      lines.push("  proposed config change:");
      for (const l of p.diff.text.split("\n")) lines.push(`    ${l}`);
    }
    if (p.remedy !== undefined) lines.push(`  note: ${p.remedy}`);
    lines.push("");
  }
  lines.push("Every proposal above is TEXT. The actuator is a reviewed pull request against the config repo — nothing changed, and nothing is gated on your reading this.");
  return lines.join("\n");
}
