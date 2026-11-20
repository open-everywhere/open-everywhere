// Adapted from eve 1.0.0-rc.18 (Copyright 2026 Vercel, Inc. and contributors, Apache-2.0),
// `src/shared/html-to-markdown`. The Open Everywhere authors changed it: types added, and the
// module became an OE-owned helper because eve 1.0 no longer exports the Teams activity parser
// that called it. Keep the output identical to eve's: the Teams front and eve's own Teams channel
// must derive the same message text from one activity.

interface HtmlElement {
  readonly name: string;
  readonly attrs: string;
  readonly children: HtmlNode[];
  hasBlock: boolean;
}

type HtmlNode = string | HtmlElement;

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIPPED_ELEMENTS = new Set(["canvas", "iframe", "math", "noscript", "object", "script", "select", "style", "svg", "template", "textarea"]);
const BLOCK_ELEMENTS = new Set(
  "address.article.aside.blockquote.body.caption.center.dd.details.dialog.dir.div.dl.dt.fieldset.figcaption.figure.footer.form.h1.h2.h3.h4.h5.h6.head.header.hgroup.hr.html.li.main.menu.nav.ol.p.pre.section.summary.table.tbody.td.tfoot.th.thead.title.tr.ul".split("."),
);
const LIST_ELEMENTS = new Set(["dir", "menu", "ol", "ul"]);
const MAX_DEPTH = 128;
const MAX_QUOTE_OR_LIST_DEPTH = 8;

export function convertHtmlToMarkdown(html: string): string {
  return renderBlocks(parseHtml(html).children, 0, []).join("\n\n");
}

function element(name: string, attrs: string): HtmlElement {
  return { name, attrs, children: [], hasBlock: false };
}

function parseHtml(html: string): HtmlElement {
  const root = element("#root", "");
  const stack: HtmlElement[] = [root];
  let pos = 0;
  const current = (): HtmlElement => stack[stack.length - 1]!;
  const pushText = (end: number): void => {
    if (end > pos) current().children.push(html.slice(pos, end));
  };
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    const isTag = isAsciiLetter(next) || next === 47;
    const isDeclaration = next === 33 || next === 63;
    if (!isTag && !isDeclaration) {
      pushText(lt + 1);
      pos = lt + 1;
      continue;
    }
    pushText(lt);
    if (isDeclaration) {
      const close = html.startsWith("<!--", lt) ? "-->" : ">";
      const end = html.indexOf(close, lt + 2);
      pos = end === -1 ? html.length : end + close.length;
      continue;
    }
    const tagEnd = findTagEnd(html, lt + 1);
    if (tagEnd === -1) {
      pos = lt;
      break;
    }
    pos = tagEnd + 1;
    const inner = html.slice(lt + 1, tagEnd);
    const closing = inner.charCodeAt(0) === 47;
    const match = /^[a-zA-Z][^\s/>]*/.exec(closing ? inner.slice(1) : inner);
    if (!match) continue;
    const name = match[0].toLowerCase();
    if (closing) {
      if (name === "br") current().children.push(element(name, ""));
      else closeElement(stack, name);
      continue;
    }
    const selfClosing = inner.charCodeAt(inner.length - 1) === 47;
    if (SKIPPED_ELEMENTS.has(name)) {
      if (!((name === "svg" || name === "math") && selfClosing)) pos = skipRawText(html, name, pos);
      continue;
    }
    closeImplicitly(stack, name);
    const node = element(name, inner.slice(match[0].length));
    current().children.push(node);
    if (BLOCK_ELEMENTS.has(name)) markBlockAncestors(stack);
    if (!VOID_ELEMENTS.has(name) && !selfClosing && stack.length < MAX_DEPTH) stack.push(node);
  }
  if (pos < html.length) current().children.push(html.slice(pos));
  return root;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function findTagEnd(html: string, from: number): number {
  let quote = 0;
  let previous = 0;
  for (let i = from; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if ((code === 34 || code === 39) && previous === 61) quote = code;
    else if (code === 62) return i;
    if (code > 32) previous = code;
  }
  return -1;
}

