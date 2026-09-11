import { readFileSync } from "node:fs";

const FACTORIES = ["slackChannel", "discordChannel", "teamsChannel", "githubChannel", "linearChannel"] as const;

const FILES = [
  "packages/providers/slack/agent/channels/slack.ts",
  "packages/providers/discord/agent/channels/discord.ts",
  "packages/providers/teams/agent/channels/teams.ts",
  "packages/providers/github/agent/channels/github.ts",
  "packages/providers/linear/agent/channels/linear.ts",
];

const EXEMPT: ReadonlyArray<{ readonly file: string; readonly binding: string; readonly why: string }> = [
  {
    file: "packages/providers/github/agent/channels/github.ts",
    binding: "pristine",
    why: "built only to read eve's default GitHub handlers; never exported, never dispatched to",
  },
  {
    file: "packages/providers/linear/agent/channels/linear.ts",
    binding: "pristine",
    why: "built only to read eve's default Linear handlers; never exported, never dispatched to",
  },
];

const EXPECTED_PINNED = 5;

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i < 0) return line;
      const before = line.slice(0, i);
      const quotes = (before.match(/"/g) ?? []).length;
      return quotes % 2 === 1 ? line : before;
    })
    .join("\n");
}

function literalAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced object literal at index ${open}`);
}

function bindingBefore(src: string, callStart: number): string | null {
  const head = src.slice(Math.max(0, callStart - 200), callStart);
  const m = /const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(head);
  return m === null ? m : m[1];
}

const reds: string[] = [];
let pinned = 0;

for (const file of FILES) {
  const raw = readFileSync(file, "utf8");
  const src = stripLineComments(raw);
  for (const factory of FACTORIES) {
    const call = new RegExp(`\\b${factory}\\s*\\(\\s*\\{`, "g");
    for (const m of src.matchAll(call)) {
      const open = src.indexOf("{", m.index);
      const literal = literalAt(src, open);
      const binding = bindingBefore(src, m.index);
      const exempt = EXEMPT.find((e) => e.file === file && e.binding === binding);
      const hasPin = /turnPolicy\s*:\s*"queue"/.test(literal);
      if (hasPin) {
        if (exempt !== undefined) {
          reds.push(`${file}: \`${binding}\` is listed as exempt but DOES pin turnPolicy — remove it from EXEMPT.`);
          continue;
        }
        pinned++;
        continue;
      }
      if (exempt !== undefined) continue;
      const other = /turnPolicy\s*:/.test(literal);
      reds.push(
        `${file}: \`${binding ?? "(unbound)"} = ${factory}({…})\` ${other ? 'sets turnPolicy to something other than "queue"' : "does not set turnPolicy"}. ` +
          `eve defaults to "steer", which CANCELS the turn in flight when a message arrives. Add \`turnPolicy: "queue"\` ` +
          `to the config literal, or add the call to EXEMPT in this file with the reason it can never receive a delivery.`,
      );
    }
  }
}

if (pinned !== EXPECTED_PINNED && reds.length === 0) {
  reds.push(
    `expected ${EXPECTED_PINNED} pinned vendor channels, found ${pinned}. A dispatching channel factory was removed or ` +
      `renamed — update FILES/EXPECTED_PINNED here so the gate keeps covering every vendor factory.`,
  );
}

if (reds.length > 0) {
  console.error(`✗ turn-policy: ${reds.length} problem(s) with the channel turnPolicy pins:\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ turn-policy: all ${pinned} vendor-factory channels pin turnPolicy: "queue" (eve's default "steer" cancels turns). ` +
    `This scan does not reach a raw defineChannel — see the header for the channels it cannot see.`,
);
