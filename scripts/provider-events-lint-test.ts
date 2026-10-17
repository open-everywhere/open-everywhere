import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finishedRun } from "./npm-command.js";

import {
  checkProviderEvents,
  renderProviderEventTable,
  type NormalizerProbe,
  type ProviderEvent,
  type ProviderEventDeclaration,
} from "@open-everywhere/core/agent/adapter-api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(root, "scripts", "provider-events.ts");
const TSX = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const PAGE = join(root, "docs", "capabilities", "proactivity-and-routines.md");

const pageBefore = readFileSync(PAGE, "utf8");

let passed = 0;

function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(`✗ ${label}`);
  passed += 1;
}

const scratch = mkdtempSync(join(tmpdir(), "oe-provider-events-"));

try {

  const row = (over: Partial<ProviderEvent> = {}): ProviderEvent => ({
    event: "workflow_run",
    routing: "mapped",
    match: ["conclusion"],
    scope: ["entity"],
    note: "an Actions run finished",
    ...over,
  });
  const decl = (over: Partial<ProviderEventDeclaration> = {}): ProviderEventDeclaration => ({
    source: "github",
    doc: "https://docs.github.com/en/webhooks/webhook-events-and-payloads",
    events: [row()],
    ...over,
  });
  const PROBE: NormalizerProbe = new Map([
    ["github", { matchKeys: ["event", "action", "repo", "sender", "conclusion"], scopeKinds: ["tenant", "container", "entity"] }],
  ]);
  const one = (d: unknown, probe: NormalizerProbe = PROBE): readonly { message: string }[] =>
    checkProviderEvents(new Map([["p", d]]), probe);

  ok(one(decl()).length === 0, "a well-formed inventory whose keys the normalizer declares is GREEN");

  ok(
    one(decl({ events: [row({ match: ["not_a_key"] })] })).some((p) => p.message.includes("not_a_key")),
    "a match key the normalizer does not declare is RED",
  );
  ok(
    one(decl({ events: [row({ scope: ["group"] })] })).some((p) => p.message.includes("group")),
    "a scope kind the normalizer does not declare is RED",
  );
  ok(one(decl({ events: [row({ match: ["repo"], scope: ["container"] })] })).length === 0, "a key the normalizer DOES declare is green");

  ok(one(decl({ doc: "" })).some((p) => p.message.includes("doc")), "an empty vendor doc citation is RED");
  ok(one(decl({ doc: "docs.github.com/webhooks" })).some((p) => p.message.includes("doc")), "a non-https doc citation is RED");
  ok(one(decl({ events: [] })).some((p) => p.message.includes("no events")), "declaring zero events is RED");
  ok(one(decl({ events: [row({ note: "  " })] })).some((p) => p.message.includes("note")), "a blank note is RED");
  ok(one(decl({ events: [row(), row()] })).some((p) => p.message.includes("twice")), "the same event declared twice is RED");

  ok(
    one(decl({ events: [row({ routing: "mapped", match: [], scope: [] })] })).some((p) => p.message.includes("envelope")),
    "`mapped` with no mapping at all is RED",
  );
  ok(
    one(decl({ events: [row({ routing: "envelope", match: ["conclusion"], scope: [] })] })).some((p) => p.message.includes("envelope")),
    "`envelope` that names a match key is RED",
  );
  ok(one(decl({ events: [row({ routing: "envelope", match: [], scope: [] })] })).length === 0, "a genuine `envelope` row is green");

  const unwired = { doc: "https://docs.slack.dev/reference/events", events: [row({ routing: "none", match: [], scope: [] })] };
  ok(one(unwired).length === 0, "a provider with no `source` declaring every row `none` is green");
  ok(
    one({ ...unwired, events: [row({ routing: "envelope", match: [], scope: [] })] }).some((p) => p.message.includes("no `source`")),
    "a provider with no `source` claiming a routed event is RED",
  );
  ok(
    one(decl({ events: [row({ routing: "none", match: [], scope: [] })] })).length === 0,
    "a provider WITH a `source` may still declare `none` — a normalizer that declines an event routes nothing",
  );

  ok(
    one(decl({ source: "nobody" })).some((p) => p.message.includes("no event normalizer is registered")),
    "naming a source with no registered normalizer is RED",
  );

  ok(one("not an object").some((p) => p.message.includes("not an object")), "a non-object inventory is RED");
  ok(one(decl({ events: [{ event: "x" } as unknown as ProviderEvent] })).length > 0, "a row missing routing/match/scope/note is RED");
  ok(
    one(decl({ events: [row({ routing: "wired" as unknown as ProviderEvent["routing"] })] })).length > 0,
    "an unknown routing state is RED",
  );

  const piped = renderProviderEventTable("p", decl({ events: [row({ note: "a | b\nc" })] }));
  ok(piped.includes("a \\| b c"), "a note's pipe is escaped and its newline flattened");
  ok(piped.split("\n").filter((l) => l.startsWith("|")).length === 3, "one header, one rule and one body row — the newline did not split the row");

  const run = (args: readonly string[]): { status: number; out: string } => {
    const r = spawnSync(process.execPath, [TSX, GATE, ...args], { cwd: root, encoding: "utf8" });
    return { status: finishedRun(r, "the provider-events gate").status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  const green = run(["--check"]);
  ok(green.status === 0, `the gate is GREEN on the tracked tree (exit ${green.status})\n${green.out}`);
  ok(green.out.includes("mapped") && green.out.includes("not routed"), "the ledger prints on a green run, so a reader sees the gaps without failing the gate");
  for (const source of ["github", "linear", "notion"]) {
    ok(
      green.out.includes("cross-checked against the live normalizer registry") && green.out.includes(source),
      `the green line names \`${source}\` as a probed source — the CLI really read the live registry`,
    );
  }

  const copy = join(scratch, "page.md");
  const marker = "<!-- END GENERATED: provider-event-inventory -->";
  ok(pageBefore.includes(marker), "the tracked page carries the generated region's end marker");
  writeFileSync(copy, pageBefore.replace(marker, `| \`invented_event\` | ✅ mapped | — | nobody generated this |\n${marker}`));
  const perturbed = run(["--check", "--page", copy]);
  ok(perturbed.status !== 0, "a hand-edited row inside the generated region is RED");
  ok(perturbed.out.includes("out of date"), "…and the refusal says the table is out of date with the declarations");

  const noMarkers = join(scratch, "no-markers.md");
  writeFileSync(noMarkers, "# a page with no generated region\n");
  const bare = run(["--check", "--page", noMarkers]);
  ok(bare.status !== 0 && bare.out.includes("markers"), "a page missing the markers is RED, never a silent pass");

  const write = run(["--page", copy]);
  ok(write.status !== 0 && write.out.includes("requires --check"), "the write form refuses `--page`");
  ok(readFileSync(copy, "utf8").includes("invented_event"), "…and wrote nothing to it — the refusal came first");

  const clean = join(scratch, "clean.md");
  writeFileSync(clean, pageBefore);
  ok(run(["--check", "--page", clean]).status === 0, "an unperturbed copy is green — the reds above are about the edit");

  ok(readFileSync(PAGE, "utf8") === pageBefore, "the TRACKED page is byte-identical after every run above");

  console.log(`✓ provider-events lint: ${passed} assertions`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
