import { ENGAGED_ROOM_VARS, ENV } from "./e2e/env.js";
import {
  NON_ROOM_ENV,
  PROVISION_PLAN,
  ROOM_VARS,
  SURFACE_ORDER,
  buildInventory,
  canonicalId,
  teamsSegment,
  collectDeclaredRooms,
  compareInventory,
  createGuardRefusal,
  engagedVarMismatches,
  idOfKey,
  inventoryVars,
  isSyntheticDomain,
  namesLost,
  parseInventoryDoc,
  planFor,
  redactId,
  renderInventoryDoc,
  rowKey,
  resolutionKey,
  roomName,
  roomsUnseen,
  surfaceOfKey,
  type BindingLike,
  type DomainLike,
  type Resolution,
} from "./e2e/fixture-inventory-lib.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(surfaceOfKey("slack/T1/C1") === "slack", "a slack key reads as the slack surface");
ok(surfaceOfKey("github/acme/api") === "github", "a github key reads as the github surface");
ok(surfaceOfKey("jira/PROJ/1") === null, "an unknown platform rung is not a surface");
ok(idOfKey("slack/T1/C1") === "C1", "a slack room id is the last rung");
ok(idOfKey("github/acme/api") === "acme/api", "a github room id keeps the owner rung");
ok(canonicalId("notion", "40000000000040008000000000000101") === "40000000-0000-4000-8000-000000000101", "a dashless Notion id canonicalises to the dashed form");
ok(canonicalId("github", "Acme/API") === "acme/api", "a github repo name canonicalises to lower case");
ok(canonicalId("slack", "C0AB1") === "C0AB1", "a slack id is left exactly as the vendor spells it");
ok(resolutionKey("notion", "40000000000040008000000000000101") === resolutionKey("notion", "40000000-0000-4000-8000-000000000101"), "both Notion spellings key one room");

const TEAMS_RAW = "19:aaaaBBBBccccDDDD-eeeeFFFFggggHHHH1234@thread.tacv2";
const TEAMS_KEY = "19-aaaaBBBBccccDDDD-eeeeFFFFggggHHHH1234-thread.tacv2";
const TEAMS_RAW_OTHER = "19:0000111122223333444455556666777788@thread.tacv2";
ok(canonicalId("teams", TEAMS_RAW) === TEAMS_KEY, "a raw Graph channel id canonicalises to the sanitised segment a surface key carries");
ok(canonicalId("teams", TEAMS_KEY) === TEAMS_KEY, "…and the sanitised spelling is already canonical, so the mapping is idempotent");
ok(resolutionKey("teams", TEAMS_RAW) === resolutionKey("teams", TEAMS_KEY), "both Teams spellings key one room");
ok(resolutionKey("teams", TEAMS_RAW_OTHER) !== resolutionKey("teams", TEAMS_RAW), "two DIFFERENT Teams channels still key two rooms");
ok(teamsSegment(TEAMS_RAW_OTHER) === "19-0000111122223333444455556666777788-thread.tacv2", "teamsSegment sanitises the colon and the at-sign to the stored form");
ok(teamsSegment("00000000-1111-4222-8333-444444444444") === "00000000-1111-4222-8333-444444444444", "a value that needs no sanitising is returned unchanged");

const DOMAINS: DomainLike[] = [
  { name: "org" },
  { name: "e2e-unified", reach: ["slack/T1/CA", "github/acme/api"] },
  { name: "e2e-other", reach: ["slack/T1/CA"] },
  { name: "e2e-smoke", reach: ["linear/org1/smoke-*"] },
  { name: "it-memory", reach: ["discord/G1/999000001"] },
];
const BINDINGS: BindingLike[] = [
  { bundle: "coding", scope: { level: "surface", surface: "slack/T1/CB" } },
  { bundle: "org-default", scope: { level: "org" } },
];

