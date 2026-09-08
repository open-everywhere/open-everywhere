export type SurfaceKind = "slack" | "discord" | "teams" | "github" | "linear" | "notion";

export const SURFACE_ORDER: readonly SurfaceKind[] = ["slack", "discord", "teams", "github", "linear", "notion"];

export const SURFACE_LABEL: Readonly<Record<SurfaceKind, string>> = {
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  github: "GitHub",
  linear: "Linear",
  notion: "Notion",
};

export interface RoomVarSpec {
  readonly surface: SurfaceKind;
  readonly envVar: string;
  readonly what: string;
  readonly expectUnclaimed?: string;
  readonly neverProbe?: string;
  readonly ownedBy?: string;
}

export const ROOM_VARS: readonly RoomVarSpec[] = [
  { surface: "slack", envVar: "E2E_SLACK_CHANNEL", what: "the base driver channel — nearly every Slack scenario" },
  { surface: "slack", envVar: "E2E_SLACK_PRIVATE_CHANNEL", what: "S11's private surface" },
  { surface: "slack", envVar: "E2E_SLACK_CHANNEL_B", what: "S12's second-domain channel (silo isolation)" },
  { surface: "slack", envVar: "E2E_SLACK_DM_CHANNEL", what: "the driver-user↔OE DM (S13/S14/J4)" },
  { surface: "slack", envVar: "E2E_SLACK_SUPERVISOR_CHANNEL", what: "J-SUP's ambient-supervisor channel" },
  { surface: "slack", envVar: "E2E_SLACK_CAP_CHANNEL", what: "S10's throwaway spend-cap scope" },
  { surface: "slack", envVar: "E2E_NOTION_CHANNEL", what: "S24's Notion-connector-bound channel" },
  { surface: "slack", envVar: "E2E_SLACK_UNIFIED_CHANNEL_A", what: "J-UNIFIED container A" },
  { surface: "slack", envVar: "E2E_SLACK_UNIFIED_CHANNEL_B", what: "J-UNIFIED container B" },
  { surface: "slack", envVar: "E2E_SLACK_SOAK_CHANNEL_DEV", what: "the soak tests' #oe-soak-dev" },
  { surface: "slack", envVar: "E2E_SLACK_SOAK_CHANNEL_OPS", what: "the soak tests' #oe-soak-ops" },

  { surface: "discord", envVar: "E2E_DISCORD_CHANNEL", what: "the Discord driver's test channel" },

  {
    surface: "teams",
    envVar: "E2E_TEAMS_TEAM_ID",
    what: "the test team (a group id)",
    expectUnclaimed: "a TEAM, not a room — a domain names channels, never the team above them",
  },
  { surface: "teams", envVar: "E2E_TEAMS_CHANNEL_ID", what: "the test channel in that team (J-TEAMS)" },

  { surface: "github", envVar: "E2E_GITHUB_REPO", what: "J-GH's ambient fixture repo" },
  { surface: "github", envVar: "E2E_PR_REPO", what: "J-PR / J-WORKFLOW's consequential PR target" },
  { surface: "github", envVar: "E2E_GITHUB_SOAK_REPO", what: "the soak tests' own repo (OPE-855)" },
  {
    surface: "github",
    envVar: "E2E_PR_UNGRANTED_REPO",
    what: "S-PR-BOUNDARY's negative control — a repo no bundle grants",
    expectUnclaimed: "S-PR-BOUNDARY proves the grant check REFUSES this repo, so no domain may claim it",
    neverProbe: "never probed — the refusal happens before any remote touch, so the driver PAT is not meant to reach this repo",
  },

  { surface: "linear", envVar: "E2E_LINEAR_TEAM_ID", what: "J-LIN's scratch team" },
  { surface: "linear", envVar: "E2E_SOAK_LINEAR_TEAM_ID", what: "the soak org's team (OPE-855)" },

  { surface: "notion", envVar: "E2E_NOTION_PAGE_ID", what: "J-NOT's ambient scratch page" },
  { surface: "notion", envVar: "E2E_NOTION_SOAK_PAGE_1", what: "the soak tests' spec page" },
  { surface: "notion", envVar: "E2E_NOTION_SOAK_PAGE_2", what: "the soak tests' late-recall page" },

  { surface: "github", envVar: "E2E_ADDRESSED_GITHUB_REPO", what: "J-ENGAGED-github's addressed-only repo — NOT E2E_PR_REPO, which names e2e-unified's e2e-scratch", ownedBy: "e2e-engaged" },
  { surface: "discord", envVar: "E2E_ADDRESSED_DISCORD_CHANNEL", what: "J-ENGAGED-discord's addressed-only channel", ownedBy: "e2e-engaged" },
  { surface: "teams", envVar: "E2E_ADDRESSED_TEAMS_SURFACE", what: "J-ENGAGED-teams's addressed-only channel — NOT E2E_TEAMS_CHANNEL_ID, which J-TEAMS drives", ownedBy: "e2e-engaged" },
  { surface: "linear", envVar: "E2E_ADDRESSED_LINEAR_TEAM_ID", what: "J-ENGAGED-linear's addressed-only team", ownedBy: "e2e-engaged" },
  { surface: "notion", envVar: "E2E_ADDRESSED_NOTION_PAGE_ID", what: "J-ENGAGED-notion's addressed-only page", ownedBy: "e2e-engaged" },
];

