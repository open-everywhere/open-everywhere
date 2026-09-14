import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export type CapabilityDeclaration =
  | "supported"
  | { readonly supported: string }
  | { readonly unsupported: string };

export type CapabilityGroup = "seam" | "shape" | "verb";

export interface SurfaceCapability {
  readonly id: string;
  readonly label: string;
  readonly section: string;
  readonly group: CapabilityGroup;
}

export const SURFACE_CAPABILITIES = [
  { id: "identity-mapper", label: "Identity mapper", section: "§2.1", group: "seam" },
  { id: "capability-manifest", label: "Capability manifest", section: "§2.4", group: "seam" },
  { id: "post-arm", label: "Post arm", section: "§4.1", group: "seam" },
  { id: "wake-origin-codec", label: "Wake-origin codec", section: "§2.3", group: "seam" },
  { id: "read-adapter", label: "Read adapter", section: "§4.5", group: "seam" },
  { id: "reaction-feedback-ingest", label: "Reaction **feedback** ingest", section: "§4.9", group: "seam" },
  { id: "ancillary-ops", label: "Ancillary ops (`SurfaceMessageOps`)", section: "§5", group: "seam" },
  { id: "ambient-engagement-seam", label: "**Ambient engagement seam**", section: "§2.5", group: "seam" },
  { id: "engaged-row-promotion", label: "**Engaged wake row promotion** (`thread-follow`)", section: "§2.5", group: "seam" },
  { id: "owned-thread-ingress", label: "**Owned-thread ingress divert**", section: "§2.6", group: "seam" },
  { id: "seat-catch-up", label: "**Seat catch-up read** (since last wake)", section: "§2.5", group: "seam" },

  { id: "addressed-leg", label: "Addressed (@mention) leg", section: "§2.2", group: "shape" },
  { id: "ambient-leg", label: "Ambient (non-mention) leg", section: "§2.5", group: "shape" },
  { id: "name-drop-mention", label: "Name-drop / structured mention", section: "§2.5", group: "shape" },
  { id: "message-edit-wake", label: "Message-EDIT wake", section: "§2.5", group: "shape" },
  { id: "threads", label: "Threads", section: "§4.6", group: "shape" },
  { id: "rooms", label: "Standing rooms *(not §4.5's `read_channel` container)*", section: "§4.7.1", group: "shape" },
  { id: "dm", label: "DM (`dm`)", section: "§4.7.2", group: "shape" },
  { id: "mpim", label: "Group DM (`mpim`)", section: "§4.7.2", group: "shape" },

  { id: "reply", label: "`reply`", section: "§4.1", group: "verb" },
  { id: "edit_reply", label: "`edit_reply`", section: "§4.2", group: "verb" },
  { id: "react", label: "`react`", section: "§4.3", group: "verb" },
  { id: "no_reply", label: "`no_reply`", section: "§4.4", group: "verb" },
  { id: "read_channel", label: "`read_channel`", section: "§4.5", group: "verb" },
  { id: "read_thread", label: "`read_thread`", section: "§4.6", group: "verb" },
  { id: "search", label: "`search`", section: "§4.7", group: "verb" },
  { id: "post_message", label: "`post_message` (P1)", section: "§4.7.1", group: "verb" },
  { id: "dm_person", label: "`dm_person` (P2)", section: "§4.7.2", group: "verb" },
  { id: "set_dm_delivery", label: "`set_dm_delivery` (P2, recipient)", section: "§4.7.2", group: "verb" },
  { id: "stop", label: "`stop` (human)", section: "§4.8", group: "verb" },
  { id: "ack_stop_glyph", label: "`ack`: ✋ glyph", section: "§4.9", group: "verb" },
  { id: "ack_cancel_note", label: "`ack`: cancel note", section: "§4.9", group: "verb" },
  { id: "stand_down", label: "`stand_down`", section: "§4.10", group: "verb" },
  { id: "post_file", label: "`post_file`", section: "§7.4", group: "verb" },
] as const satisfies readonly SurfaceCapability[];

