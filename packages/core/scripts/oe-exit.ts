import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exportOrg } from "../agent/exit/export.js";
import { erasePerson } from "../agent/exit/erase.js";
import { deleteTranscript } from "../agent/exit/transcript-delete.js";
import { HOSTED_TRANSCRIPTS_NOTE, UNREACHED_TRANSCRIPTS_NOTE, type TranscriptStore } from "../agent/exit/transcript-store.js";
import { LOCAL_WORKFLOW_DATA_DIR } from "../agent/exit/workflow-world.js";
import { deploymentOrg } from "../agent/identity/deployment-identity.js";
import { endPersonAuthority, type AuthorityEnded } from "../agent/exit/authority.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { SET_BY_CLI } from "../agent/credentials/operator-secrets.js";
import { registerLongLivedBoxBackend, type LongLivedBoxBackend } from "../agent/sandbox/long-lived-box.js";
import {
  OPERATOR_BOX_BACKENDS,
  connectOperatorHolders,
  connectOperatorMemory,
  connectOperatorStore,
  declareOperatorOrg,
  loadRootOfTrustEnv,
  type OperatorBoxBackend,
} from "./operator-store-connect.js";
import { resolveTranscriptSource } from "./control-transcript-source.js";

export interface ExitCliIo {
  out(line: string): void;
  err(line: string): void;
  readonly cwd: string;
  readonly boxBackend?: LongLivedBoxBackend;
}

const USAGE = [
  "usage:",
  "  oe export --out DIR                          export everything the org holds, in open formats",
  "  oe erase --person KEY [--dm ROOM]… --yes     end one person's links, credentials and holdings, then erase their data",
  "                                               (KEY: platform/id or platform/workspace/id)",
  "  oe transcript delete SESSION_ID              delete one session transcript (SESSION_ID starts with wrun_)",
  "",
  "  --org ORG               the org (default \"default\")",
  "  --root-env PATH         read DATABASE_URL from PATH (default ./.env.local)",
  "  --transcripts-dir DIR   eve's workflow data on the host that serves the agent (default ./.eve/.workflow-data when it exists)",
  "                          With none, export reads each session the org's rows name through the deployment's transcript route (OE_DEPLOY_CONTROL_TOKEN",
  "                          and E2E_TARGET_URL / OE_DEPLOY_BASE_URL / OE_DEPLOY_ALIAS). Nothing deletes one on Vercel's hosted store.",
  "  --box-backend KIND      erase: the deployment's box backend, vercel or docker, so the person's saved browser profile",
  "                          can be deleted (none by default — a profile then stays, and the erase exits 1)",
  "  --json                  print the report as JSON",
].join("\n");

const VALUE_FLAGS = ["--out", "--person", "--dm", "--org", "--root-env", "--transcripts-dir", "--box-backend"];

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
  if (store === undefined) return UNREACHED_TRANSCRIPTS_NOTE;
  return store.kind === "local" ? `transcripts: ${store.dataDir}` : `transcripts: ${HOSTED_TRANSCRIPTS_NOTE}`;
}