const declared = collectDeclaredRooms(DOMAINS, BINDINGS);
const byKey = new Map(declared.map((r) => [r.key, r]));
ok(declared.length === 5, "five rooms are declared across the two registries");
ok(byKey.get("slack/T1/CA")!.claimants.join(",") === "e2e-other,e2e-unified", "a room two domains name keeps both claimants, sorted");
ok(byKey.get("slack/T1/CB")!.claimants.join(",") === "bundle:coding", "a surface-scoped binding claims its room under a bundle: prefix");
ok(byKey.get("linear/org1/smoke-*")!.container === true, "a containers entry is a container claim, not a room");
ok(byKey.get("discord/G1/999000001")!.synthetic === true, "a room only an it- domain names is synthetic");
ok(byKey.get("slack/T1/CA")!.synthetic === false, "a room a live domain names is not synthetic");
ok(isSyntheticDomain("it-work-read-fixture-teams") && !isSyntheticDomain("e2e-unified"), "the synthetic rule is the it- prefix");
ok(byKey.get("slack/T1/CB")!.synthetic === false, "a bundle-only room is never synthetic — a bundle names no tier");

const ENV_VALUES: Record<string, string | undefined> = {
  E2E_SLACK_CHANNEL: "CA",
  E2E_SLACK_PRIVATE_CHANNEL: "CP",
  E2E_TEAMS_CHANNEL_ID: "19:abc@thread.tacv2",
  E2E_PR_UNGRANTED_REPO: "nobody/nothing",
};
const RESOLUTIONS = new Map<string, Resolution>([
  [resolutionKey("slack", "CA"), { ok: true, name: "#general", detail: "conversations.info" }],
  [resolutionKey("slack", "CB"), { ok: true, name: "#coding", detail: "conversations.info" }],
  [resolutionKey("slack", "CP"), { ok: false, detail: "channel_not_found" }],
  [resolutionKey("github", "acme/api"), { ok: true, name: "acme/api", detail: "GET /repos" }],
  [resolutionKey("teams", "19:abc@thread.tacv2"), { ok: true, name: "oe-e2e-addressed-teams", detail: "GET channels" }],
  [resolutionKey("github", "nobody/nothing"), { ok: false, detail: "GET /repos → 404" }],
]);

const inventory = buildInventory({
  envValues: ENV_VALUES,
  declared,
  resolutions: RESOLUTIONS,
  unresolvableSurfaces: [],
  teamsRosterVisible: true,
});
const row = (surface: string, id: string) => inventory.rows.find((r) => r.surface === surface && r.id === id)!;

ok(row("slack", "CA").name === "#general", "a resolved id carries the vendor's own name into its row");
ok(row("slack", "CA").envVars.join(",") === "E2E_SLACK_CHANNEL", "the env var that names a room reaches its row");
ok(row("slack", "CA").claimants.join(",") === "e2e-other,e2e-unified", "both claiming domains reach the row");
ok(row("slack", "CB").claimants.join(",") === "bundle:coding", "a bundle-only room names the bundle rather than 'unclaimed'");
ok(row("discord", "999000001").name === "(fabricated id)", "a synthetic room is named as fabricated, never probed and never '?'");
ok(row("discord", "999000001").note.includes("synthetic"), "a synthetic room says so in its note");
ok(row("linear", "smoke-*").note.includes("container claim"), "a container claim says so in its note");

const flag = (kind: string) => inventory.flags.filter((f) => f.kind === kind);
ok(flag("double-claimed").length === 1 && flag("double-claimed")[0].subject === "CA", "a room two domains claim raises exactly one double-claim flag");
ok(flag("unresolved").length === 1 && flag("unresolved")[0].subject === "CP", "an id the vendor did not return raises an unresolved flag");
ok(row("slack", "CP").note.includes("does not resolve"), "the unresolved row says so in its note");
ok(flag("env-unclaimed").some((f) => f.subject === "CP"), "a room an env var names and no domain claims raises an env-unclaimed flag");
ok(flag("env-unclaimed").map((f) => f.subject).sort().join(",") === "CP,oe-e2e-addressed-teams", "exactly the two unclaimed rooms are flagged, and a Teams flag names the room");
ok(row("github", "nobody/nothing").note.includes("unclaimed by design"), "a declared-unclaimed room takes a note instead of a flag");
ok(!flag("env-unclaimed").some((f) => f.subject === "nobody/nothing"), "the negative control raises no env-unclaimed flag");
ok(!flag("unresolved").some((f) => f.surface === "github"), "a never-probed room raises no unresolved flag");