export type NonRoomReason =
  | "credential"
  | "identity"
  | "knob"
  | "local"
  | "not-a-room";

export const NON_ROOM_ENV: Readonly<Record<string, NonRoomReason>> = {
  E2E_SLACK_USER_TOKEN: "credential",
  E2E_SLACK_SECONDARY_TOKEN: "credential",
  E2E_DISCORD_DRIVER_TOKEN: "credential",
  E2E_TEAMS_REFRESH_TOKEN: "credential",
  E2E_TEAMS_CLIENT_ID: "credential",
  E2E_TEAMS_TENANT_ID: "credential",
  E2E_GITHUB_DRIVER_TOKEN: "credential",
  E2E_GITHUB_WEBHOOK_SECRET: "credential",
  E2E_LINEAR_API_KEY: "credential",
  E2E_LINEAR_WEBHOOK_SECRET: "credential",
  E2E_LINEAR_SOAK_DRIVER_KEY: "credential",
  E2E_NOTION_DRIVER_KEY: "credential",
  E2E_NOTION_WEBHOOK_SECRET: "credential",
  E2E_WEBHOOK_SECRET: "credential",
  SLACK_SIGNING_SECRET: "credential",

  E2E_SLACK_BOT_USER_ID: "identity",
  E2E_SLACK_ADMIN_USER_ID: "identity",
  E2E_SLACK_USER2_ID: "identity",
  E2E_SLACK_SECONDARY_USER_ID: "identity",
  E2E_DISCORD_BOT_USER_ID: "identity",
  E2E_DISCORD_GRANT_OWNER: "identity",
  E2E_TEAMS_BOT_APP_ID: "identity",
  E2E_GITHUB_APP_SLUG: "identity",
  E2E_LINEAR_APP_USER_ID: "identity",
  E2E_LINEAR_AGENT_HANDLE: "identity",
  E2E_SOAK_LINEAR_APP_USER_ID: "identity",
  E2E_SOAK_LINEAR_AGENT_HANDLE: "identity",
  E2E_NOTION_BOT_USER_ID: "identity",
  E2E_NOTION_WORKSPACE_ID: "identity",
  E2E_ORG: "identity",

  E2E_INCLUDE_OPTIONAL: "knob",
  E2E_AUDIT_SILENCES: "knob",
  E2E_ACCESS_ALLOW_SEND: "knob",
  E2E_NOTION_QUERY: "knob",
  E2E_WEBHOOK_HOOK_ID: "knob",
  E2E_UNIFIED_DOMAIN: "knob",
  E2E_SOAK_DOMAIN: "knob",
  E2E_EXPECT_UNIFIED: "knob",
  E2E_UNIX_ARMED: "knob",
  E2E_SPEND_CAP_FIXTURE: "knob",
  E2E_SPEND_GATE_DOOR: "knob",
  E2E_ACCESS_PERSONAL_FIXTURE: "knob",
  E2E_ROUTINE_CONNECTOR_FIXTURE: "knob",
  E2E_DISCORD_GRANT_TAPPED: "knob",
  E2E_EXPECT_MODELS: "knob",
  E2E_EXPECT_MODELS_REQUIRED: "knob",
  E2E_PR_BASE: "knob",

  E2E_TARGET_URL: "local",
  E2E_TEAMS_REFRESH_TOKEN_FILE: "local",
  E2E_DISCORD_GRANT_THREAD_FILE: "local",

  E2E_GITHUB_ISSUE: "not-a-room",
  E2E_DISCORD_GRANT_THREAD: "not-a-room",
  E2E_GITHUB_INSTALLATION_ID: "not-a-room",
  E2E_NOTION_ANCHOR_ONTOPIC: "not-a-room",
  E2E_NOTION_ANCHOR_ONTOPIC2: "not-a-room",
  E2E_NOTION_ANCHOR_OFFTOPIC: "not-a-room",
  E2E_NOTION_ANCHOR_HUMAN: "not-a-room",
  E2E_SOAK_LINEAR_LABEL_ID: "not-a-room",
};

