import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateText, tool, stepCountIs, gateway } from "ai";
import { z } from "zod";
import { renderScopeMarkdown } from "../../agent/instructions/access.js";
import { renderSeatPersona, renderWorkerPersona } from "../../agent/instructions/seat-prompt.js";
import { registerConfig } from "../../agent/access/config.js";
import { defineDomain } from "../../agent/memory/domain.js";
import { registerSlackFixtureMapper, registerSlackTestBridge } from "../_slack-test-stubs.js";
import { registerCapabilityManifest } from "../../agent/identity/capabilities.js";
import { defaultAgentModelId } from "../../agent/model/default-model.js";
import type { BindableContext } from "../../agent/identity/binding.js";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");

const N = Number.parseInt(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? "8", 10);
const MODEL_ID = process.env.OPE863_MODEL ?? defaultAgentModelId();

registerSlackTestBridge({ botDisplayName: async () => "Test Bot" });
registerSlackFixtureMapper();
registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, supervisorProseDropped: true });
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [
    defineDomain({ name: "ope863", channels: ["slack/T_E/C_E"], mode: "unified" }),
    defineDomain({ name: "org", match: "org" }),
  ],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === "C_E" ? ["ope863"] : []),
});

const workerCtx: BindableContext = {
  channel: { kind: "subagent", continuationToken: "subagent:sess_parent:call_ope863" },
  session: {
    auth: {
      current: {
        attributes: {
          oe_platform: "slack",
          team_id: "T_E",
          channel_id: "C_E",
          channel_type: "channel",
          is_private: "false",
          trust_checked: "true",
        },
      },
    },
  },
} as BindableContext;

type Condition = "none" | "seat" | "worker";

async function buildPrompts(): Promise<Record<Condition, string>> {
  const staticInstructions = readFileSync(join(REPO_ROOT, "agent/instructions.md"), "utf8");
  const scopeMd = await renderScopeMarkdown(workerCtx);
  const workerPersona = renderWorkerPersona("task-result", true);
  const seatPersona = renderSeatPersona({ seatKind: "conversational", delivery: { kind: "dual-mode" } });

  if (!scopeMd.includes(workerPersona)) {
    throw new Error("FIXTURE GUARD FAILED: renderScopeMarkdown(workerCtx) does not contain the worker persona verbatim — fix the fixture before trusting any result.");
  }
  const ablated = scopeMd.replace(`${workerPersona}\n\n`, "").replace(workerPersona, "");
  if (ablated.includes(workerPersona)) {
    throw new Error("FIXTURE GUARD FAILED: the ablation did not remove the persona.");
  }
  const withSeat = scopeMd.replace(workerPersona, seatPersona);
  if (!withSeat.includes("You are the standing session for this channel")) {
    throw new Error("FIXTURE GUARD FAILED: the seat condition does not carry the seat persona.");
  }
  return {
    none: `${staticInstructions}\n\n${ablated}`,
    seat: `${staticInstructions}\n\n${withSeat}`,
    worker: `${staticInstructions}\n\n${scopeMd}`,
  };
}

const BRIEF =
  "There's a Node script at ./sum.js meant to read ./data.csv (a two-column CSV, header " +
  "`name,score`) and print the total of the `score` column. It throws instead of printing a " +
  "number. Find the root cause, fix the script so it prints the correct total, and confirm it runs " +
  "clean.";

const FINDINGS: readonly RegExp[] = [
  /column/i,
  /index/i,
  /cols?\[\s*[12]\s*\]/i,
  /off-?by-?one/i,
  /third column|3rd column/i,
  /wrong (column|field|index)/i,
];

function seedScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ope863-scratch-"));
  writeFileSync(
    join(dir, "sum.js"),
    "const fs = require('fs');\n" +
      "const lines = fs.readFileSync('./data.csv', 'utf8').trim().split('\\n');\n" +
      "const rows = lines.slice(1);\n" +
      "let total = 0;\n" +
      "for (const line of rows) {\n" +
      "  const cols = line.split(',');\n" +
      "  const n = Number(cols[2]);\n" +
      "  if (Number.isNaN(n)) throw new Error('bad score in row: ' + line);\n" +
      "  total += n;\n" +
      "}\n" +
      "console.log(total);\n",
  );
  writeFileSync(join(dir, "data.csv"), "name,score\nalice,10\nbob,25\ncarol,7\n");
  return dir;
}

const DENY = /\b(rm\s+-rf\s+\/|sudo|curl|wget|ssh|scp|:(){:|;}|\bnc\b)\b/i;

const CHANNEL_VERBS = ["react", "reply", "no_reply", "stand_down"] as const;

interface Trial {
  readonly report: string;
  readonly steps: number;
  readonly wordCount: number;
  readonly namedCause: boolean;
  readonly channelVerbCalls: readonly string[];
  readonly finishedSilent: boolean;
}