const clean = buildInventory({
  envValues: { E2E_SLACK_CHANNEL: "CA" },
  declared: collectDeclaredRooms([{ name: "e2e-unified", reach: ["slack/T1/CA"] }], []),
  resolutions: new Map([[resolutionKey("slack", "CA"), { ok: true, name: "#general", detail: "info" } as Resolution]]),
  unresolvableSurfaces: [],
  teamsRosterVisible: true,
});
ok(clean.flags.length === 0, "one resolved, singly-claimed room raises no flag at all — the negative control for all three");

const blind = buildInventory({
  envValues: { E2E_SLACK_CHANNEL: "CA" },
  declared: collectDeclaredRooms([{ name: "e2e-unified", reach: ["slack/T1/CA"] }], []),
  resolutions: new Map(),
  unresolvableSurfaces: ["slack"],
  teamsRosterVisible: true,
});
ok(blind.rows[0].name === "?" && blind.rows[0].note.includes("no driver credential"), "a surface with no credential reads as not-looked-up");
ok(blind.flags.filter((f) => f.kind === "unresolved").length === 0, "a surface with no credential raises no unresolved flag");

const teamsBlindRoster = buildInventory({
  envValues: { E2E_TEAMS_CHANNEL_ID: "19:abc@thread.tacv2" },
  declared: [],
  resolutions: new Map([[resolutionKey("teams", "19:abc@thread.tacv2"), { ok: true, name: "General", detail: "x" } as Resolution]]),
  unresolvableSurfaces: [],
  teamsRosterVisible: false,
});
ok(teamsBlindRoster.flags.length === 0, "with the Teams roster env unset, a Teams room raises no env-unclaimed flag");
ok(teamsBlindRoster.rows[0].note.includes("claim unknown"), "…and the row says the claim is unknown instead");

const doc = renderInventoryDoc(inventory, { unresolvableSurfaces: [] });

ok(redactId("teams", "19:abc@thread.tacv2") === "—", "redactId empties a Teams id");
ok(!doc.includes("19:abc@thread.tacv2"), "the rendered table carries no Teams channel id");
ok(doc.includes("oe-e2e-addressed-teams"), "…but it does carry the Teams room's NAME");
ok(doc.includes("`E2E_TEAMS_CHANNEL_ID`"), "…and the env var that holds the id");
ok(doc.includes("| `CA` | #general |"), "a resolved Slack room renders id and name");
ok(doc.split("\n").filter((l) => l.startsWith("## ")).length === SURFACE_ORDER.length + 2, "one section per surface, plus Flags and the limits section");
ok(doc.endsWith("\n") && !doc.includes("\n\n\n"), "the document ends with one newline and holds no triple blank");

const piped = renderInventoryDoc(
  buildInventory({
    envValues: { E2E_SLACK_CHANNEL: "CA" },
    declared: collectDeclaredRooms([{ name: "e2e-unified", reach: ["slack/T1/CA"] }], []),
    resolutions: new Map([[resolutionKey("slack", "CA"), { ok: true, name: "#a|b", detail: "x" } as Resolution]]),
    unresolvableSurfaces: [],
    teamsRosterVisible: true,
  }),
  { unresolvableSurfaces: [] },
);
ok(piped.includes("#a\\|b"), "a pipe inside a name is escaped rather than left to split the row");
const pipedRows = parseInventoryDoc(piped);
ok(pipedRows.length === 1 && pipedRows[0].name === "#a|b", "…and it parses back whole, with the row's five columns intact");