export type SurfaceCapabilityId = (typeof SURFACE_CAPABILITIES)[number]["id"];

export type SurfaceParityDeclaration = {
  readonly [K in SurfaceCapabilityId]: CapabilityDeclaration;
};

const BY_ID: ReadonlyMap<string, SurfaceCapability> = new Map(SURFACE_CAPABILITIES.map((c) => [c.id, c]));

const DECLARATIONS = processRegistryMap<SurfaceParityDeclaration>("surface-parity.v1");

export function registerSurfaceParity(platform: string, declaration: SurfaceParityDeclaration): void {
  if (!admitProviderRegistration(platform, "surface-parity")) return;
  DECLARATIONS.set(platform, declaration);
}

export function surfaceParityFor(platform: string): SurfaceParityDeclaration | undefined {
  return DECLARATIONS.get(platform);
}

export function registeredSurfaceParityPlatforms(): readonly string[] {
  return [...DECLARATIONS.keys()].sort();
}

export function isSupported(cell: CapabilityDeclaration): boolean {
  return cell === "supported" || (typeof cell === "object" && "supported" in cell);
}

export function declarationNote(cell: CapabilityDeclaration): string | undefined {
  if (cell === "supported") return undefined;
  return "supported" in cell ? cell.supported : cell.unsupported;
}

export interface ParityProblem {
  readonly platform: string;
  readonly capability?: string;
  readonly message: string;
}

export type CapabilityProbe = ReadonlyMap<string, ReadonlySet<string>>;

function isDeclarationShape(value: unknown): value is CapabilityDeclaration {
  if (value === "supported") return true;
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const only = keys[0];
  if (only !== "supported" && only !== "unsupported") return false;
  return typeof (value as Record<string, unknown>)[only] === "string";
}

export function checkSurfaceParity(
  declarations: ReadonlyMap<string, unknown>,
  probes: CapabilityProbe = new Map(),
): readonly ParityProblem[] {
  const problems: ParityProblem[] = [];

  for (const platform of [...declarations.keys()].sort()) {
    const declared = declarations.get(platform);
    if (typeof declared !== "object" || declared === null) {
      problems.push({
        platform,
        message: `declared a surface-parity value that is not an object (got ${typeof declared}).`,
      });
      continue;
    }
    const rows = declared as Record<string, unknown>;

    for (const capability of SURFACE_CAPABILITIES) {
      const cell = rows[capability.id];

      if (cell === undefined) {
        problems.push({
          platform,
          capability: capability.id,
          message:
            `does not declare \`${capability.id}\` (${capability.label}, ${capability.section}). ` +
            `Every capability the contract names must be answered \`"supported"\` or ` +
            `\`{ unsupported: "<reason>" }\` — an unanswered row is an invisible gap.`,
        });
        continue;
      }

      if (!isDeclarationShape(cell)) {
        problems.push({
          platform,
          capability: capability.id,
          message:
            `declares \`${capability.id}\` as a value that is not a capability declaration. ` +
            `Use \`"supported"\`, \`{ supported: "<note>" }\`, or \`{ unsupported: "<reason>" }\`.`,
        });
        continue;
      }

      const note = declarationNote(cell);
      if (note !== undefined && note.trim() === "") {
        const kind = isSupported(cell) ? "supported" : "unsupported";
        problems.push({
          platform,
          capability: capability.id,
          message:
            `declares \`${capability.id}\` as \`{ ${kind}: "" }\` — an empty ${kind === "supported" ? "note" : "reason"}. ` +
            (kind === "unsupported"
              ? "Name the platform limit, or the ticket that closes the gap."
              : "Say what the caveat is, or declare a bare `\"supported\"`."),
        });
        continue;
      }

      const probe = probes.get(capability.id);
      if (probe === undefined) continue;
      const wired = probe.has(platform);
      const claims = isSupported(cell);
      if (claims && !wired && cell === "supported") {
        problems.push({
          platform,
          capability: capability.id,
          message:
            `declares \`${capability.id}\` supported, but the code registers no such arm for this platform. ` +
            `Either wire it, declare \`{ unsupported: "<reason>" }\`, or — if it is wired somewhere this probe ` +
            `does not look — say where with \`{ supported: "<note>" }\`.`,
        });
      } else if (!claims && wired) {
        problems.push({
          platform,
          capability: capability.id,
          message:
            `declares \`${capability.id}\` unsupported ("${note ?? ""}"), but the code DOES register that arm ` +
            `for this platform. The gap closed and the declaration was not updated — update it, and the ` +
            `generated table follows.`,
        });
      }
    }

    for (const id of Object.keys(rows).sort()) {
      if (!BY_ID.has(id)) {
        problems.push({
          platform,
          capability: id,
          message: `declares \`${id}\`, which is not a capability in SURFACE_CAPABILITIES. Renamed, or a typo?`,
        });
      }
    }
  }

  return problems;
}

