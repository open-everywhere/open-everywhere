const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const EVE_TELEMETRY_SWITCH = "EVE_TELEMETRY_DISABLED=1";

function isEveWord(word: string): boolean {
  return /^eve(@\S+)?$/.test(word) || /(^|\/)\.bin\/eve$/.test(word) || /(^|\/)eve\/bin\/eve\.js$/.test(word);
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["-e", "-c", "-p", "--package", "-r", "--require", "--import", "-u", "--unset"]);

export function eveCommands(script: string): { readonly prefix: readonly string[]; readonly command: string }[] {
  const found: { prefix: string[]; command: string }[] = [];
  for (const part of script.split(/&&|\|\||;/)) {
    const words = part.trim().replace(/^\(+\s*/u, "").split(/\s+/).filter(Boolean);
    const prefix: string[] = [];
    const all = [...words];
    for (;;) {
      const word = words[0];
      if (word === undefined) break;
      if (ASSIGNMENT.test(word)) prefix.push(words.shift()!);
      else if (word === "env" || word === "cross-env" || word === "dotenv" || word === "npx" || word === "node") {
        words.shift();
      } else if (word === "npm" && words[1] === "exec") {
        words.splice(0, 2);
      } else if (word === "-v" && words[1] !== undefined && ASSIGNMENT.test(words[1])) {
        words.shift();
        prefix.push(words.shift()!);
      } else if (VALUE_FLAGS.has(word)) words.splice(0, 2);
      else if (word.startsWith("-")) words.shift();
      else break;
    }
    const clean = (w: string | undefined) => w?.replace(/^['"(]+|['")]+$/gu, "");
    const command = clean(words[0]);
    if (command !== undefined && isEveWord(command)) found.push({ prefix, command: part.trim() });
    else if (all.some((w) => isEveWord(clean(w)!))) found.push({ prefix, command: part.trim() });
  }
  return found;
}
