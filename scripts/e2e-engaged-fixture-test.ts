import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EXPECTED_ROOMS = [
  "linear/1a000000-0000-4000-8000-000000000002/1a000000-0000-4000-8000-000000000012",
  "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000104",
  "discord/1300000000000000100/1300000000000000102",
  "github/example-owner/oe-e2e-addressed-github",
] as const;

const MUST_STAY_OUT: readonly (readonly [string, string])[] = [
  ["slack/T0EXAMPLE/C0EXCHAN004", "#oe-e2e-private is S11's fixture and needs to sit OUTSIDE every explicit domain"],
  ["slack/T0EXAMPLE/D0EXDMCH001", "a DM can never be stood down at all — tools/stand_down.ts refuses on mode before it reads an anchor"],
  ["github/example-owner/ungranted-repo", "S-PR-BOUNDARY proves the grant check REFUSES this repo, so no domain may claim it"],
  ["slack/T0EXAMPLE/C0EXCHAN003", "e2e-unified's own Slack channel — taking it would change what J1 and several other journeys mean"],
];

type DomainSnapshot = {
  readonly names: readonly string[];
  readonly engaged: {
    readonly channels: readonly string[];
    readonly memory: unknown;
    readonly nameDropWake: unknown;
    readonly engagementTier: unknown;
    readonly ambientSupervisor: unknown;
    readonly mode: unknown;
    readonly credentials: unknown;
    readonly credentialGrants: unknown;
  } | null;
  readonly org: {
    readonly nameDropWake: unknown;
    readonly ambientSupervisor: unknown;
    readonly mode: unknown;
  } | null;
  readonly resolved: Record<string, string | null>;
};

const NO_EXPLICIT_DOMAIN: readonly (readonly [string, string])[] = [
  [
    "slack/T0EXAMPLE/C0EXCHAN004",
    "#oe-e2e-private is J-ENGAGED-slack's room and S11's, and BOTH need its default addressed-only posture — an explicit domain of any name would supply a different one",
  ],
];

const PROBE = [...EXPECTED_ROOMS, ...MUST_STAY_OUT.map(([key]) => key), ...NO_EXPLICIT_DOMAIN.map(([key]) => key)];

if (process.argv.includes("--probe")) {
  const { loadDomains, domainsForSurface } = await import("../agent/memory/config/domains.js");
  const domains = loadDomains();
  const d = domains.find((x) => x.name === "e2e-engaged");
  const org = domains.find((x) => x.match === "org");
  const resolve = (key: string): string | null => {
    const [platform, workspace, ...rest] = key.split("/");
    return domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: rest.join("/") })[0] ?? null;
  };
  const snapshot: DomainSnapshot = {
    names: domains.map((x) => x.name),
    engaged: d
      ? {
          channels: [...(d.reach ?? [])],
          memory: d.memory ?? null,
          nameDropWake: d.nameDropWake ?? null,
          engagementTier: d.engagementTier ?? null,
          ambientSupervisor: d.ambientSupervisor ?? null,
          mode: d.mode ?? null,
          credentials: d.credentials ?? null,
          credentialGrants: d.credentialGrants ?? null,
        }
      : null,
    org: org
      ? {
          nameDropWake: org.nameDropWake ?? null,
          ambientSupervisor: org.ambientSupervisor ?? null,
          mode: org.mode ?? null,
        }
      : null,
    resolved: Object.fromEntries(PROBE.map((k) => [k, resolve(k)])),
  };
  process.stdout.write(`__SNAPSHOT__${JSON.stringify(snapshot)}`);
  process.exit(0);
}

const SELF = fileURLToPath(import.meta.url);

