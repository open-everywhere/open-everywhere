import { fstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const arg = process.argv[2];
if (arg === undefined || process.argv.length > 3) {
  console.error("usage: npm run -s env:pipe -- <NAME | NAME=value> | npx vercel env add <NAME> production");
  process.exit(2);
}
const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;
let isPipe = false;
try {
  const st = fstatSync(1);
  isPipe = st.isFIFO() || st.isSocket() || (process.platform === "win32" && (st.mode & S_IFMT) === S_IFIFO);
} catch {
  isPipe = false;
}
if (!isPipe) {
  console.error("env:pipe writes a secret value, so it writes only to a pipe. Pipe it straight into `npx vercel env add <NAME> production`.");
  process.exit(2);
}

const eq = arg.indexOf("=");
const name = eq >= 0 ? arg.slice(0, eq) : arg;
if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error(`env:pipe: "${name}" is not an environment variable name`);
  process.exit(2);
}

let value;
if (eq >= 0) {
  value = arg.slice(eq + 1);
} else {
  let text;
  try {
    text = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  } catch {
    console.error("env:pipe: no .env.local in this directory");
    process.exit(1);
  }
  value = parseEnv(text)[name];
}
if (value === undefined || value === "") {
  console.error(`env:pipe: ${name} has no value${eq >= 0 ? "" : " in .env.local"}`);
  process.exit(1);
}
process.stdout.write(value);