export type ProvisionAction = "create" | "reuse";

export interface PlannedRoom {
  readonly surface: SurfaceKind;
  readonly envVar: string;
  readonly action: ProvisionAction;
  readonly reuseOf?: string;
  readonly readByCode?: string;
  readonly note: string;
}

export interface ProvisionDomain {
  readonly domain: string;
  readonly slug: string;
  readonly linearKey: string;
  readonly ticket: string;
  readonly what: string;
  readonly rooms: readonly PlannedRoom[];
}

export const PROVISION_PLAN: readonly ProvisionDomain[] = [
  {
    domain: "e2e-engaged",
    slug: "addressed",
    linearKey: "OEEA",
    ticket: "OPE-1503",
    what: "the addressed-only posture — one room per surface, `ambientSupervisor` off, not unified",
    rooms: [
      {
        surface: "slack",
        envVar: "E2E_SLACK_PRIVATE_CHANNEL",
        action: "reuse",
        reuseOf: "E2E_SLACK_PRIVATE_CHANNEL",
        note: "S11's private channel already carries the addressed-only posture — it sits in NO explicit domain, so it falls to the `org` criteria domain, which sets neither ambientSupervisor nor mode. J-ENGAGED-slack drives it. Do NOT put it in ANY explicit domain: scripts/e2e-engaged-fixture-test.ts asserts it resolves to no explicit domain at all, which is what both S11 and this journey need. Its silo is therefore org-brain, the real shared brain (OPE-1541)",
      },
      {
        surface: "discord",
        envVar: "E2E_ADDRESSED_DISCORD_CHANNEL",
        action: "create",
        readByCode: "`env.ts`'s `ENGAGED_ROOM_VARS.discord` reads the var, so it is in ROOM_VARS — but the room is this plan's own to write, and the row declares `ownedBy: \"e2e-engaged\"`",
        note: "a text channel in the test guild",
      },
      {
        surface: "teams",
        envVar: "E2E_ADDRESSED_TEAMS_SURFACE",
        action: "create",
        readByCode: "`env.ts`'s `ENGAGED_ROOM_VARS.teams` reads the var, so it is in ROOM_VARS — but the room is this plan's own to write, and the row declares `ownedBy: \"e2e-engaged\"`",
        note: "🔴 A CHANNEL OF ITS OWN (OPE-1531). J-ENGAGED-teams used to drive E2E_TEAMS_CHANNEL_ID, the room J-TEAMS drives, so the two scenarios shared one standing seat and one context window — one scenario's rotation pressure was the other's. The channel lives in the SAME team as E2E_TEAMS_CHANNEL_ID, because the driver's delegated Graph auth is scoped to that team",
      },
      {
        surface: "github",
        envVar: "E2E_ADDRESSED_GITHUB_REPO",
        action: "create",
        readByCode: "`env.ts`'s `ENGAGED_ROOM_VARS.github` reads the var, so it is in ROOM_VARS — but the room is this plan's own, and the row declares `ownedBy: \"e2e-engaged\"`",
        note: "🔴 A REPO OF ITS OWN, and the second install is the price. This entry once REUSED E2E_PR_REPO, which names the same repository as E2E_GITHUB_REPO — `example-owner/e2e-scratch`, which e2e-unified holds with ambientSupervisor and mode:\"unified\". An ambient supervisor answers the plain follow-up, so J-ENGAGED-github would have passed step (b) without the engagement registry ever being read. No GitHub provisioner creates a repo, so this surface reports blocked with its one-time grant line and the journey self-skips until an operator acts",
      },
      {
        surface: "linear",
        envVar: "E2E_ADDRESSED_LINEAR_TEAM_ID",
        action: "create",
        readByCode: "`env.ts`'s `ENGAGED_ROOM_VARS.linear` reads the var, so it is in ROOM_VARS — but the room is this plan's own to write, and the row declares `ownedBy: \"e2e-engaged\"`",
        note: "a team in the e2e Linear org",
      },
      {
        surface: "notion",
        envVar: "E2E_ADDRESSED_NOTION_PAGE_ID",
        action: "create",
        readByCode: "`agent/memory/config/domains.ts` names this page in the `e2e-engaged` roster and `env.ts` reads the var, so it is in ROOM_VARS — but the room is still this plan's own to write, and the row declares `ownedBy: \"e2e-engaged\"`",
        note: "a page under the e2e page's own parent; `oe-e2e-addressed-notion` already exists, and create finds it by name rather than making a second one",
      },
    ],
  },
];