function snapshot(env: NodeJS.ProcessEnv = { ...process.env }): DomainSnapshot {
  const argv = [...process.execArgv];
  if (!argv.some((a) => a.includes("tsx"))) argv.push("--import", "tsx");
  const r = spawnSync(process.execPath, [...argv, SELF, "--probe"], { env, encoding: "utf8" });
  const out = `${r.stdout ?? ""}`;
  const marker = out.indexOf("__SNAPSHOT__");
  if (r.status !== 0 || marker < 0) {
    throw new Error(`domains.ts failed to load (exit ${r.status}) — the module-load validators rejected the config.\nstdout: ${out}\nstderr: ${r.stderr ?? ""}`);
  }
  return JSON.parse(out.slice(marker + "__SNAPSHOT__".length)) as DomainSnapshot;
}

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

{
  const bare: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: tmpdir(), NODE_NO_WARNINGS: "1" };
  const s = snapshot(bare);
  ok(s.names.includes("e2e-engaged"), "the e2e-engaged domain registers in a process whose environment carries no fixture ids at all");
  ok(
    s.engaged!.channels.join("|") === EXPECTED_ROOMS.join("|"),
    `…holding exactly the rooms this file names, from the tracked config alone (got ${JSON.stringify(s.engaged!.channels)})`,
  );
}

{
  const s = snapshot();
  const d = s.engaged!;
  ok(
    d.ambientSupervisor === null,
    `ADDRESSED-ONLY: ambientSupervisor is UNSET (got ${JSON.stringify(d.ambientSupervisor)}) — this ONE absence does both jobs: no supervisor answers the plain follow-up, AND slackDomainUsesUnifiedWindow (grainUsesUnifiedWindow && ambientSupervisorEnabled) cannot short-circuit before the isThreadEngaged read. Set it and the engaged seam goes untested again, with or without a mode`,
  );
  ok(
    d.mode === null,
    `ADDRESSED-ONLY: mode is UNSET (got ${JSON.stringify(d.mode)}) — required anyway, since assertUnifiedDomainTrust refuses a mode without ambientSupervisor. Pinned beside the flag so neither can return alone`,
  );
  ok(
    d.nameDropWake === true,
    "nameDropWake is ON — declared so this fixture asserts its OWN posture rather than inheriting a workspace default. 🔴 IT IS LIVE ON DISCORD AND INERT ON NOTION: discord-gateway.ts reads the flag, so the room OPE-1581 added is the first here it governs, while no packages/providers/notion file reads it at all. Notion's silence is NOT the ambient gate: that gate reads the addressing (OPE-1510), so an addressed comment on a DECLARED page passes it with ambientSupervisor unset. J-ENGAGED-slack's name-drop leg rides the `org` criteria domain's own nameDropWake, because its room is in no explicit domain (OPE-1539) — leg 5 pins THAT knob, which is the one that leg reads",
  );
  ok(d.engagementTier === "neutral", `engagementTier is "neutral" — it overrides GitHub's "reserved" default so every room behaves uniformly (got ${JSON.stringify(d.engagementTier)})`);
  ok(d.memory === "e2e-brain", `the fixture reuses the shared harness brain (got ${JSON.stringify(d.memory)}) — no memory leg lives in these journeys, so it needs no silo of its own`);
}

{
  const d = snapshot().engaged!;
  ok(d.credentials === null, `the fixture declares NO credentials (got ${JSON.stringify(d.credentials)}) — it is a posture, not a work grant`);
  ok(d.credentialGrants === null, `the fixture declares NO credentialGrants (got ${JSON.stringify(d.credentialGrants)}) — same reason`);
}

{
  const s = snapshot();
  for (const room of EXPECTED_ROOMS) {
    ok(s.resolved[room] === "e2e-engaged", `${room} resolves to e2e-engaged (got ${s.resolved[room]})`);
  }
  for (const [room, why] of MUST_STAY_OUT) {
    ok(s.resolved[room] !== "e2e-engaged", `${room} is NOT in e2e-engaged — ${why} (resolves to ${s.resolved[room]})`);
  }
  for (const [room, why] of NO_EXPLICIT_DOMAIN) {
    ok(s.resolved[room] === null, `${room} is in NO EXPLICIT DOMAIN — ${why} (resolves to ${s.resolved[room]})`);
  }
  ok(s.resolved["slack/T0EXAMPLE/C0EXCHAN003"] === "e2e-unified", `the control: a room an explicit domain DOES hold resolves to that domain (got ${s.resolved["slack/T0EXAMPLE/C0EXCHAN003"]})`);
}

