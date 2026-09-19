import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SET_BY_CLI,
  listOperatorSecrets,
  operatorSecretEnvFallbackPresent,
  parseSecretEnvFile,
  removeOperatorSecret,
  setOperatorSecret,
  type SecretWriteResult,
} from "../agent/credentials/operator-secrets.js";
import { connectOperatorStore, declareOperatorOrg, loadRootOfTrustEnv } from "./operator-store-connect.js";

export interface SecretCliIo {
  out(line: string): void;
  err(line: string): void;
  readStdin(): Promise<string>;
}

const USAGE = [
  "usage:",
  "  oe secret set <name>                    read the value from stdin",
  "  oe secret set <name> --value-file PATH  read the value from a file (bytes preserved)",
  "  oe secret set --from-file PATH          batch-load a .env-shaped KEY=VALUE file",
  "  oe secret list [--all] [--json]         names + provenance ONLY (never values)",
  "  oe secret rm <name>                     delete one stored secret",
  "",
  "  --root-env PATH   read DATABASE_URL / OE_CREDENTIAL_ENCRYPTION_KEY from PATH (default ./.env.local)",
  "  --org ORG         the org the rows are keyed by (default \"default\"; a deployment declares its own in agent/identity/surfaces.ts)",
  "  --as LABEL        stamp the row's provenance as operator:cli:LABEL",
  "",
  "  There is deliberately no --value flag (argv leaks to shell history and ps) and no `get`.",
].join("\n");

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (valueFlags.includes(a) && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const VALUE_FLAGS = ["--value-file", "--from-file", "--root-env", "--org", "--as"];

function stripOneTrailingNewline(text: string): string {
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

export async function runSecretCommand(args: readonly string[], io: SecretCliIo): Promise<number> {
  const verb = args[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.out(USAGE);
    return verb === undefined ? 2 : 0;
  }
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const org = flagValue(rest, "--org");
  const label = flagValue(rest, "--as");
  const setBy = label ? `${SET_BY_CLI}:${label}` : SET_BY_CLI;

  loadRootOfTrustEnv(resolve(flagValue(rest, "--root-env") ?? ".env.local"));
  declareOperatorOrg(org);

  try {
    switch (verb) {
      case "set":
        return await runSet(rest, io, { json, setBy, ...(org ? { org } : {}) });
      case "list":
        return await runList(rest, io, { json, ...(org ? { org } : {}) });
      case "rm":
      case "remove":
      case "delete":
        return await runRemove(rest, io, { json, ...(org ? { org } : {}) });
      default:
        io.err(`oe secret: unknown verb "${verb}". Known: set, list, rm.`);
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    io.err(`✗ oe secret ${verb}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runSet(
  args: readonly string[],
  io: SecretCliIo,
  opts: { json: boolean; setBy: string; org?: string },
): Promise<number> {
  const fromFile = flagValue(args, "--from-file");
  const valueFile = flagValue(args, "--value-file");
  const names = positionals(args, VALUE_FLAGS);

  if (fromFile !== undefined) {
    if (names.length > 0) {
      io.err(`✗ oe secret set: --from-file loads every name in the file — drop the "${names[0]}" argument.`);
      return 2;
    }
    const parsed = parseSecretEnvFile(readFileSync(resolve(fromFile), "utf8"));
    for (const problem of parsed.errors) io.err(`✗ ${resolve(fromFile)} ${problem}`);
    if (parsed.errors.length > 0) {
      io.err(`✗ oe secret set --from-file: ${parsed.errors.length} unusable line(s) — NOTHING was written.`);
      return 1;
    }
    if (parsed.entries.length === 0) {
      io.err(`✗ oe secret set --from-file: ${resolve(fromFile)} contains no KEY=VALUE lines.`);
      return 1;
    }
    const target = await connectOperatorStore();
    const written: SecretWriteResult[] = [];
    try {
      for (const entry of parsed.entries) {
        written.push(await setOperatorSecret({ name: entry.name, value: entry.value, setBy: opts.setBy, ...(opts.org ? { org: opts.org } : {}) }));
      }
    } catch (err) {
      for (const w of written) io.err(`  · already stored: ${w.name}`);
      throw err;
    }
    if (opts.json) io.out(JSON.stringify({ ok: true, store: target.label, set: written.map(redact) }, null, 2));
    else {
      io.out(`✓ stored ${written.length} secret(s) in ${target.label}:`);
      for (const w of written) io.out(`  ${line(w)}`);
      io.out(nextStepHint());
    }
    return 0;
  }

  if (names.length !== 1) {
    io.err(names.length === 0 ? "✗ oe secret set: a name is required." : `✗ oe secret set: one name at a time (got ${names.length}).`);
    io.err(USAGE);
    return 2;
  }
  const name = names[0]!;
  const raw = valueFile !== undefined ? readFileSync(resolve(valueFile), "utf8") : await io.readStdin();
  const value = stripOneTrailingNewline(raw);
  if (value.length === 0) {
    io.err(`✗ oe secret set ${name}: the value was empty (nothing on stdin?). Use \`oe secret rm ${name}\` to delete a secret.`);
    return 1;
  }
  const target = await connectOperatorStore();
  const result = await setOperatorSecret({ name, value, setBy: opts.setBy, ...(opts.org ? { org: opts.org } : {}) });
  if (opts.json) io.out(JSON.stringify({ ok: true, store: target.label, set: [redact(result)] }, null, 2));
  else {
    io.out(`✓ stored in ${target.label}: ${line(result)}`);
    io.out(nextStepHint());
  }
  return 0;
}

async function runList(args: readonly string[], io: SecretCliIo, opts: { json: boolean; org?: string }): Promise<number> {
  const target = await connectOperatorStore();
  const rows = await listOperatorSecrets({ includeInternal: args.includes("--all"), ...(opts.org ? { org: opts.org } : {}) });
  if (opts.json) {
    io.out(JSON.stringify({ store: target.label, secrets: rows }, null, 2));
    return 0;
  }
  io.out(`stored secrets — ${target.label}`);
  if (rows.length === 0) {
    io.out("  (none — `oe secret set <name>` reads the value from stdin)");
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    io.out(`  ${r.name.padEnd(width)}  set ${r.setAt}  by ${r.setBy}${r.internal ? "  [internal — host-minted]" : ""}`);
  }
  io.out(`  ${rows.length} secret(s). Values are write-only: there is no command that reads one back.`);
  return 0;
}

async function runRemove(args: readonly string[], io: SecretCliIo, opts: { json: boolean; org?: string }): Promise<number> {
  const names = positionals(args, VALUE_FLAGS);
  if (names.length !== 1) {
    io.err(`✗ oe secret rm: exactly one name (got ${names.length}).`);
    return 2;
  }
  const name = names[0]!;
  const target = await connectOperatorStore();
  const removed = await removeOperatorSecret(name, opts.org ? { org: opts.org } : {});
  const envFallbackPresent = operatorSecretEnvFallbackPresent(name);
  if (opts.json) io.out(JSON.stringify({ ok: removed, store: target.label, removed: removed ? [name] : [], envFallbackPresent }, null, 2));
  else if (removed && envFallbackPresent)
    io.out(
      `✓ removed "${name}" from ${target.label} — the ciphertext row is DELETED, not retired. ⚠ An environment variable named "${name}" is set in THIS process, so the name still resolves here, from the environment. Delete the variable too to retire the value; the deployment's own host may hold one as well.`,
    );
  else if (removed)
    io.out(
      `✓ removed "${name}" from ${target.label} — the ciphertext row is DELETED, not retired. Anything still resolving it fails closed, unless the process that resolves it holds an environment variable of the same name (this one does not).`,
    );
  else io.out(`· nothing to remove: no secret named "${name}" in ${target.label}.`);
  return removed ? 0 : 1;
}

function line(r: SecretWriteResult): string {
  return `${r.name} (${r.bytes} bytes, ${r.replaced ? "replaced" : "new"}) at ${r.at}`;
}

function redact(r: SecretWriteResult): SecretWriteResult {
  return { name: r.name, bytes: r.bytes, at: r.at, replaced: r.replaced };
}

function nextStepHint(): string {
  return "  Point the credential at it with `broker: \"db\"` + `secretRef: \"<name>\"`, then delete the env var.";
}

export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("reading the secret value from stdin — paste it, then press Ctrl-D:\n");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