export function roomName(slug: string, surface: SurfaceKind): string {
  return `oe-e2e-${slug}-${surface}`;
}

export function planFor(domain: string): ProvisionDomain | undefined {
  return PROVISION_PLAN.find((p) => p.domain === domain || p.slug === domain);
}

export function createGuardRefusal(domain: string, room: PlannedRoom): string | null {
  if (room.action !== "create") return null;
  const where = `${domain}/${room.surface}`;
  if (room.reuseOf) return `${where}: a create names no reuseOf (got ${room.reuseOf})`;
  const spec = ROOM_VARS.find((v) => v.envVar === room.envVar);
  if (!spec) return null;
  if (room.readByCode === undefined) {
    return `${where}: ${room.envVar} is an existing fixture's room var ("${spec.what}") — a create would write over it`;
  }
  if (spec.ownedBy !== domain) {
    const owner = spec.ownedBy === undefined ? "no plan" : spec.ownedBy;
    return `${where}: readByCode does not waive the guard for ${room.envVar} — that var is owned by ${owner}, not ${domain}`;
  }
  return null;
}

export function engagedVarMismatches(reads: Readonly<Record<string, string>>): readonly string[] {
  const plan = planFor("e2e-engaged");
  if (!plan) return Object.keys(reads).sort();
  return Object.entries(reads)
    .filter(([surface, envVar]) => plan.rooms.find((r) => r.surface === surface)?.envVar !== envVar)
    .map(([surface]) => surface)
    .sort();
}

export function surfaceOfKey(key: string): SurfaceKind | null {
  const head = key.split("/", 1)[0];
  return (SURFACE_ORDER as readonly string[]).includes(head) ? (head as SurfaceKind) : null;
}

export function isSyntheticDomain(name: string): boolean {
  return name.startsWith("it-");
}

export interface DeclaredRoom {
  readonly surface: SurfaceKind;
  readonly key: string;
  readonly claimants: readonly string[];
  readonly synthetic: boolean;
  readonly container: boolean;
}

export interface DomainLike {
  readonly name: string;
  readonly channels?: readonly string[];
  readonly containers?: readonly string[];
}

export interface BindingLike {
  readonly bundle: string;
  readonly scope: { readonly level: string; readonly surface?: string };
}

export function collectDeclaredRooms(domains: readonly DomainLike[], bindings: readonly BindingLike[]): readonly DeclaredRoom[] {
  const byKey = new Map<string, { surface: SurfaceKind; claimants: Set<string>; domainClaimants: Set<string>; container: boolean }>();

  const add = (key: string, claimant: string, isDomain: boolean, container: boolean): void => {
    const surface = surfaceOfKey(key);
    if (!surface) return;
    let row = byKey.get(key);
    if (!row) {
      row = { surface, claimants: new Set(), domainClaimants: new Set(), container };
      byKey.set(key, row);
    }
    row.claimants.add(claimant);
    if (isDomain) row.domainClaimants.add(claimant);
  };

  for (const d of domains) {
    for (const key of d.channels ?? []) add(key, d.name, true, false);
    for (const key of d.containers ?? []) add(key, d.name, true, true);
  }
  for (const b of bindings) {
    if (b.scope.level === "surface" && b.scope.surface) add(b.scope.surface, `bundle:${b.bundle}`, false, false);
  }

  return [...byKey.entries()]
    .map(([key, row]) => ({
      surface: row.surface,
      key,
      claimants: [...row.claimants].sort(),
      synthetic: row.domainClaimants.size > 0 && [...row.domainClaimants].every(isSyntheticDomain),
      container: row.container,
    }))
    .sort((a, b) => (a.surface === b.surface ? a.key.localeCompare(b.key) : SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface)));
}

