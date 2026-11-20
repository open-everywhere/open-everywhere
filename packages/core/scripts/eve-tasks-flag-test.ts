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

// eve 1.x writes nitro's own flag as an object literal (`{experimental:{tasks:!0}}` in
// internal/nitro/host/host-routes.js). A field set to a constant boolean is a WRITE, not a read, and
// counts with the 0.x `.options.` write as the one excluded nitro site.
const constantWrite = (field: string): RegExp => new RegExp(String.raw`^experimental\s*:\s*\{\s*${field}\s*:\s*(?:!0|!1|true|false)\s*[,}]`, "u");

function inProse(src: string, anchor: number): boolean {
  if (src[anchor - 1] !== " ") return false;
  const open = src.lastIndexOf("`", anchor - 1);
  if (open === -1 || anchor - open > 600) return false;
  const sentence = src.slice(open + 1, anchor);
  return /^[A-Z]/u.test(sentence) && !/[;{}=()]/u.test(sentence) && sentence.trim().split(/\s+/u).length >= 6;
}

interface Read {
  readonly shape: string;
  readonly excerpt: string;
}

interface Scan {
  readonly reads: readonly Read[];
  readonly excluded: number;
  readonly prose: number;
}

function scanForFlagReads(src: string, field: string): Scan {
  const reads: Read[] = [];
  let excluded = 0;
  let prose = 0;
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
      if (NITRO_OPTION_RECEIVER.test(src.slice(Math.max(0, anchor - 40), anchor)) || constantWrite(field).test(src.slice(m.index, m.index + m[0].length + 12))) {
        excluded++;
        continue;
      }
      if (inProse(src, anchor)) {
        prose++;
        continue;
      }
      reads.push({ shape: name, excerpt: src.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20) });
    }
  }
  return { reads, excluded, prose };
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
    ["bare read after `return`", "let t=1;return experimental.tasks"],
    ["bare read after a template literal", "let m=`Unknown key`;if(t)return experimental.tasks;"],
  ];
  for (const [label, src] of mustMatch) {
    ok(scanForFlagReads(src, "tasks").reads.length > 0, `PIN 1: the matcher sees a ${label} read of the flag — it can fail`);
  }

  const mustNotMatch: readonly [string, string][] = [
    ["nitro's own option bag", "e.options.experimental.tasks=!0;"],
    ["nitro's option bag, optional", "e?.options?.experimental?.tasks=!0;"],
    ["nitro's config written as an object literal", "return{tasks:s,...e.length>0&&{experimental:{tasks:!0}}}"],
    ["a sibling experimental field", "if(t.experimental.workflow){}"],
    ["an unrelated `tasks` owner", "for(const x of session.tasks){}"],
    ["a name that merely contains both words", "const experimentalTasksEnabled=!1;"],
    ["a release-note sentence that names the flag", "21:`Background task execution was removed: subagent results no longer carry backgroundTask, and experimental.tasks is gone.`"],
  ];
  for (const [label, src] of mustNotMatch) {
    ok(scanForFlagReads(src, "tasks").reads.length === 0, `PIN 1: the matcher does NOT fire on ${label}`);
  }
  ok(
    scanForFlagReads("e.options.experimental.tasks=!0;", "tasks").excluded === 1,
    "PIN 1: the nitro exclusion is what drops the option write — it is doing the work, not a shape gap",
  );
  ok(
    scanForFlagReads("return{tasks:s,...e.length>0&&{experimental:{tasks:!0}}}", "tasks").excluded === 1,
    "PIN 1: the constant-write exclusion is what drops nitro's 1.x object-literal write — it is doing the work, not a shape gap",
  );
  ok(
    scanForFlagReads("const b={experimental:{tasks:t}};", "tasks").reads.length === 1,
    "PIN 1: …and a non-constant value under the same key is still a read",
  );
  ok(
    scanForFlagReads("`Background task execution was removed: and experimental.tasks is gone.`", "tasks").prose === 1,
    "PIN 1: the prose exclusion is what drops the release-note sentence — it is doing the work, not a shape gap",
  );
}