const parsed = parseInventoryDoc(doc);
ok(parsed.length === inventory.rows.length, "every rendered row parses back");
ok(parsed.find((r) => r.id === "CA")!.name === "#general", "a parsed row carries the name back");
ok(parsed.find((r) => r.id === "CA")!.envVars.join(",") === "E2E_SLACK_CHANNEL", "a parsed row carries its env vars back");
ok(parsed.find((r) => r.surface === "teams")!.name === "oe-e2e-addressed-teams", "a Teams row parses back by name");
ok(compareInventory(parsed, inventory.rows, ENV_VALUES).stale === false, "a table rendered from an inventory is not stale against that inventory");

const renamed = compareInventory(
  parsed.map((r) => (r.id === "CA" ? { ...r, name: "#proj-notion-connector" } : r)),
  inventory.rows,
  ENV_VALUES,
);
ok(renamed.stale === true, "a committed name that no longer matches the live one is stale");
ok(renamed.stale && renamed.reasons.some((x) => x.includes("slack|CA") && x.includes("#proj-notion-connector")), "…and the reason names the room and the old name");

const dropped = compareInventory(
  parsed.filter((r) => r.id !== "CA"),
  inventory.rows,
  ENV_VALUES,
);
ok(dropped.stale === true, "a room the table does not list yet is stale");

const invisible = compareInventory(
  [...parsed, { surface: "slack" as const, id: "CZ", name: "#elsewhere", envVars: ["E2E_SLACK_SOAK_CHANNEL_DEV"], claimants: ["soak"], note: "—" }],
  inventory.rows,
  ENV_VALUES,
);
ok(invisible.stale === false, "a committed row whose env var this run does not carry is not staleness");

const visibleButGone = compareInventory(
  [...parsed, { surface: "slack" as const, id: "CZ", name: "#elsewhere", envVars: ["E2E_SLACK_CHANNEL"], claimants: ["soak"], note: "—" }],
  inventory.rows,
  { ...ENV_VALUES },
);
ok(visibleButGone.stale === true, "a committed row whose env var IS set and which this run did not find is staleness");

const configRowGone = compareInventory(
  [...parsed, { surface: "slack" as const, id: "CZ", name: "#elsewhere", envVars: [], claimants: ["soak"], note: "—" }],
  inventory.rows,
  ENV_VALUES,
);
ok(configRowGone.stale === true, "a committed row with no env var comes from config, which every run reads — its absence is staleness");

const namedBefore = parseInventoryDoc(doc);
ok(namesLost(namedBefore, inventory.rows).length === 0, "nothing is lost when the fresh rows match the committed ones");

const blindedSlack = buildInventory({
  envValues: ENV_VALUES,
  declared,
  resolutions: new Map([...RESOLUTIONS].filter(([k]) => k !== resolutionKey("slack", "CA"))),
  unresolvableSurfaces: [],
  teamsRosterVisible: true,
});
const lost = namesLost(namedBefore, blindedSlack.rows);
ok(lost.length === 1, "a room that carried a name and now resolves to nothing is reported lost — exactly one");
ok(lost[0].includes("CA") && lost[0].includes("#general"), "…and the report names the room and the name that would be dropped");

