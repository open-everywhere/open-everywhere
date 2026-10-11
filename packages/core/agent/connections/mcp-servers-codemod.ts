import type { McpServerDeclaration } from "./mcp-servers.js";

const OPEN_CALL = "defineMcpServers([";
const CLOSE_LINE = /^\]\);[ \t]*$/gmu;

export function renderMcpServerEntry(declaration: McpServerDeclaration): string {
  return (
    JSON.stringify(declaration, null, 2)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n") + ",\n"
  );
}

export interface McpServerInsertResult {
  readonly text: string;
  readonly changed: boolean;
}

export function insertMcpServerEntry(fileText: string, declaration: McpServerDeclaration): McpServerInsertResult {
  const entry = renderMcpServerEntry(declaration);
  if (fileText.includes(entry)) return { text: fileText, changed: false };
  const open = fileText.indexOf(OPEN_CALL);
  if (open === -1 || fileText.indexOf(OPEN_CALL, open + 1) !== -1) {
    throw new Error(
      `agent/access/mcp-servers.ts does not hold exactly one \`${OPEN_CALL}\` call, so the entry has no certain place. Add it by hand in a pull request.`,
    );
  }
  const closes = [...fileText.slice(open).matchAll(CLOSE_LINE)];
  if (closes.length !== 1) {
    throw new Error(
      `agent/access/mcp-servers.ts has ${closes.length === 0 ? "no" : "more than one"} \`]);\` line after \`${OPEN_CALL}\`, so the entry has no certain place. Add it by hand in a pull request.`,
    );
  }
  const at = open + closes[0]!.index!;
  const last = lastCodeChar(fileText, open + OPEN_CALL.length - 1, at);
  if (last.unclosed) {
    throw new Error(
      "agent/access/mcp-servers.ts's only `]);` line sits inside a comment or a string, so the entry has no certain place. Add it by hand in a pull request.",
    );
  }
  if (last.char === "[" || last.char === ",") return { text: fileText.slice(0, at) + entry + fileText.slice(at), changed: true };
  if (last.char === "}" || last.char === ")") {
    const text = fileText.slice(0, last.index + 1) + "," + fileText.slice(last.index + 1, at) + entry + fileText.slice(at);
    return { text, changed: true };
  }
  throw new Error(
    `agent/access/mcp-servers.ts's list ends in ${JSON.stringify(last.char)} before \`]);\`, so the entry has no certain place. Add it by hand in a pull request.`,
  );
}

function lastCodeChar(text: string, from: number, to: number): { readonly char: string; readonly index: number; readonly unclosed: boolean } {
  let last = { char: "", index: -1 };
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      while (i < to && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1 || end + 2 > to) return { ...last, unclosed: true };
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < to && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (j >= to) return { ...last, unclosed: true };
      last = { char: c, index: j };
      i = j;
      continue;
    }
    if (!/\s/u.test(c)) last = { char: c, index: i };
  }
  return { ...last, unclosed: false };
}