{
  const s = snapshot();
  ok(s.org !== null, "the `org` criteria domain is registered — the domain every NO_EXPLICIT_DOMAIN room falls to");
  const org = s.org!;
  ok(
    org.ambientSupervisor === null,
    `the \`org\` criteria domain sets NO ambientSupervisor (got ${JSON.stringify(org.ambientSupervisor)}) — J-ENGAGED-slack's room inherits its addressed-only posture from here. Turn this on and a supervisor answers the plain follow-up, so the journey passes on the supervisor rather than the engagement registry`,
  );
  ok(
    org.mode === null,
    `the \`org\` criteria domain sets NO mode (got ${JSON.stringify(org.mode)}) — a belt over assertUnifiedDomainTrust, which refuses a mode on any criteria domain. It reds only if that refusal goes away`,
  );
  ok(
    org.nameDropWake === true,
    `the \`org\` criteria domain sets nameDropWake: true (got ${JSON.stringify(org.nameDropWake)}) — J-ENGAGED-slack's name-drop leg rides THIS knob, because its room is in no explicit domain`,
  );
}

{
  const { TRACKED_ROOM_IDS, idOfKey } = await import("../packages/core/scripts/e2e/fixture-inventory-lib.js");
  const rosterRepo = EXPECTED_ROOMS.filter((k) => k.startsWith("github/")).map((k) => idOfKey(k));
  ok(rosterRepo.length === 1, `exactly one GitHub repo sits in this roster (got ${JSON.stringify(rosterRepo)})`);
  ok(
    TRACKED_ROOM_IDS["E2E_ADDRESSED_GITHUB_REPO"] === rosterRepo[0],
    `🔴 the repo the harness drives IS the repo this domain declares — TRACKED_ROOM_IDS.E2E_ADDRESSED_GITHUB_REPO is ${JSON.stringify(TRACKED_ROOM_IDS["E2E_ADDRESSED_GITHUB_REPO"])}, the roster says ${JSON.stringify(rosterRepo[0])}. Move one without the other and J-ENGAGED-github drives a repo whose posture no domain declares`,
  );
}

{
  const { TRACKED_ROOM_IDS, idOfKey } = await import("../packages/core/scripts/e2e/fixture-inventory-lib.js");
  const rosterTeams = EXPECTED_ROOMS.filter((k) => k.startsWith("linear/")).map((k) => idOfKey(k));
  ok(rosterTeams.length === 1, `exactly one Linear team sits in this roster (got ${JSON.stringify(rosterTeams)})`);
  ok(
    TRACKED_ROOM_IDS["E2E_ADDRESSED_LINEAR_TEAM_ID"] === rosterTeams[0],
    `🔴 the team the harness drives IS the team this domain declares — TRACKED_ROOM_IDS.E2E_ADDRESSED_LINEAR_TEAM_ID is ${JSON.stringify(TRACKED_ROOM_IDS["E2E_ADDRESSED_LINEAR_TEAM_ID"])}, the roster says ${JSON.stringify(rosterTeams[0])}. Move one without the other and J-ENGAGED-linear drives a team whose posture no domain declares`,
  );
  ok(
    TRACKED_ROOM_IDS["E2E_ADDRESSED_LINEAR_TEAM_ID"] !== "1a000000-0000-4000-8000-000000000011",
    "🔴 …and it is NOT the base e2e workspace's E2E team — e2e-unified's driver team runs a unified window with an ambient supervisor, which answers the plain follow-up and masks the seam step (b) exists to prove",
  );
}

console.log(`✓ e2e-engaged fixture: ${n} assertions passed (roster is tracked config, posture by absence, grants nothing, exclusivity, the default posture the Slack journey rides, the roster/harness room joins)`);