export interface Resolution {
  readonly ok: boolean;
  readonly name?: string;
  readonly key?: string;
  readonly detail: string;
}

export function canonicalId(surface: SurfaceKind, id: string): string {
  if (surface === "notion") {
    const hex = id.replaceAll("-", "").toLowerCase();
    if (/^[0-9a-f]{32}$/u.test(hex)) {
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return id.toLowerCase();
  }
  if (surface === "github") return id.toLowerCase();
  return id;
}

export function resolutionKey(surface: SurfaceKind, id: string): string {
  return `${surface}:${canonicalId(surface, id)}`;
}

export type FlagKind = "unresolved" | "double-claimed" | "env-unclaimed";

export interface InventoryFlag {
  readonly kind: FlagKind;
  readonly surface: SurfaceKind;
  readonly subject: string;
  readonly detail: string;
}

export interface InventoryRow {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name: string;
  readonly envVars: readonly string[];
  readonly claimants: readonly string[];
  readonly note: string;
}

export interface InventoryInput {
  readonly envValues: Readonly<Record<string, string | undefined>>;
  readonly declared: readonly DeclaredRoom[];
  readonly resolutions: ReadonlyMap<string, Resolution>;
  readonly unresolvableSurfaces: readonly SurfaceKind[];
  readonly teamsRosterVisible: boolean;
}

export interface Inventory {
  readonly rows: readonly InventoryRow[];
  readonly flags: readonly InventoryFlag[];
}

export function redactId(surface: SurfaceKind, id: string): string {
  return surface === "teams" ? "—" : id;
}

export function idOfKey(key: string): string {
  const parts = key.split("/");
  if (parts[0] === "github") return parts.slice(1).join("/");
  return parts[parts.length - 1];
}

export function inventoryVars(
  roomVars: readonly RoomVarSpec[] = ROOM_VARS,
  plan: readonly ProvisionDomain[] = PROVISION_PLAN,
): readonly RoomVarSpec[] {
  const planned: RoomVarSpec[] = [];
  for (const domain of plan) {
    for (const room of domain.rooms) {
      if (room.action !== "create") continue;
      planned.push({ surface: room.surface, envVar: room.envVar, what: `${domain.domain} (${domain.ticket}) — ${room.note}` });
    }
  }
  const seen = new Set(roomVars.map((v) => v.envVar));
  return [...roomVars, ...planned.filter((v) => !seen.has(v.envVar))];
}

export function buildInventory(input: InventoryInput): Inventory {
  const { envValues, declared, resolutions, unresolvableSurfaces, teamsRosterVisible } = input;
  const blindSurfaces = new Set(unresolvableSurfaces);

  interface Draft {
    surface: SurfaceKind;
    rawId: string;
    envVars: string[];
    claimants: string[];
    notes: string[];
    synthetic: boolean;
    container: boolean;
    expectUnclaimed?: string;
    neverProbe?: string;
  }
  const drafts = new Map<string, Draft>();
  const draftFor = (surface: SurfaceKind, id: string): Draft => {
    const k = resolutionKey(surface, id);
    let d = drafts.get(k);
    if (!d) {
      d = { surface, rawId: canonicalId(surface, id), envVars: [], claimants: [], notes: [], synthetic: false, container: false };
      drafts.set(k, d);
    }
    return d;
  };

  for (const room of declared) {
    const d = draftFor(room.surface, idOfKey(room.key));
    for (const c of room.claimants) if (!d.claimants.includes(c)) d.claimants.push(c);
    d.synthetic ||= room.synthetic;
    d.container ||= room.container;
  }

  for (const spec of inventoryVars()) {
    const value = envValues[spec.envVar]?.trim();
    if (!value) continue;
    const id = spec.surface === "teams" && value.startsWith("teams/") ? idOfKey(value) : value;
    const d = draftFor(spec.surface, id);
    if (!d.envVars.includes(spec.envVar)) d.envVars.push(spec.envVar);
    d.expectUnclaimed ??= spec.expectUnclaimed;
    d.neverProbe ??= spec.neverProbe;
  }

  const rows: InventoryRow[] = [];
  const flags: InventoryFlag[] = [];

  for (const d of [...drafts.values()].sort((a, b) =>
    a.surface === b.surface ? a.rawId.localeCompare(b.rawId) : SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface),
  )) {
    const printedId = redactId(d.surface, d.rawId);
    const resolution = resolutions.get(resolutionKey(d.surface, d.rawId));
    const notes = [...d.notes];

    let name: string;
    if (d.container) {
      name = "—";
      notes.push("container claim — a same-level glob, not one room");
    } else if (d.synthetic) {
      name = "(fabricated id)";
      notes.push("synthetic — an integration-tier fixture id, never a live room");
    } else if (d.neverProbe) {
      name = "—";
      notes.push(d.neverProbe);
    } else if (resolution?.ok) {
      name = resolution.name ?? "?";
    } else if (blindSurfaces.has(d.surface)) {
      name = "?";
      notes.push("not looked up — no driver credential for this surface in the run that wrote this table");
    } else if (resolution) {
      name = "?";
      notes.push(`does not resolve — ${resolution.detail}`);
    } else {
      name = "?";
      notes.push("not looked up");
    }

    const subject = d.surface === "teams" ? name : printedId;
    if (resolution && !resolution.ok && !d.container && !d.synthetic && !d.neverProbe && !blindSurfaces.has(d.surface)) {
      flags.push({ kind: "unresolved", surface: d.surface, subject, detail: resolution.detail });
    }

    const domainClaimants = d.claimants.filter((c) => !c.startsWith("bundle:"));
    if (domainClaimants.length > 1) {
      flags.push({
        kind: "double-claimed",
        surface: d.surface,
        subject,
        detail: `claimed by ${domainClaimants.join(" and ")} — channel exclusivity means one of the two never matches`,
      });
    }
    if (d.envVars.length > 0 && domainClaimants.length === 0) {
      if (d.expectUnclaimed) {
        notes.push(`unclaimed by design — ${d.expectUnclaimed}`);
      } else if (d.surface === "teams" && !teamsRosterVisible) {
        notes.push("claim unknown — the Teams roster is env-only (`OE_TEAMS_INTERNAL_SURFACES`) and was unset in the run that wrote this table");
      } else {
        flags.push({
          kind: "env-unclaimed",
          surface: d.surface,
          subject,
          detail: `${d.envVars.join(", ")} names it, but no domain roster does — it resolves through the criteria domains (\`org\`, \`dm\`, \`public\`) instead`,
        });
      }
    }

    rows.push({
      surface: d.surface,
      id: printedId,
      name,
      envVars: [...d.envVars].sort(),
      claimants: d.claimants.length > 0 ? d.claimants : ["unclaimed"],
      note: notes.join("; ") || "—",
    });
  }

  return { rows, flags };
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

const HEADER = `# The e2e fixture inventory

The rooms the e2e pack drives, with their live names. They live in three places — the \`E2E_*\` room
vars in \`packages/core/scripts/e2e/env.ts\`, the surface keys in \`agent/memory/config/domains.ts\`,
and the surface-scoped bindings in \`agent/access/bundles.ts\` — and none of the three carries a
name. This file does.

The two config sources are read in full, so a room added to a domain or a binding appears here the
next time this file is written. The \`env.ts\` side is a MAINTAINED list (\`ROOM_VARS\`): a name does
not say whether it holds a channel or a token, so the partition is declared, and a unit test refuses
a new entry in \`env.ts\`'s \`ENV\` registry that is neither a room nor a reasoned exemption.

**This file is generated. Do not edit it.** Write it with
\`npm run e2e:fixtures -- inventory\` from \`packages/core\`, which resolves every id through its
vendor, then run \`npm run docs:generate\` from the repo root — the \`docs/\` tree is compiled into
the shipped manual, so the two commits together. \`-- inventory --check\` compares the committed
rows against a fresh resolution and exits non-zero when a room this run can see has changed,
arrived or gone. It compares ROWS rather than text, so an operator holding part of the fixture set
is not told the file is stale over rooms their credentials never named. The check calls six
vendors, so the \`test\` chain runs it as a WARNING rung, inert unless \`E2E_FIXTURE_TABLE_CHECK=1\`.

A write REFUSES twice over, because a wrong name here is the defect this file exists to remove:
when a surface has no driver credential at all, and when a room that already carries a name in this
file does not resolve for the running credential. The second case is the sharper one — a token can
be valid for Slack and still miss a private channel its user is not in. Both refusals name what
they saw; \`--partial\` overrides them when the rooms are genuinely gone.

**A Teams row carries a name and an env var, never the key.** A Teams surface key holds the
operator's Microsoft 365 tenant id, and \`scripts/teams-vouch-lint.ts\` fails the \`test\` chain on
such a literal in a tracked file. The id lives in the environment.

Column meanings: **id** is the vendor's own id (\`owner/repo\` on GitHub, empty on Teams). **name**
is what the vendor calls the room today. **env var** is the \`E2E_*\` name that carries the id;
\`—\` means the pack drives the room through config alone. **claimed by** names the memory domains
and access bundles whose ROSTER spells the room; \`unclaimed\` means no roster does, so the room
resolves through the criteria domains (\`org\`, \`dm\`, \`public\`) instead.`;

const LIMITS = `## What this table does not prove

- **Membership, permission and grant are out of scope.** A row proves the room exists and is
  reachable by the credential the run held. It does not prove the OE bot is in it, that a bundle
  grants anything on it, or that its domain has the posture a scenario needs.
- **A \`?\` name is two different things.** With a credential for that surface it means the id did
  not resolve, and the row carries the vendor's own reason. Without one it means nobody looked.
  The note says which.
- **Synthetic rooms are never probed.** The integration tier declares domains over fabricated ids;
  those rows say so and carry no name.`;

export interface RenderOptions {
  readonly unresolvableSurfaces: readonly SurfaceKind[];
}

export function renderInventoryDoc(inventory: Inventory, options: RenderOptions): string {
  const out: string[] = [HEADER, ""];

  for (const surface of SURFACE_ORDER) {
    const rows = inventory.rows.filter((r) => r.surface === surface);
    out.push(`## ${SURFACE_LABEL[surface]}`, "");
    if (rows.length === 0) {
      out.push("No room declared.", "");
      continue;
    }
    out.push("| id | name | env var | claimed by | note |", "| --- | --- | --- | --- | --- |");
    for (const r of rows) {
      const id = r.id === "—" ? "—" : `\`${cell(r.id)}\``;
      const envVars = r.envVars.length > 0 ? r.envVars.map((v) => `\`${cell(v)}\``).join("<br>") : "—";
      out.push(`| ${id} | ${cell(r.name)} | ${envVars} | ${cell(r.claimants.join(", "))} | ${cell(r.note)} |`);
    }
    out.push("");
  }

  out.push("## Flags", "");
  if (inventory.flags.length === 0) {
    out.push("None. Every id resolves, no room is claimed twice, and every room an env var names has a domain.", "");
  } else {
    const order: readonly FlagKind[] = ["unresolved", "double-claimed", "env-unclaimed"];
    const titles: Readonly<Record<FlagKind, string>> = {
      unresolved: "Does not resolve",
      "double-claimed": "Claimed by two domains",
      "env-unclaimed": "In an env var, in no domain",
    };
    for (const kind of order) {
      const flags = inventory.flags.filter((f) => f.kind === kind);
      if (flags.length === 0) continue;
      out.push(`### ${titles[kind]} (${flags.length})`, "");
      for (const f of flags) out.push(`- **${SURFACE_LABEL[f.surface]} \`${f.subject}\`** — ${f.detail}`);
      out.push("");
    }
  }

  if (options.unresolvableSurfaces.length > 0) {
    out.push(
      `**Surfaces this run could not reach:** ${options.unresolvableSurfaces
        .map((s) => SURFACE_LABEL[s])
        .join(", ")}. Their rows carry \`?\` because nobody looked, not because the room is gone.`,
      "",
    );
  }

  out.push(LIMITS, "");
  return `${out.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

export interface ParsedRow {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name: string;
  readonly envVars: readonly string[];
  readonly claimants: readonly string[];
  readonly note: string;
}

const LABEL_TO_SURFACE = new Map<string, SurfaceKind>(SURFACE_ORDER.map((s) => [SURFACE_LABEL[s], s]));

function uncell(text: string): string {
  return text.trim().replace(/^`|`$/gu, "").replaceAll("\\|", "|").trim();
}

function splitList(text: string, separator: string): readonly string[] {
  const t = text.trim();
  if (t === "" || t === "—") return [];
  return t
    .split(separator)
    .map((v) => uncell(v))
    .filter((v) => v.length > 0);
}

export function parseInventoryDoc(markdown: string): readonly ParsedRow[] {
  const rows: ParsedRow[] = [];
  let surface: SurfaceKind | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      surface = LABEL_TO_SURFACE.get(heading[1].trim()) ?? null;
      continue;
    }
    if (!surface || !line.startsWith("|")) continue;
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split(/(?<!\\)\|/u);
    if (cells.length !== 5) continue;
    const id = uncell(cells[0]);
    if (id === "id" || /^-{3,}$/u.test(id)) continue;
    rows.push({
      surface,
      id,
      name: uncell(cells[1]),
      envVars: splitList(cells[2], "<br>"),
      claimants: splitList(cells[3], ","),
      note: uncell(cells[4]),
    });
  }
  return rows;
}

export function rowKey(row: { surface: SurfaceKind; id: string; name: string; envVars: readonly string[]; claimants: readonly string[] }): string {
  if (row.surface !== "teams") return `${row.surface}|${row.id}`;
  if (row.envVars.length > 0) return `teams|env:${[...row.envVars].sort().join(",")}`;
  return `teams|name:${row.name}|by:${[...row.claimants].sort().join(",")}`;
}

export type Staleness = { readonly stale: false } | { readonly stale: true; readonly reasons: readonly string[] };

export function namesLost(committed: readonly ParsedRow[], generated: readonly InventoryRow[]): readonly string[] {
  const fresh = new Map(generated.map((r) => [rowKey(r), r]));
  const unnamed = (name: string): boolean => name === "?" || name === "—";
  const lost: string[] = [];
  for (const before of committed) {
    if (unnamed(before.name)) continue;
    const now = fresh.get(rowKey(before));
    if (now && unnamed(now.name)) lost.push(`${before.surface} ${before.id === "—" ? before.name : before.id}: was "${before.name}", now "${now.name}" — ${now.note}`);
  }
  return lost;
}

export function roomsUnseen(
  committed: readonly ParsedRow[],
  envValues: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const declared = new Set(ROOM_VARS.map((r) => r.envVar));
  const unseen: string[] = [];
  for (const row of committed) {
    if (row.envVars.some((v) => Boolean(envValues[v]?.trim()))) continue;
    const blind = row.envVars.filter((v) => declared.has(v) && !envValues[v]?.trim());
    if (blind.length === 0) continue;
    unseen.push(`${blind.join(", ")} unset here; writing would drop \`${row.name}\` or its env-var column`);
  }
  return unseen;
}