function authorityLine(a: AuthorityEnded): string {
  const set =
    a.linkSet === "revoked"
      ? `link-set revoked (${a.accountsRevoked} account(s) tombstoned)`
      : a.linkSet === "already-revoked"
        ? "link-set was already revoked"
        : a.linkSet === "suggested-only"
          ? "link-set left alone (the account is only suggested onto it)"
          : "no link-set";
  return `${set}, ${a.credentialsPurged} stored credential(s) purged, ${a.grantsRevoked} lent grant(s) revoked, ${a.browsersForgotten} personal browser(s) forgotten`;
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
      const source = transcripts === undefined ? resolveTranscriptSource() : undefined;
      const transcriptReader =
        source === undefined ? undefined : source.pages !== undefined && source.baseUrl !== undefined ? { baseUrl: source.baseUrl, pages: source.pages } : { missing: source.missing };
      const manifest = await exportOrg({
        store: getOperationalStore(),
        org: deploymentOrg(),
        outDir: resolve(io.cwd, out),
        memory: memory.providers,
        ...(transcripts ? { transcripts } : {}),
        ...(transcriptReader ? { transcriptReader } : {}),
        actor: SET_BY_CLI,
      });
      if (json) io.out(JSON.stringify(manifest, null, 2));
      else {
        const rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
        io.out(`✓ exported org "${manifest.org}" from ${target.label} to ${resolve(io.cwd, out)}`);
        io.out(`  ${manifest.tables.length} tables, ${rows} rows · memory: ${memory.label}, ${manifest.memory.reduce((n, m) => n + m.files, 0)} files`);
        io.out(
          manifest.transcripts.store === "deployment"
            ? `  transcripts: ${manifest.transcripts.note} (${manifest.transcripts.runs} sessions)`
            : `  ${transcriptLine(transcripts)} (${manifest.transcripts.runs} runs)`,
        );
        const unreached = manifest.transcripts.unreached ?? [];
        if (unreached.length > 0) {
          io.out(`  ! ${unreached.length} session transcript(s) are NOT in the export. manifest.json lists each one under transcripts.unreached. The first reason:`);
          io.out(`    ${unreached[0]!.reason}`);
        }
        const incomplete = manifest.transcripts.incomplete ?? [];
        if (incomplete.length > 0) {
          io.out(`  ! ${incomplete.length} session transcript(s) end before a terminal event (parked, running, or the read idled out). manifest.json lists each one under transcripts.incomplete.`);
        }
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
      const box = flagValue(args, "--box-backend");
      if (box !== undefined && !(OPERATOR_BOX_BACKENDS as readonly string[]).includes(box)) {
        io.err(`✗ oe erase: --box-backend is ${OPERATOR_BOX_BACKENDS.join(" or ")}, not "${box}".`);
        return 2;
      }
      await connectOperatorStore();
      const holders = await connectOperatorHolders(box as OperatorBoxBackend | undefined);
      if (io.boxBackend !== undefined) registerLongLivedBoxBackend(io.boxBackend);
      const memory = await connectOperatorMemory();
      const authority = await endPersonAuthority({ org: deploymentOrg(), person, actor: SET_BY_CLI });
      if (!authority.started) {
        if (json) io.out(JSON.stringify({ authority }, null, 2));
        for (const failure of authority.failures) io.err(`✗ oe erase: ${failure}`);
        return 1;
      }
      const report = await erasePerson({
        store: getOperationalStore(),
        org: deploymentOrg(),
        person,
        dmRooms: flagValues(args, "--dm"),
        memory: memory.providers,
        ...(transcripts ? { transcripts } : {}),
        actor: SET_BY_CLI,
        authority,
      });
      const boxNamed = holders.boxBackend !== undefined || io.boxBackend !== undefined;
      if (json) io.out(JSON.stringify(report, null, 2));
      else {
        const rows = Object.values(report.rows).reduce((n, v) => n + v, 0);
        io.out(`✓ erased ${person}: ${rows} rows in ${Object.keys(report.rows).length} tables, ${report.dmRooms.length} DM room(s), ${report.memoryTiers} DM memory tier(s)`);
        io.out(`  Ended first: ${authorityLine(authority)}`);
        if (report.dmRooms.length === 0) io.out("  No DM room found. Pass --dm ROOM, or the DM tail, DM memory and DM transcripts stay.");
        io.out(`  ${transcriptLine(transcripts)} — ${report.transcripts.deleted} deleted, ${report.transcripts.live} still running (not touched)`);
        if (report.transcripts.unreached.length > 0) {
          io.out(`  ! ${report.transcripts.unreached.length} of the person's own session transcript(s) are NOT deleted: ${report.transcripts.unreachedReason ?? ""}`);
          for (const s of report.transcripts.unreached) io.out(`    ${s}`);
        }
        if (report.transcripts.shared.length > 0) {
          io.out(`  ${report.transcripts.shared.length} shared session(s) kept, because other people took part. Delete one with \`oe transcript delete <id>\`:`);
          for (const s of report.transcripts.shared) io.out(`    ${s}`);
        }
        io.out("  Kept: the audit log, the usage and tool-call ledgers (append-only), and spend counters. The audit row names the person by hash only.");
        io.out(`  Kept by design: ${Object.keys(report.kept).join(", ")} — docs/security/exit-and-your-data.md says why.`);
        if (report.refused.length > 0) {
          io.err(`✗ this store role may not delete from ${report.refused.join(", ")}. Run \`oe erase\` again with the owner DATABASE_URL to finish.`);
        }
        for (const failure of authority.failures) io.err(`✗ not ended: ${failure}`);
        for (const notice of authority.notices ?? []) io.out(`  ! left alone: ${notice}`);
        if (authority.failures.length > authority.revocationsFailed.length) {
          io.err(
            boxNamed
              ? "  Fix the cause and run `oe erase` again. A holding named on another confirmed account is ended with `oe erase --person <that account>`."
              : "  Name the deployment's box backend (--box-backend vercel|docker) if a browser profile is listed, and run `oe erase` again. A holding named on another confirmed account is ended with `oe erase --person <that account>`.",
          );
        }
      }
      return report.refused.length > 0 || authority.failures.length > 0 ? 1 : 0;
    }

    if (command === "transcript") {
      const [verb, sessionId] = positionals(args);
      if (verb !== "delete" || sessionId === undefined) {
        io.err("✗ oe transcript: the one verb is `delete SESSION_ID`.");
        io.err(USAGE);
        return 2;
      }
      if (transcripts === undefined) {
        io.err(`✗ oe transcript delete: ${sessionId} is NOT deleted. ${transcriptLine(undefined)}.`);
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
      else if (r.outcome === "hosted") io.err(`✗ ${sessionId} is NOT deleted (${r.captures} captures removed). ${HOSTED_TRANSCRIPTS_NOTE}`);
      else io.out(r.outcome === "deleted" ? `✓ deleted ${sessionId} (${r.files} files, ${r.captures} captures)` : `✓ ${sessionId} is not in ${transcripts.kind === "local" ? transcripts.dataDir : "the hosted store"} — nothing to delete there (${r.captures} captures removed)`);
      return r.outcome === "refused-live" || r.outcome === "hosted" ? 1 : 0;
    }

    io.err(`oe: unknown exit-kit command "${command}".`);
    return 2;
  } catch (err) {
    io.err(`✗ oe ${command}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
