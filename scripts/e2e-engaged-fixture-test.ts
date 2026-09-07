import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EXPECTED_ROOMS = ["notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000104"] as const;

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
  readonly resolved: Record<string, string | null>;
};

const PROBE = [...EXPECTED_ROOMS, ...MUST_STAY_OUT.map(([key]) => key)];

if (process.argv.includes("--probe")) {
  const { loadDomains, domainsForSurface } = await import("../agent/memory/config/domains.js");
  const domains = loadDomains();
  const d = domains.find((x) => x.name === "e2e-engaged");
  const resolve = (key: string): string | null => {
    const [platform, workspace, ...rest] = key.split("/");
    return domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: rest.join("/") })[0] ?? null;
  };
  const snapshot: DomainSnapshot = {
    names: domains.map((x) => x.name),
    engaged: d
      ? {
          channels: [...(d.channels ?? [])],
          memory: d.memory ?? null,
          nameDropWake: d.nameDropWake ?? null,
          engagementTier: d.engagementTier ?? null,
          ambientSupervisor: d.ambientSupervisor ?? null,
          mode: d.mode ?? null,
          credentials: d.credentials ?? null,
          credentialGrants: d.credentialGrants ?? null,
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
    "nameDropWake is ON — the SLACK name-drop leg has nothing to assert without it. It is inert for Notion: no packages/providers/notion file reads the flag, and Notion's ingress sits behind the ambient gate regardless (OPE-1510)",
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
}

console.log(`✓ e2e-engaged fixture: ${n} assertions passed (roster is tracked config, posture by absence, grants nothing, exclusivity)`);