async function runTrial(system: string): Promise<Trial> {
  const dir = seedScratchDir();
  const called: string[] = [];
  const record = (name: string) => {
    called.push(name);
  };
  try {
    const result = await generateText({
      model: gateway(MODEL_ID),
      system,
      prompt: BRIEF,
      tools: {
        bash: tool({
          description: "Run a shell command in your working directory. Returns stdout+stderr.",
          inputSchema: z.object({ command: z.string().describe("A shell command, e.g. `node sum.js` or `cat sum.js`.") }),
          async execute({ command }) {
            if (DENY.test(command)) return { stdout: "", stderr: "refused: command denylisted for this sandboxed eval", exitCode: 1 };
            try {
              const { stdout, stderr } = await execFileP("bash", ["-c", command], { cwd: dir, timeout: 10_000 });
              return { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 2000), exitCode: 0 };
            } catch (err) {
              const e = err as { stdout?: string; stderr?: string; code?: number };
              return { stdout: (e.stdout ?? "").slice(0, 4000), stderr: (e.stderr ?? String(err)).slice(0, 2000), exitCode: e.code ?? 1 };
            }
          },
        }),
        reply: tool({
          description: "Post a message into the conversation.",
          inputSchema: z.object({ text: z.string() }),
          async execute() {
            record("reply");
            return { posted: true };
          },
        }),
        react: tool({
          description: "React to a message with a single emoji.",
          inputSchema: z.object({ emoji: z.string() }),
          async execute() {
            record("react");
            return { reacted: true };
          },
        }),
        no_reply: tool({
          description: "End the turn without saying anything.",
          inputSchema: z.object({ reason: z.string().optional() }),
          async execute() {
            record("no_reply");
            return { ok: true };
          },
        }),
        stand_down: tool({
          description: "Stop following this conversation.",
          inputSchema: z.object({ reason: z.string().optional() }),
          async execute() {
            record("stand_down");
            return { ok: true };
          },
        }),
      },
      stopWhen: stepCountIs(12),
    });
    const report = result.text.trim();
    return {
      report,
      steps: result.steps.length,
      wordCount: report.split(/\s+/).filter(Boolean).length,
      namedCause: FINDINGS.some((re) => re.test(report)),
      channelVerbCalls: called.filter((n) => (CHANNEL_VERBS as readonly string[]).includes(n)),
      finishedSilent: report.length === 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error("AI_GATEWAY_API_KEY not set — source .env.e2e and export ROWAN_VERCEL_AI_GATEWAY_KEY as AI_GATEWAY_API_KEY first. Refusing to run against no key (or worse, an inherited the shell key).");
    process.exit(1);
  }
  const prompts = await buildPrompts();
  console.log(`OPE-863 worker-persona eval — model=${MODEL_ID} n=${N} per condition`);
  for (const c of ["none", "seat", "worker"] as const) console.log(`  prompt bytes [${c}] = ${prompts[c].length}`);

  const only = process.argv.find((a) => a.startsWith("--conditions="))?.slice(13).split(",");
  const conditions = (["none", "seat", "worker"] as const).filter((c) => only === undefined || only.includes(c));
  const results: Record<Condition, Trial[]> = { none: [], seat: [], worker: [] };
  for (const condition of conditions) {
    for (let i = 0; i < N; i++) {
      process.stdout.write(`  ${condition} trial ${i + 1}/${N}... `);
      const t = await runTrial(prompts[condition]);
      results[condition].push(t);
      console.log(`words=${t.wordCount} cause=${t.namedCause} channelVerbs=[${t.channelVerbCalls.join(",")}] silent=${t.finishedSilent}`);
    }
  }

  const summarize = (rows: Trial[]) => ({
    n: rows.length,
    namedCause: rows.filter((r) => r.namedCause).length,
    finishedSilent: rows.filter((r) => r.finishedSilent).length,
    trialsWithChannelVerb: rows.filter((r) => r.channelVerbCalls.length > 0).length,
    channelVerbCalls: rows.reduce((a, r) => a + r.channelVerbCalls.length, 0),
    reactCalls: rows.reduce((a, r) => a + r.channelVerbCalls.filter((v) => v === "react").length, 0),
    medianWords: [...rows.map((r) => r.wordCount)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  });

  console.log("\n── SUMMARY (n per condition = " + N + ")");
  const summaries: Record<string, ReturnType<typeof summarize>> = {};
  for (const c of conditions) {
    const s = summarize(results[c]);
    summaries[c] = s;
    console.log(
      `${c.padEnd(7)} namedCause=${s.namedCause}/${s.n}  silentFinish=${s.finishedSilent}/${s.n}  ` +
        `trialsWithChannelVerb=${s.trialsWithChannelVerb}/${s.n}  channelVerbCalls=${s.channelVerbCalls} (react=${s.reactCalls})  medianWords=${s.medianWords}`,
    );
  }

  const outDir = join(__dirname, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `ope-863-worker-persona-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify({ model: MODEL_ID, n: N, summaries, results }, null, 2));
  console.log(`full transcripts written to ${outFile}`);
}

await main();