ok(
  namesLost(
    [{ surface: "slack" as const, id: "CQ", name: "?", envVars: [], claimants: ["unclaimed"], note: "not looked up" }],
    [{ surface: "slack" as const, id: "CQ", name: "?", envVars: [], claimants: ["unclaimed"], note: "not looked up" }],
  ).length === 0,
  "a row that never had a name is not a loss",
);
ok(
  namesLost(
    [{ surface: "teams" as const, id: "—", name: "General", envVars: ["E2E_TEAMS_CHANNEL_ID"], claimants: ["unclaimed"], note: "—" }],
    [{ surface: "teams" as const, id: "—", name: "?", envVars: ["E2E_TEAMS_CHANNEL_ID"], claimants: ["unclaimed"], note: "does not resolve" }],
  ).length === 1,
  "a Teams row keyed on its env var still matches across a name change, so its loss is seen",
);
{
  const committed = [
    { surface: "slack" as const, id: "CA", name: "#general", envVars: ["E2E_SLACK_CHANNEL"], claimants: ["e2e-unified"], note: "—" },
    { surface: "notion" as const, id: "PN", name: "oe-e2e-addressed-notion", envVars: ["E2E_ADDRESSED_NOTION_PAGE_ID"], claimants: ["e2e-engaged"], note: "—" },
  ];
  const unseen = roomsUnseen(committed, ENV_VALUES);
  ok(unseen.length === 1, `exactly the row whose declared env var is unset here refuses the write (got ${unseen.length})`);
  ok(
    unseen[0].includes("E2E_ADDRESSED_NOTION_PAGE_ID") && unseen[0].includes("oe-e2e-addressed-notion"),
    "…and the refusal names the variable to set and the room that would be dropped",
  );

  ok(
    roomsUnseen(committed, { ...ENV_VALUES, E2E_ADDRESSED_NOTION_PAGE_ID: "PN" }).length === 0,
    "the control: with the variable SET the row is visible and the write proceeds",
  );

  ok(
    roomsUnseen(
      [{ surface: "slack" as const, id: "CX", name: "#retired", envVars: ["E2E_RETIRED_CHANNEL"], claimants: ["unclaimed"], note: "—" }],
      ENV_VALUES,
    ).length === 0,
    "a committed row naming a var ROOM_VARS no longer declares is a real removal, never a refusal",
  );

  ok(
    roomsUnseen([{ surface: "slack" as const, id: "CY", name: "#config-only", envVars: [], claimants: ["e2e-b"], note: "—" }], ENV_VALUES).length === 0,
    "a row with no env var at all is read from config on every run, so it is never unseen",
  );

  ok(
    roomsUnseen(
      [{ surface: "slack" as const, id: "CA", name: "#general", envVars: ["E2E_SLACK_CHANNEL", "E2E_SLACK_UNIFIED_CHANNEL_A"], claimants: ["e2e-unified"], note: "—" }],
      ENV_VALUES,
    ).length === 0,
    "a row whose SECOND declared var is unset still passes while the first is set — the run resolved the room",
  );

  ok(
    roomsUnseen(committed, { ...ENV_VALUES, E2E_ADDRESSED_NOTION_PAGE_ID: "   " }).length === 1,
    "a whitespace-only value counts as unset, the same way compareInventory reads visibility",
  );
}

const twoSynthetic = [
  { surface: "teams" as const, id: "—", name: "(fabricated id)", envVars: [], claimants: ["it-a"], note: "synthetic" },
  { surface: "teams" as const, id: "—", name: "(fabricated id)", envVars: [], claimants: ["it-b"], note: "synthetic" },
];
ok(new Set(twoSynthetic.map(rowKey)).size === 2, "two Teams rows that render the same name keep two distinct keys");

{
  const declared = new Set<string>([...ROOM_VARS.map((v) => v.envVar), ...Object.keys(NON_ROOM_ENV)]);
  const envNames = new Set<string>(Object.values(ENV));
  const unclassified = [...envNames].filter((n) => !declared.has(n));
  const stale = [...declared].filter((n) => !envNames.has(n));
  ok(unclassified.length === 0, `every ENV entry is a room or has a reasoned exemption — unclassified: ${unclassified.join(", ")}`);
  ok(stale.length === 0, `no exemption or room var outlives its ENV entry — stale: ${stale.join(", ")}`);
  ok(!ROOM_VARS.some((v) => v.envVar in NON_ROOM_ENV), "no var is both a room and exempt");
  ok(!declared.has("E2E_SLACK_CHANNEL_C"), "a var env.ts does not declare is not silently 'covered'");
}