function skipRawText(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}(?=[\\s/>])`, "gi");
  close.lastIndex = from;
  if (!close.exec(html)) return html.length;
  const end = html.indexOf(">", close.lastIndex);
  return end === -1 ? html.length : end + 1;
}

function markBlockAncestors(stack: HtmlElement[]): void {
  for (let i = stack.length - 1; i > 0 && !stack[i]!.hasBlock; i--) stack[i]!.hasBlock = true;
}

function closeElement(stack: HtmlElement[], name: string): void {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i]!.name === name) {
      stack.length = i;
      return;
    }
  }
}

function closeImplicitly(stack: HtmlElement[], name: string): void {
  if (name === "li") closeWithin(stack, ["li"], LIST_ELEMENTS);
  else if (name === "dt" || name === "dd") closeWithin(stack, ["dt", "dd"], new Set(["dl"]));
  else if (name === "tr") closeWithin(stack, ["tr"], new Set(["table", "thead", "tbody", "tfoot"]));
  else if (name === "td" || name === "th") closeWithin(stack, ["td", "th"], new Set(["tr", "table"]));
  else if (name === "thead" || name === "tbody" || name === "tfoot") closeWithin(stack, ["thead", "tbody", "tfoot"], new Set(["table"]));
  else if (BLOCK_ELEMENTS.has(name) && stack[stack.length - 1]!.name === "p") stack.pop();
}

function closeWithin(stack: HtmlElement[], names: readonly string[], boundary: ReadonlySet<string>): void {
  for (let i = stack.length - 1; i > 0; i--) {
    const name = stack[i]!.name;
    if (boundary.has(name)) return;
    if (names.includes(name)) {
      stack.length = i;
      return;
    }
  }
}

function readAttribute(attrs: string, name: string): string | undefined {
  for (const m of attrs.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (m[1]!.toLowerCase() === name) return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return undefined;
}

function renderBlocks(nodes: readonly HtmlNode[], depth: number, out: string[]): string[] {
  let inline: HtmlNode[] = [];
  const flush = (): void => {
    const text = normalizeInline(renderInline(inline));
    if (text) out.push(text);
    inline = [];
  };
  for (const node of nodes) {
    if (typeof node === "string" || !rendersAsBlock(node)) inline.push(node);
    else {
      flush();
      renderBlockElement(node, depth, out);
    }
  }
  flush();
  return out;
}

function rendersAsBlock(node: HtmlElement): boolean {
  return BLOCK_ELEMENTS.has(node.name) || (node.hasBlock && node.name !== "a");
}

function renderBlockElement(node: HtmlElement, depth: number, out: string[]): void {
  switch (node.name) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = normalizeInline(renderInline(node.children)).replace(/\n+/g, " ");
      if (text) out.push(`${"#".repeat(Number(node.name[1]))} ${text}`);
      return;
    }
    case "hr":
      out.push("---");
      return;
    case "pre":
      out.push(renderCodeBlock(node));
      return;
    case "blockquote": {
      if (depth >= MAX_QUOTE_OR_LIST_DEPTH) {
        renderBlocks(node.children, depth, out);
        return;
      }
      const inner = renderBlocks(node.children, depth + 1, []).join("\n\n");
      if (inner) out.push(prefixLines(inner, "> ", ">"));
      return;
    }
    case "ol":
    case "ul":
    case "dir":
    case "menu":
      renderList(node, depth, out);
      return;
    case "table":
      renderTable(node, depth, out);
      return;
    default:
      renderBlocks(node.children, depth, out);
  }
}

function renderList(node: HtmlElement, depth: number, out: string[]): void {
  const start = node.name === "ol" ? readAttribute(node.attrs, "start") : undefined;
  let index = start !== undefined && /^\d{1,9}$/.test(start) ? Number(start) : 1;
  const items: string[] = [];
  for (const child of node.children) {
    const content = typeof child !== "string" && child.name === "li" ? child.children : [child];
    const marker = node.name === "ol" ? `${index}. ` : "- ";
    if (depth >= MAX_QUOTE_OR_LIST_DEPTH) {
      const before = out.length;
      renderBlocks(content, depth, out);
      if (out.length > before) {
        out[before] = marker + out[before]!;
        index++;
      }
      continue;
    }
    const text = renderBlocks(content, depth + 1, []).join("\n");
    if (text) {
      index++;
      items.push(marker + prefixLines(text, " ".repeat(marker.length), "", true));
    }
  }
  if (items.length > 0) out.push(items.join("\n"));
}

function renderCodeBlock(node: HtmlElement): string {
  const code = node.children.find((c): c is HtmlElement => typeof c !== "string" && c.name === "code");
  const cls = readAttribute(code?.attrs ?? "", "class") ?? readAttribute(node.attrs, "class");
  const language = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls ?? "")?.[1] ?? "";
  const text = decodeEntities(textContent(node.children)).replace(/^\r?\n/, "").trimEnd();
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function renderTable(node: HtmlElement, depth: number, out: string[]): void {
  const rows: HtmlElement[][] = [];
  const captions: HtmlElement[] = [];
  const visit = (nodes: readonly HtmlNode[]): void => {
    for (const child of nodes) {
      if (typeof child === "string") continue;
      if (child.name === "tr") rows.push(child.children.filter((c): c is HtmlElement => typeof c !== "string" && (c.name === "td" || c.name === "th")));
      else if (child.name === "caption") captions.push(child);
      else if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") visit(child.children);
    }
  };
  visit(node.children);
  if (rows.some((row) => row.some((cell) => cell.hasBlock))) {
    renderBlocks(node.children, depth, out);
    return;
  }
  const parts: string[] = [];
  for (const caption of captions) renderBlocks(caption.children, depth, parts);
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width > 0) {
    const line = (cells: readonly string[]): string => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const [head, ...body] = rows.map((row) =>
      row.map((cell) => normalizeInline(renderInline(cell.children)).replace(/\n+/g, " ").replace(/\|/g, "\\|")),
    );
    parts.push([line(head!), line(Array.from({ length: width }, () => "---")), ...body.map(line)].join("\n"));
  }
  if (parts.length > 0) out.push(parts.join("\n\n"));
}

function renderInline(nodes: readonly HtmlNode[]): string {
  const out: string[] = [];
  for (const node of nodes) out.push(typeof node === "string" ? renderText(node) : renderInlineElement(node));
  return out.join("");
}

function renderInlineElement(node: HtmlElement): string {
  switch (node.name) {
    case "br":
      return "\n";
    case "strong":
    case "b":
      return wrap(renderInline(node.children), "**");
    case "em":
    case "i":
      return wrap(renderInline(node.children), "*");
    case "del":
    case "s":
    case "strike":
      return wrap(renderInline(node.children), "~~");
    case "code":
    case "kbd":
    case "samp":
      return renderInlineCode(node);
    case "a": {
      const text = renderInline(node.children);
      const href = readAttribute(node.attrs, "href");
      if (!href || !text.trim()) return text;
      const title = readAttribute(node.attrs, "title");
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
      return wrap(text, "[", `](${escapeUrl(href)}${titlePart})`);
    }
    case "img": {
      const src = readAttribute(node.attrs, "src");
      return src ? `![${(readAttribute(node.attrs, "alt") ?? "").replace(/\s+/g, " ")}](${escapeUrl(src)})` : "";
    }
    case "input":
      return "";
    default: {
      const text = renderInline(node.children);
      return BLOCK_ELEMENTS.has(node.name) ? ` ${text} ` : text;
    }
  }
}

function renderInlineCode(node: HtmlElement): string {
  const text = decodeEntities(textContent(node.children)).replace(/\s+/g, " ");
  if (!text.trim()) return text;
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function wrap(text: string, open: string, close: string = open): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const lead = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return `${text.slice(0, lead)}${open}${trimmed}${close}${text.slice(end)}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return longest;
}

