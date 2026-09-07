import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { filesContainingAll, filesMatching, readEveDist } from "./eve-dist-search.js";

let n = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  n++;
}

const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;

const RECEIVER = String.raw`(?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)*`;

const READ_SHAPES: readonly { readonly name: string; readonly build: (field: string) => RegExp }[] = [
  { name: "member access", build: (f) => new RegExp(String.raw`experimental\s*\.\s*${f}\b`, "gu") },
  { name: "optional member access", build: (f) => new RegExp(String.raw`experimental\s*\?\.\s*${f}\b`, "gu") },
  { name: "computed access", build: (f) => new RegExp(String.raw`experimental\s*(?:\?\.)?\s*\[\s*["'\x60]${f}["'\x60]\s*\]`, "gu") },
  { name: "destructured off `experimental`", build: (f) => new RegExp(String.raw`\{[^{}]{0,200}\b${f}\b[^{}]{0,200}\}\s*=\s*${RECEIVER}experimental\b`, "gu") },
  { name: "`experimental` binding pattern", build: (f) => new RegExp(String.raw`experimental\s*:\s*\{[^{}]{0,200}\b${f}\b`, "gu") },
  { name: "`in` presence test", build: (f) => new RegExp(String.raw`["'\x60]${f}["'\x60]\s*in\s+${RECEIVER}experimental\b`, "gu") },
  { name: "`hasOwn` presence test", build: (f) => new RegExp(String.raw`hasOwn\w*\([^()]{0,120}?${RECEIVER}experimental\s*,\s*["'\x60]${f}["'\x60]`, "gu") },
];

const NITRO_OPTION_RECEIVER = /(?:\?\.|\.)\s*options\s*(?:\?\.|\.)\s*$/u;

interface Read {
  readonly shape: string;
  readonly excerpt: string;
}

interface Scan {
  readonly reads: readonly Read[];
  readonly excluded: number;
}

function scanForFlagReads(src: string, field: string): Scan {
  const reads: Read[] = [];
  let excluded = 0;
  for (const { name, build } of READ_SHAPES) {
    const scan = build(field);
    let m: RegExpExecArray | null;
    while ((m = scan.exec(src)) !== null) {
      if (m[0].length === 0) {
        scan.lastIndex++;
        continue;
      }
      const named = src.indexOf("experimental", m.index);
      const anchor = named === -1 ? m.index : named;
      if (NITRO_OPTION_RECEIVER.test(src.slice(Math.max(0, anchor - 40), anchor))) {
        excluded++;
        continue;
      }
      reads.push({ shape: name, excerpt: src.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20) });
    }
  }
  return { reads, excluded };
}

console.log(`eve-tasks-flag: pinning against installed eve ${eveVersion}`);

{
  const mustMatch: readonly [string, string][] = [
    ["member access", "if(t.experimental.tasks){return background()}"],
    ["optional member access", "const b=definition.experimental?.tasks??!1;"],
    ["computed access", 'if(d.experimental["tasks"]){}'],
    ["computed optional access", "if(d.experimental?.[`tasks`]){}"],
    ["destructured", "const{instrumentationProviders:i,tasks:t}=e.definition.experimental;"],
    ["destructured, bare source", "const{tasks}=experimental;"],
    ["binding pattern", "function f({experimental:{tasks:t}}){return t}"],
    ["`in` presence test", 'if("tasks" in e.definition.experimental){}'],
    ["`hasOwn` presence test", 'if(Object.hasOwn(e.experimental,"tasks")){}'],
    ["minified member access", "return e.experimental.tasks===!0?`background`:`sync`"],
  ];
  for (const [label, src] of mustMatch) {
    ok(scanForFlagReads(src, "tasks").reads.length > 0, `PIN 1: the matcher sees a ${label} read of the flag — it can fail`);
  }

  const mustNotMatch: readonly [string, string][] = [
    ["nitro's own option bag", "e.options.experimental.tasks=!0;"],
    ["nitro's option bag, optional", "e?.options?.experimental?.tasks=!0;"],
    ["a sibling experimental field", "if(t.experimental.workflow){}"],
    ["an unrelated `tasks` owner", "for(const x of session.tasks){}"],
    ["a name that merely contains both words", "const experimentalTasksEnabled=!1;"],
  ];
  for (const [label, src] of mustNotMatch) {
    ok(scanForFlagReads(src, "tasks").reads.length === 0, `PIN 1: the matcher does NOT fire on ${label}`);
  }
  ok(
    scanForFlagReads("e.options.experimental.tasks=!0;", "tasks").excluded === 1,
    "PIN 1: the nitro exclusion is what drops the option write — it is doing the work, not a shape gap",
  );
}