ok(new Set(ROOM_VARS.map((v) => v.envVar)).size === ROOM_VARS.length, "no env var is listed twice in ROOM_VARS");
for (const spec of ROOM_VARS) ok(spec.envVar.startsWith("E2E_"), `${spec.envVar} is an e2e fixture var`);
{
  const onlyPlanned = inventoryVars(
    [{ surface: "slack" as const, envVar: "E2E_IN_BOTH", what: "a room shipped code reads" }],
    [
      {
        domain: "e2e-synthetic",
        slug: "synthetic",
        linearKey: "OESY",
        ticket: "OPE-0",
        what: "a plan used only by this assertion",
        rooms: [
          { surface: "slack" as const, envVar: "E2E_IN_BOTH", action: "create" as const, note: "already a ROOM_VARS row" },
          { surface: "slack" as const, envVar: "E2E_PLAN_ONLY", action: "create" as const, note: "the plan alone carries it" },
          { surface: "slack" as const, envVar: "E2E_REUSED", action: "reuse" as const, reuseOf: "E2E_IN_BOTH", note: "a reuse creates nothing" },
        ],
      },
    ],
  );
  ok(onlyPlanned.some((v) => v.envVar === "E2E_PLAN_ONLY"), "a room the plan CREATES and no ROOM_VARS row carries joins the inventory's vars");
  ok(onlyPlanned.filter((v) => v.envVar === "E2E_IN_BOTH").length === 1, "a var in BOTH tables appears once — the ROOM_VARS row wins, it is not duplicated");
  ok(!onlyPlanned.some((v) => v.envVar === "E2E_REUSED"), "the control: a REUSE entry makes no room, so it adds no var — only `create` does");
}
for (const plan of PROVISION_PLAN) {
  for (const room of plan.rooms) {
    if (room.action !== "create") continue;
    ok(
      ROOM_VARS.some((v) => v.envVar === room.envVar),
      `${plan.domain} creates ${room.envVar}, so a ROOM_VARS row must carry it — a planned room no code reads is a room that self-skips forever`,
    );
  }
}
for (const plan of PROVISION_PLAN) {
  for (const room of plan.rooms) {
    if (room.readByCode !== undefined) {
      ok(ROOM_VARS.some((v) => v.envVar === room.envVar), `${plan.domain}/${room.surface} declares readByCode only for a var shipped code reads`);
    }
  }
}
ok(new Set(inventoryVars().map((v) => v.envVar)).size === inventoryVars().length, "the joined var list holds no duplicate");

ok(roomName("addressed", "discord") === "oe-e2e-addressed-discord", "a created room's name is oe-e2e-<slug>-<surface>");
ok(planFor("e2e-engaged") !== undefined && planFor("addressed") !== undefined, "a plan resolves by domain name and by slug");
ok(planFor("e2e-addressed") === undefined, "the retired spelling resolves to no plan");
ok(planFor("nope") === undefined, "an unknown domain has no plan");
for (const plan of PROVISION_PLAN) {
  ok(new Set(plan.rooms.map((r) => r.surface)).size === plan.rooms.length, `${plan.domain} names each surface once`);
  ok(plan.rooms.length === SURFACE_ORDER.length, `${plan.domain} covers every surface`);
  for (const room of plan.rooms) {
    if (room.action === "reuse") ok(Boolean(room.reuseOf), `${plan.domain}/${room.surface} says which var it reuses`);
    else ok(createGuardRefusal(plan.domain, room) === null, `${plan.domain}/${room.surface} passes the create guard (got ${createGuardRefusal(plan.domain, room)})`);
    ok(room.note.length > 0, `${plan.domain}/${room.surface} carries an operator note`);
  }
}