function renderText(text: string): string {
  return decodeEntities(text.replace(/[ \t\n\r\f]+/g, " "));
}

function textContent(nodes: readonly HtmlNode[]): string {
  const out: string[] = [];
  const visit = (list: readonly HtmlNode[]): void => {
    for (const node of list) {
      if (typeof node === "string") out.push(node);
      else if (node.name === "br") out.push("\n");
      else visit(node.children);
    }
  };
  visit(nodes);
  return out.join("");
}

function normalizeInline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .trim();
}

function prefixLines(text: string, prefix: string, emptyPrefix: string, skipFirst = false): string {
  return text
    .split("\n")
    .map((line, i) => (skipFirst && i === 0 ? line : line ? prefix + line : emptyPrefix))
    .join("\n");
}

function escapeUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (c) => encodeURIComponent(c));
}

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["apos", "'"],
  ["bull", "•"],
  ["cent", "¢"],
  ["copy", "©"],
  ["deg", "°"],
  ["euro", "€"],
  ["gt", ">"],
  ["hellip", "…"],
  ["laquo", "«"],
  ["ldquo", "“"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["middot", "·"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["para", "¶"],
  ["pound", "£"],
  ["quot", '"'],
  ["raquo", "»"],
  ["rdquo", "”"],
  ["reg", "®"],
  ["rsquo", "’"],
  ["sect", "§"],
  ["times", "×"],
  ["trade", "™"],
  ["yen", "¥"],
]);

const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_PATTERN, (whole: string, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED_ENTITIES.get(named.toLowerCase()) ?? whole;
    const code = dec === undefined ? Number.parseInt(hex!, 16) : Number.parseInt(dec, 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}
