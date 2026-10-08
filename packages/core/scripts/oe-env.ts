import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENV_NAME_PATTERN, envAssignmentValue, envFileTargetRefusal, mergeEnv } from "../agent/ops/quickstart.js";

export interface EnvCliIo {
  out(line: string): void;
  err(line: string): void;
  readValue(name: string): Promise<string>;
}

const USAGE = [
  "usage:",
  "  oe env set <NAME>               read the value from a hidden prompt (or stdin) into ./.env.local",
  "  oe env set <NAME> --file PATH   write PATH instead (.env, .env.local or .env.<name>.local at the project root)",
  "",
  "  There is deliberately no value argument (argv leaks to shell history and ps), and nothing prints the value.",
].join("\n");

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 1);
}

function stripOneTrailingNewline(text: string): string {
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

export async function runEnvCommand(args: readonly string[], io: EnvCliIo, cwd: string = process.cwd()): Promise<number> {
  const verb = args[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.out(USAGE);
    return verb === undefined ? 2 : 0;
  }
  if (verb !== "set") {
    io.err(`oe env: unknown verb "${verb}". Known: set.`);
    io.err(USAGE);
    return 2;
  }
  const rest = args.slice(1);
  const fileFlag = flagValue(rest, "--file");
  const names = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] === "--file" && a === fileFlag));
  if (names.length !== 1) {
    io.err(names.length === 0 ? "✗ oe env set: a name is required." : `✗ oe env set: one name only (got ${names.length}). The value is never an argument.`);
    io.err(USAGE);
    return 2;
  }
  const name = names[0]!;
  if (!ENV_NAME_PATTERN.test(name)) {
    io.err(`✗ oe env set: "${name}" is not an environment variable name (A-Z, 0-9 and _, starting with a letter).`);
    return 2;
  }
  const root = resolve(cwd);
  const file = resolve(root, fileFlag ?? ".env.local");
  const refusal = envFileTargetRefusal(file, root);
  if (refusal) {
    io.err(`✗ oe env set: ${refusal}`);
    return 1;
  }
  const value = stripOneTrailingNewline(await io.readValue(name));
  if (value.length === 0) {
    io.err(`✗ oe env set ${name}: the value was empty. Nothing was written.`);
    return 1;
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
    io.err(`✗ oe env set ${name}: the value holds a control character (an arrow key or Esc at the prompt?). Nothing was written. Run it again.`);
    return 1;
  }
  const rhs = envAssignmentValue(value);
  if (rhs === undefined) {
    io.err(
      `✗ oe env set ${name}: the value holds a line break or every quote style, so no .env line reads it back unchanged. Nothing was written. ` +
        "A multi-line value (a PEM key) belongs in the credential store: `oe secret set <name> --value-file PATH`.",
    );
    return 1;
  }
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const replaced = new RegExp(`^\\s*${name}=`, "m").test(existing);
  const next = mergeEnv(existing, { [name]: rhs });
  writeFileSync(file, next.endsWith("\n") ? next : next + "\n", { encoding: "utf-8", mode: 0o600 });
  io.out(`✓ ${replaced ? "replaced" : "wrote"} ${name} in ${file} (${Buffer.byteLength(value, "utf8")} bytes). The value was not printed.`);
  return 0;
}

export async function readValueFromTerminalOrStdin(name: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  process.stderr.write(`${name} (input hidden, Enter to finish): `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string>((done, fail) => {
    let value = "";
    const finish = (result: string | Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (typeof result === "string") done(result);
      else fail(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(value);
        if (ch === "\u0003") return finish(new Error("cancelled — nothing was written"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