{
  const CREATE = { surface: "slack", action: "create", note: "n" } as const;
  const overBaseVar = createGuardRefusal("e2e-engaged", { ...CREATE, envVar: "E2E_SLACK_CHANNEL", readByCode: "shipped code reads it" });
  ok(overBaseVar !== null, "REFUSED: a create over E2E_SLACK_CHANNEL, readByCode and all — the base Slack driver channel is no plan's to write");
  ok(overBaseVar?.includes("E2E_SLACK_CHANNEL") === true, `…and the refusal names the var (got ${JSON.stringify(overBaseVar)})`);
  ok(
    createGuardRefusal("e2e-engaged", { ...CREATE, envVar: "E2E_SLACK_CHANNEL" }) !== null,
    "REFUSED: the same create without readByCode — the membership test alone already stopped this one",
  );
  ok(
    createGuardRefusal("e2e-engaged", { ...CREATE, envVar: "E2E_SLACK_PRIVATE_CHANNEL", readByCode: "shipped code reads it" }) !== null,
    "REFUSED: a create over E2E_SLACK_PRIVATE_CHANNEL — the plan REUSES S11's channel, and reusing a room never earns the right to overwrite its var",
  );
  ok(
    createGuardRefusal("e2e-engaged", { ...CREATE, surface: "github", envVar: "E2E_PR_REPO", readByCode: "shipped code reads it" }) !== null,
    "REFUSED: a create over E2E_PR_REPO — same reason on the GitHub side",
  );
  ok(
    createGuardRefusal("some-other-plan", { ...CREATE, surface: "discord", envVar: "E2E_ADDRESSED_DISCORD_CHANNEL", readByCode: "shipped code reads it" }) !== null,
    "REFUSED: another plan creating into e2e-engaged's own var — ownedBy names ONE plan",
  );
  ok(
    createGuardRefusal("e2e-engaged", { ...CREATE, surface: "discord", envVar: "E2E_ADDRESSED_DISCORD_CHANNEL", readByCode: "shipped code reads it" }) === null,
    "ALLOWED: e2e-engaged creating into the var its own ROOM_VARS row declares ownedBy — the honest case the waiver exists for",
  );
  ok(
    createGuardRefusal("e2e-engaged", { ...CREATE, envVar: "E2E_NOT_A_SHIPPED_VAR" }) === null,
    "ALLOWED: a create into a var no ROOM_VARS row carries — nothing to write over",
  );
}

for (const spec of ROOM_VARS) {
  if (spec.ownedBy === undefined) continue;
  const plan = planFor(spec.ownedBy);
  ok(plan !== undefined, `${spec.envVar}'s ownedBy names a plan that exists (got ${JSON.stringify(spec.ownedBy)})`);
  ok(
    plan?.rooms.some((r) => r.envVar === spec.envVar && r.action === "create") === true,
    `${spec.envVar}'s owner actually CREATES it — ownership is the right to write, so a plan that only reuses the room may not claim it`,
  );
}

{
  ok(
    engagedVarMismatches(ENGAGED_ROOM_VARS).length === 0,
    `every J-ENGAGED journey reads the var the e2e-engaged plan names for its surface (mismatched: ${engagedVarMismatches(ENGAGED_ROOM_VARS).join(", ")})`,
  );
  ok(
    engagedVarMismatches({ ...ENGAGED_ROOM_VARS, slack: "E2E_ENGAGED_SLACK_CHANNEL" }).includes("slack"),
    "the control: the join SEES the old E2E_ENGAGED_* spelling as a mismatch",
  );
  ok(
    engagedVarMismatches({ ...ENGAGED_ROOM_VARS, teams: "E2E_ADDRESSED_TEAMS_SURFACE" }).length === 0,
    "a surface the plan covers by that var is no mismatch — the control above fails on the NAME, not on being handed an extra key",
  );
  ok(
    engagedVarMismatches({ unknownSurface: "E2E_SLACK_CHANNEL" }).includes("unknownSurface"),
    "a surface the plan does not cover at all is a mismatch — the journey would read a var no provision run writes",
  );
}

ok(new Set(PROVISION_PLAN.map((p) => p.linearKey)).size === PROVISION_PLAN.length, "no two plans share a Linear team key");
for (const plan of PROVISION_PLAN) ok(/^[A-Z0-9]{2,5}$/u.test(plan.linearKey), `${plan.domain}'s Linear key is a short upper-case key Linear accepts`);
ok(new Set(PROVISION_PLAN.map((p) => p.slug)).size === PROVISION_PLAN.length, "no two plans share a room-name slug");

console.log(`✓ fixture-inventory-lib: ${passed} assertions passed`);
