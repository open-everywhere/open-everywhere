import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exportOrg } from "../agent/exit/export.js";
import { erasePerson } from "../agent/exit/erase.js";
import { deleteTranscript } from "../agent/exit/transcript-delete.js";
import { HOSTED_TRANSCRIPTS_NOTE, type TranscriptStore } from "../agent/exit/transcript-store.js";
import { LOCAL_WORKFLOW_DATA_DIR } from "../agent/exit/workflow-world.js";
import { deploymentOrg } from "../agent/identity/deployment-identity.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { SET_BY_CLI } from "../agent/credentials/operator-secrets.js";
import { connectOperatorMemory, connectOperatorStore, declareOperatorOrg, loadRootOfTrustEnv } from "./operator-store-connect.js";

export interface ExitCliIo {
  out(line: string): void;
  err(line: string): void;
  readonly cwd: string;
}

const USAGE = [
  "usage:",
  "  oe export --out DIR                          export everything the org holds, in open formats",
  "  oe erase --person KEY [--dm ROOM]… --yes     erase one person's data (KEY: platform/id or platform/workspace/id)",
  "  oe transcript delete SESSION_ID              delete one session transcript (SESSION_ID starts with wrun_)",
  "",
  "  --org ORG               the org (default \"default\")",
  "  --root-env PATH         read DATABASE_URL from PATH (default ./.env.local)",
  "  --transcripts-dir DIR   eve's workflow data on the host that serves the agent (default ./.eve/.workflow-data when it exists)",
  "  --json                  print the report as JSON",
].join("\n");

const VALUE_FLAGS = ["--out", "--person", "--dm", "--org", "--root-env", "--transcripts-dir"];

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

function flagValues(args: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) out.push(args[i + 1]!);
    else if (args[i]!.startsWith(`${name}=`)) out.push(args[i]!.slice(name.length + 1));
  }
  return out;
}

function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.includes(a) && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function operatorTranscriptStore(args: readonly string[], cwd: string): TranscriptStore | undefined {
  const named = flagValue(args, "--transcripts-dir");
  if (named !== undefined) return { kind: "local", dataDir: resolve(cwd, named) };
  const fallback = resolve(cwd, LOCAL_WORKFLOW_DATA_DIR);
  return existsSync(fallback) ? { kind: "local", dataDir: fallback } : undefined;
}

function transcriptLine(store: TranscriptStore | undefined): string {
  if (store === undefined) {
    return "transcripts: not reached — on Vercel they are in the hosted workflow store, which offers no export or delete; off Vercel, run on the host that serves the agent or pass --transcripts-dir";
  }
  return store.kind === "local" ? `transcripts: ${store.dataDir}` : `transcripts: ${HOSTED_TRANSCRIPTS_NOTE}`;
}