const carriesExperimental = filesMatching(/experimental/u);
{
  ok(
    carriesExperimental.length > 0,
    "PIN 2: eve's `dist/src` still holds modules naming `experimental` — the walk resolved a real tree",
  );
  for (const sibling of ["instrumentationProviders", "workflow"]) {
    let found = 0;
    for (const rel of carriesExperimental) found += scanForFlagReads(readEveDist(rel), sibling).reads.length;
    ok(
      found > 0,
      `PIN 2 🔴: the matcher finds NO read of \`experimental.${sibling}\` in eve ${eveVersion} — a sibling flag eve certainly reads. The shape set has fallen behind eve's minified output, so PIN 3's silence about \`tasks\` proves nothing. Fix the shapes before trusting this file`,
    );
  }
}

{
  const offenders: string[] = [];
  const excludedIn: string[] = [];
  for (const rel of carriesExperimental) {
    const { reads, excluded } = scanForFlagReads(readEveDist(rel), "tasks");
    for (const read of reads) offenders.push(`${rel} (${read.shape}): ${read.excerpt.replaceAll("\n", " ")}`);
    if (excluded > 0) excludedIn.push(`${rel} ×${String(excluded)}`);
  }
  ok(
    offenders.length === 0,
    `PIN 3 🔴 OPE-1491: eve ${eveVersion} now READS \`experimental.tasks\`, so a build that sets the flag can return to the BLOCKING delegation shape — and OE's copy still tells the seat "\`agent\` does NOT block", so that seat would wait for an answer it already has. Re-read the release, then fix the seat copy in agent/access/worker-capabilities.ts and the claims in docs/glossary.md, docs/how-it-works/agent-and-loop.md, agent/access/consequence.ts and agent/access/window-gate-manifest.ts before changing this pin. Reads found:\n  ${offenders.join("\n  ")}`,
    );
  ok(
    excludedIn.length === 1 && excludedIn[0]!.endsWith("×1"),
    `PIN 3 OPE-1491: the \`.options.\` exclusion no longer drops exactly one match. It exists for ONE site — nitro's \`<app>.options.experimental.tasks=!0\` in \`internal/nitro/host/schedule-task-routes.js\`, which arms nitro's schedule-task routes and is not the agent definition. Read each site below and decide whether it is nitro's option bag or a real read the exclusion is now hiding: ${excludedIn.join(", ") || "(none — the nitro write is gone, so the exclusion is dead and should go)"}`,
  );
}

{
  const holders = filesContainingAll("normalizeAgentExperimentalDefinition", "expectOnlyKnownKeys");
  ok(
    holders.length > 0,
    "PIN 4 OPE-1491: no module under eve's `dist/src` holds both `normalizeAgentExperimentalDefinition` and `expectOnlyKnownKeys` any more. eve has restructured how it validates the authored `experimental` block — read the release and re-home this pin before trusting the claim that the compiler refuses `tasks`",
  );
  const allowLists: string[] = [];
  for (const rel of holders) {
    const shape = /normalizeAgentExperimentalDefinition\([^)]*\)\{[\s\S]{0,400}?expectOnlyKnownKeys\([A-Za-z_$][\w$]*,\[([^\]]*)\]/u.exec(readEveDist(rel));
    if (shape?.[1] !== undefined) allowLists.push(shape[1]);
  }
  ok(
    allowLists.length > 0,
    "PIN 4 OPE-1491: `normalizeAgentExperimentalDefinition` no longer guards its keys with an `expectOnlyKnownKeys` allow-list. The compiler may now ACCEPT an authored `experimental.tasks` — read the release before trusting OE's delegation copy",
  );
  for (const list of allowLists) {
    ok(
      list.includes("instrumentationProviders"),
      `PIN 4: the parsed allow-list still names \`instrumentationProviders\`, so the capture is the real list and not an empty match (got: ${list})`,
    );
    ok(
      !/\btasks\b/u.test(list),
      `PIN 4 🔴 OPE-1491: eve ${eveVersion} has RE-ARMED \`experimental.tasks\` — its compiler now accepts the key (allow-list: ${list}), so a deployment can ask for the BLOCKING delegation shape again. OE's seat copy in agent/access/worker-capabilities.ts still says "\`agent\` does NOT block", and a seat reading it on a re-armed build waits for an answer it already has. Re-read the release and fix that copy, plus the claims in docs/glossary.md, docs/how-it-works/agent-and-loop.md, agent/access/consequence.ts and agent/access/window-gate-manifest.ts, before changing this pin`,
    );
  }
}

{
  let declaration: string;
  try {
    declaration = readEveDist("shared/agent-definition.d.ts");
  } catch {
    declaration = "";
  }
  ok(
    declaration.includes("readonly tasks?: boolean"),
    "PIN 5 OPE-1491: `AgentExperimentalDefinition` no longer declares `tasks?: boolean` at `shared/agent-definition.d.ts` — either the module moved or eve really has REMOVED the field. Read the release: if the field is gone, the repo's prose may say `removed` again, and this file's premise (the field exists, only the read is gone) needs rewriting rather than re-homing",
  );
}

console.log(`eve-tasks-flag: ${String(n)} assertions passed (eve ${eveVersion}, ${String(carriesExperimental.length)} modules named \`experimental\`)`);
