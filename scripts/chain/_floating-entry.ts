const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "new", "throw"]);

function skeleton(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const templateStack: number[] = [];
  let i = 0;
  let lastSignificant = "";
  let lastWord = "";
  const scanTemplateText = (): void => {
    const start = i;
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "`") {
        blank(start, i);
        i++;
        lastSignificant = "`";
        return;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        blank(start, i);
        i += 2;
        templateStack.push(0);
        lastSignificant = "{";
        return;
      } else i++;
    }
    blank(start, i);
  };
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = c;
      lastWord = "";
    } else if (c === "`") {
      i++;
      scanTemplateText();
      lastWord = "";
    } else if (c === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) || REGEX_AFTER_WORD.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") j += 2;
        else if (source[j] === "[") (inClass = true), j++;
        else if (source[j] === "]") (inClass = false), j++;
        else if (source[j] === "/" && !inClass) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = "/";
      lastWord = "";
    } else {
      if (templateStack.length > 0) {
        if (c === "{") templateStack[templateStack.length - 1]!++;
        else if (c === "}") {
          if (templateStack[templateStack.length - 1] === 0) {
            templateStack.pop();
            i++;
            scanTemplateText();
            continue;
          }
          templateStack[templateStack.length - 1]!--;
        }
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < source.length && /[A-Za-z0-9_$]/.test(source[j]!)) j++;
        lastWord = source.slice(i, j);
        lastSignificant = "w";
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        lastSignificant = c;
        lastWord = "";
      }
      i++;
    }
  }
  return out.join("");
}

function withoutIfHead(line: string): string {
  const head = /^\s*(?:else\s+)?if\s*\(/.exec(line);
  if (!head) return line;
  let depth = 1;
  for (let k = head[0].length; k < line.length; k++) {
    if (line[k] === "(") depth++;
    else if (line[k] === ")" && --depth === 0) return line.slice(k + 1);
  }
  return line;
}

const CONTROL_BLOCK = /^(?:\}\s*)?(?:(?:else\s+)?if\s*\([\s\S]*\)|else|try|catch(?:\s*\([\s\S]*\))?|finally)?$/;

export function floatingAsyncEntrypoints(source: string): string[] {
  const code = skeleton(source);
  const lines = code.split("\n");
  const sourceLines = source.split("\n");

  const depthAt: number[] = [];
  const inControl: boolean[] = [];
  const startsStatement: boolean[] = [];
  let lastCode = "";
  const openers: boolean[] = [];
  let stmtStart = 0;
  let offset = 0;
  for (const line of lines) {
    depthAt.push(openers.length);
    inControl.push(openers.length === 1 && openers[0] === true);
    startsStatement.push(lastCode === "" || ";{}".includes(lastCode));
    for (let k = 0; k < line.length; k++) {
      const c = line[k]!;
      if (!/\s/.test(c)) lastCode = c;
      if (c === "{") {
        const before = code.slice(stmtStart, offset + k).trim();
        openers.push(openers.length === 0 && CONTROL_BLOCK.test(before));
        if (openers.length === 1) stmtStart = offset + k + 1;
      } else if (c === "}") {
        openers.pop();
        if (openers.length === 0) stmtStart = offset + k + 1;
      } else if (c === ";" && openers.length === 0) {
        stmtStart = offset + k + 1;
      }
    }
    offset += line.length + 1;
  }

  const asyncNames = new Set<string>();
  lines.forEach((line, n) => {
    if (depthAt[n] !== 0) return;
    const decl = /^\s*(?:export\s+(?:default\s+)?)?async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
    const bound = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::(?:[^=]|=>)+)?=\s*async\b/.exec(line);
    const name = decl?.[1] ?? bound?.[1];
    if (name) asyncNames.add(name);
  });

  const hits: string[] = [];
  lines.forEach((line, n) => {
    if (!startsStatement[n] || (depthAt[n] !== 0 && !inControl[n])) return;
    const statement = withoutIfHead(line);
    const call = /^\s*(?:void\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(statement);
    const asyncIife = /^\s*(?:void\s+)?\(\s*async\b/.test(statement);
    if ((call && asyncNames.has(call[1]!)) || asyncIife) hits.push(`${n + 1}: ${sourceLines[n]!.trim()}`);
  });
  return hits;
}