export async function runExitCommand(command: string, args: readonly string[], io: ExitCliIo): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const json = args.includes("--json");
  loadRootOfTrustEnv(resolve(io.cwd, flagValue(args, "--root-env") ?? ".env.local"));
  declareOperatorOrg(flagValue(args, "--org"));
  const transcripts = operatorTranscriptStore(args, io.cwd);
  try {
    if (command === "export") {
      const out = flagValue(args, "--out");
      if (out === undefined) {
        io.err("✗ oe export: --out DIR is required.");
        io.err(USAGE);
        return 2;
      }
      const target = await connectOperatorStore();
      const memory = await connectOperatorMemory();
      const manifest = await exportOrg({
        store: getOperationalStore(),
        org: deploymentOrg(),
        outDir: resolve(io.cwd, out),
        memory: memory.providers,
        ...(transcripts ? { transcripts } : {}),
        actor: SET_BY_CLI,
      });
      if (json) io.out(JSON.stringify(manifest, null, 2));
      else {
        const rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
        io.out(`✓ exported org "${manifest.org}" from ${target.label} to ${resolve(io.cwd, out)}`);
        io.out(`  ${manifest.tables.length} tables, ${rows} rows · memory: ${memory.label}, ${manifest.memory.reduce((n, m) => n + m.files, 0)} files`);
        io.out(`  ${transcriptLine(transcripts)} (${manifest.transcripts.runs} runs)`);
        io.out(`  audit chain: ${manifest.auditChain.rows} rows, ${manifest.auditChain.verified ? "verified" : `${manifest.auditChain.breaks} break(s) — see manifest.json`}`);
        io.out("  Secret values are not in the export. manifest.json lists everything that is not.");
      }
      return 0;
    }

    if (command === "erase") {
      const person = flagValue(args, "--person");
      if (person === undefined) {
        io.err("✗ oe erase: --person KEY is required (for example slack/T0123/U0456).");
        io.err(USAGE);
        return 2;
      }
      if (!args.includes("--yes")) {
        io.err(`✗ oe erase: this deletes ${person}'s data and cannot be undone. Run \`oe export\` first if you need a copy, then add --yes.`);
        return 2;
      }
      await connectOperatorStore();
      const memory = await connectOperatorMemory();
      const report = await erasePerson({
        store: getOperationalStore(),
        org: deploymentOrg(),
        person,
        dmRooms: flagValues(args, "--dm"),
        memory: memory.providers,
        ...(transcripts ? { transcripts } : {}),
        actor: SET_BY_CLI,
      });
      if (json) io.out(JSON.stringify(report, null, 2));
      else {
        const rows = Object.values(report.rows).reduce((n, v) => n + v, 0);
        io.out(`✓ erased ${person}: ${rows} rows in ${Object.keys(report.rows).length} tables, ${report.dmRooms.length} DM room(s), ${report.memoryTiers} DM memory tier(s)`);
        if (report.dmRooms.length === 0) io.out("  No DM room found. Pass --dm ROOM, or the DM tail, DM memory and DM transcripts stay.");
        io.out(`  ${transcriptLine(transcripts)} — ${report.transcripts.deleted} deleted, ${report.transcripts.live} still running (not touched)`);
        if (report.transcripts.shared.length > 0) {
          io.out(`  ${report.transcripts.shared.length} shared session(s) kept, because other people took part. Delete one with \`oe transcript delete <id>\`:`);
          for (const s of report.transcripts.shared) io.out(`    ${s}`);
        }
        io.out("  Kept: the audit log, the usage and tool-call ledgers (append-only), and spend counters. The audit row names the person by hash only.");
        io.out(`  Kept by design: ${Object.keys(report.kept).join(", ")} — docs/security/exit-and-your-data.md says why.`);
        io.out("  Not ended: stored OAuth tokens, the saved browser profile and the grants this person lends. Run revoke_link_set first (offboarding), then this.");
        if (report.refused.length > 0) {
          io.err(`✗ this store role may not delete from ${report.refused.join(", ")}. Run \`oe erase\` again with the owner DATABASE_URL to finish.`);
        }
      }
      return report.refused.length > 0 ? 1 : 0;
    }

    if (command === "transcript") {
      const [verb, sessionId] = positionals(args);
      if (verb !== "delete" || sessionId === undefined) {
        io.err("✗ oe transcript: the one verb is `delete SESSION_ID`.");
        io.err(USAGE);
        return 2;
      }
      if (transcripts === undefined) {
        io.err(`✗ oe transcript delete: ${transcriptLine(undefined)}.`);
        return 1;
      }
      await connectOperatorStore();
      const r = await deleteTranscript({ store: getOperationalStore(), org: deploymentOrg(), sessionId, transcripts, actor: SET_BY_CLI });
      if (json) io.out(JSON.stringify(r, null, 2));
      else if (r.outcome === "refused-live") {
        io.err(
          r.status === "unreadable" || r.status === "unknown"
            ? `✗ ${sessionId} has no readable run record, so nothing proves it finished. Check runs/${sessionId}.json by hand.`
            : `✗ ${sessionId} is still running. Stop it first, then delete it.`,
        );
      }
      else io.out(r.outcome === "deleted" ? `✓ deleted ${sessionId} (${r.files} files, ${r.captures} captures)` : `✓ ${sessionId} is not in ${transcripts.kind === "local" ? transcripts.dataDir : "the hosted store"} — nothing to delete there (${r.captures} captures removed)`);
      return r.outcome === "refused-live" ? 1 : 0;
    }

    io.err(`oe: unknown exit-kit command "${command}".`);
    return 2;
  } catch (err) {
    io.err(`✗ oe ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