export function compareInventory(
  committed: readonly ParsedRow[],
  generated: readonly InventoryRow[],
  envValues: Readonly<Record<string, string | undefined>>,
): Staleness {
  const reasons: string[] = [];
  const fresh = new Map(generated.map((r) => [rowKey(r), r]));
  const old = new Map(committed.map((r) => [rowKey(r), r]));

  for (const [key, row] of fresh) {
    const before = old.get(key);
    if (!before) {
      reasons.push(`${key} is a room this run found and the table does not list`);
      continue;
    }
    const fields: [string, string, string][] = [
      ["name", before.name, row.name],
      ["env var", before.envVars.join(","), row.envVars.join(",")],
      ["claimed by", before.claimants.join(","), row.claimants.join(",")],
      ["note", before.note, row.note],
    ];
    for (const [what, was, now] of fields) {
      if (was !== now) reasons.push(`${key}: ${what} was "${was}", now "${now}"`);
    }
  }

  for (const [key, row] of old) {
    if (fresh.has(key)) continue;
    const visible = row.envVars.length === 0 || row.envVars.some((v) => Boolean(envValues[v]?.trim()));
    if (visible) reasons.push(`${key} is in the table and this run did not find it`);
  }

  return reasons.length === 0 ? { stale: false } : { stale: true, reasons };
}