function escapeCell(text: string): string {
  return text.replace(/\s*\n\s*/gu, " ").replace(/\|/gu, "\\|");
}

function renderCell(cell: CapabilityDeclaration): string {
  if (cell === "supported") return "✅";
  if ("supported" in cell) return `✅ ${escapeCell(cell.supported)}`;
  return `❌ ${escapeCell(cell.unsupported)}`;
}

export function renderParityTable(
  group: CapabilityGroup,
  declarations: ReadonlyMap<string, SurfaceParityDeclaration>,
  platforms: readonly string[],
): string {
  const rows = SURFACE_CAPABILITIES.filter((c) => c.group === group);
  const header = `| Capability | ${platforms.join(" | ")} |`;
  const rule = `|---|${platforms.map(() => "---").join("|")}|`;
  const body = rows.map((c) => {
    const cells = platforms.map((p) => {
      const declared = declarations.get(p);
      if (declared === undefined) return "⚠️ no declaration";
      return renderCell(declared[c.id as SurfaceCapabilityId]);
    });
    return `| ${c.label} ${c.section} | ${cells.join(" | ")} |`;
  });
  return [header, rule, ...body].join("\n");
}

export function renderParityMatrix(
  declarations: ReadonlyMap<string, SurfaceParityDeclaration>,
  platforms: readonly string[],
): string {
  const labelWidth = Math.max(...SURFACE_CAPABILITIES.map((c) => c.id.length), "capability".length);
  const colWidth = Math.max(...platforms.map((p) => p.length), 3);
  const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));

  const lines: string[] = [];
  lines.push(`${pad("capability", labelWidth)}  ${platforms.map((p) => pad(p, colWidth)).join("  ")}`);
  lines.push(`${"-".repeat(labelWidth)}  ${platforms.map(() => "-".repeat(colWidth)).join("  ")}`);

  let group: CapabilityGroup | undefined;
  let gaps = 0;
  for (const c of SURFACE_CAPABILITIES) {
    if (c.group !== group) {
      group = c.group;
      lines.push(`[${group}]`);
    }
    const cells = platforms.map((p) => {
      const declared = declarations.get(p);
      if (declared === undefined) return pad("?", colWidth);
      const cell = declared[c.id as SurfaceCapabilityId];
      if (!isSupported(cell)) gaps += 1;
      return pad(isSupported(cell) ? (cell === "supported" ? "yes" : "yes*") : "NO", colWidth);
    });
    lines.push(`${pad(c.id, labelWidth)}  ${cells.join("  ")}`);
  }
  lines.push("");
  lines.push(
    `${SURFACE_CAPABILITIES.length} capabilities × ${platforms.length} surfaces = ` +
      `${SURFACE_CAPABILITIES.length * platforms.length} cells; ${gaps} declared unsupported ` +
      `(yes* = supported with a stated caveat).`,
  );
  return lines.join("\n");
}