const carriesExperimental = filesMatching(/experimental/u);
{
  ok(
    carriesExperimental.length > 0,
    "PIN 2: eve's `dist/src` still holds modules naming `experimental` — the walk resolved a real tree",
  );
  // eve 1.x's agent `experimental` block holds `workflow` alone (compiler/manifest-schema.js is a strict
  // `{ workflow }` object); 0.x also read `instrumentationProviders`, which 1.x no longer has.
  for (const sibling of ["workflow"]) {
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
  const proseIn: string[] = [];
  for (const rel of carriesExperimental) {
    const { reads, excluded, prose } = scanForFlagReads(readEveDist(rel), "tasks");
    for (const read of reads) offenders.push(`${rel} (${read.shape}): ${read.excerpt.replaceAll("\n", " ")}`);
    if (excluded > 0) excludedIn.push(`${rel} ×${String(excluded)}`);
    if (prose > 0) proseIn.push(`${rel} ×${String(prose)}`);
  }
  ok(
    offenders.length === 0,
    `PIN 3 🔴 OPE-1491: eve ${eveVersion} now READS \`experimental.tasks\`, so a build that sets the flag can return to the BLOCKING delegation shape — and OE's copy still tells the seat "\`agent\` does NOT block", so that seat would wait for an answer it already has. Re-read the release, then fix the seat copy in agent/access/worker-capabilities.ts and the claims in docs/glossary.md, docs/how-it-works/agent-and-loop.md, agent/access/consequence.ts and agent/access/window-gate-manifest.ts before changing this pin. Reads found:\n  ${offenders.join("\n  ")}`,
    );
  ok(
    excludedIn.length === 1 && excludedIn[0]!.endsWith("×1"),
    `PIN 3 OPE-1491: the nitro exclusions no longer drop exactly one match. They exist for ONE site — nitro's own flag write, which on eve 1.x is the object literal \`{experimental:{tasks:!0}}\` in \`internal/nitro/host/host-routes.js\` (dropped by the constant-write exclusion; on eve 0.x it was \`<app>.options.experimental.tasks=!0\` in \`internal/nitro/host/schedule-task-routes.js\`), which arms nitro's schedule-task routes and is not the agent definition. Read each site below and decide whether it is nitro's option bag or a real read the exclusion is now hiding: ${excludedIn.join(", ") || "(none — the nitro write is gone, so the exclusion is dead and should go)"}`,
  );
  ok(
    proseIn.length === 0,
    `PIN 3: the prose exclusion drops a match on eve 1.x, which ships no prose that names the flag (0.x had ONE sentence in \`compiler/extension-compatibility.js\`, eve's note "…and experimental.tasks is gone."), so the exclusion must hide nothing. Read each site below and decide whether it is prose or a real read the rule is now hiding: ${proseIn.join(", ") || "(none — the note is gone, so the exclusion is dead and should go)"}`,
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
      /\bworkflow\b/u.test(list),
      `PIN 4: the parsed allow-list still names \`workflow\`, so the capture is the real list and not an empty match (got: ${list})`,
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
  const body = /export interface AgentExperimentalDefinition \{([\s\S]*?)\n\}/u.exec(declaration)?.[1];
  ok(
    body !== undefined,
    "PIN 5 OPE-2321: `shared/agent-definition.d.ts` no longer declares `AgentExperimentalDefinition` — the module moved. Re-home this path pin before reading the field list",
  );
  ok(
    /readonly workflow\?:/u.test(body ?? ""),
    `PIN 5: the interface body is the real one — it declares \`workflow?\` (got: ${JSON.stringify(body)})`,
  );
  ok(
    !/\btasks\b/u.test(body ?? ""),
    `PIN 5 🔴 OPE-2321: \`AgentExperimentalDefinition\` declares \`tasks\` again at eve ${eveVersion}. eve 0.71.0 removed it. A type that accepts the key again is the first half of a re-arm: re-read the release, then re-run PINs 3 and 4 before trusting OE's "\`agent\` does NOT block" seat copy`,
  );
}

console.log(`eve-tasks-flag: ${String(n)} assertions passed (eve ${eveVersion}, ${String(carriesExperimental.length)} modules named \`experimental\`)`);
