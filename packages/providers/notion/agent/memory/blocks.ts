interface RichText {
  readonly plain_text?: string;
  readonly href?: string | null;
  readonly type?: string;
  readonly text?: { readonly content?: string };
  readonly mention?: { readonly type?: string; readonly page?: { readonly id?: string } };
  readonly annotations?: { readonly bold?: boolean; readonly italic?: boolean; readonly code?: boolean };
}

export interface LinkTarget {
  readonly path: string;
  readonly title: string;
}

export type LinkResolver = (pageId: string) => LinkTarget | undefined;

export interface BlockNode {
  readonly id?: string;
  readonly type: string;
  readonly has_children?: boolean;
  readonly children?: readonly BlockNode[];
  readonly [key: string]: unknown;
}

export const PAGE_BLOCK_TYPES = new Set(["child_page", "child_database"]);

const PLACEHOLDER_BLOCK_TYPES = new Set([
  "image", "video", "audio", "file", "pdf", "embed", "bookmark", "link_preview", "table", "unsupported",
]);

function placeholderHint(block: BlockNode): string {
  const pl = block[block.type] as { caption?: RichText[]; url?: string } | undefined;
  if (!pl) return "";
  const cap = pl.caption && pl.caption.length > 0 ? renderRich(pl.caption) : "";
  if (cap) return ` "${cap}"`;
  if (typeof pl.url === "string" && pl.url.length > 0) return ` (${pl.url})`;
  return "";
}

function placeholderLine(block: BlockNode, indent: string): string {
  const id = typeof block.id === "string" && block.id.length > 0 ? ` id=${block.id}` : "";
  return `${indent}> ⛏ [notion:${block.type}${id}]${placeholderHint(block)} — rich block not rendered; fetch by id via the Notion tools.`;
}

function renderRich(rich: readonly RichText[] | undefined, resolve?: LinkResolver): string {
  if (!rich) return "";
  return rich
    .map((rt) => {
      if (resolve && rt.type === "mention" && rt.mention?.page?.id) {
        const target = resolve(rt.mention.page.id);
        if (target) return `[${rt.plain_text || target.title}](${target.path})`;
      }
      let t = rt.plain_text ?? rt.text?.content ?? "";
      const a = rt.annotations ?? {};
      if (a.code) t = `\`${t}\``;
      if (a.bold) t = `**${t}**`;
      if (a.italic) t = `*${t}*`;
      return t;
    })
    .join("");
}

function payload(block: BlockNode): { rich_text?: RichText[]; language?: string; checked?: boolean } {
  return (block[block.type] as { rich_text?: RichText[]; language?: string; checked?: boolean }) ?? {};
}

function renderBlock(block: BlockNode, depth: number, resolve?: LinkResolver): string[] {
  const indent = "  ".repeat(depth);
  if (PLACEHOLDER_BLOCK_TYPES.has(block.type)) return [placeholderLine(block, indent)];

  const p = payload(block);
  const rich = renderRich(p.rich_text, resolve);
  const lines: string[] = [];

  switch (block.type) {
    case "link_to_page": {
      const pid = (block.link_to_page as { page_id?: string } | undefined)?.page_id;
      const target = pid && resolve ? resolve(pid) : undefined;
      if (target) lines.push(`${indent}[${target.title}](${target.path})`);
      else if (pid) lines.push(`${indent}(link to a page outside this memory)`);
      break;
    }
    case "heading_1":
      lines.push(`# ${rich}`);
      break;
    case "heading_2":
      lines.push(`## ${rich}`);
      break;
    case "heading_3":
      lines.push(`### ${rich}`);
      break;
    case "bulleted_list_item":
      lines.push(`${indent}- ${rich}`);
      break;
    case "numbered_list_item":
      lines.push(`${indent}1. ${rich}`);
      break;
    case "to_do":
      lines.push(`${indent}- [${p.checked ? "x" : " "}] ${rich}`);
      break;
    case "toggle":
      lines.push(`${indent}- ${rich}`);
      break;
    case "quote":
    case "callout":
      lines.push(`> ${rich}`);
      break;
    case "code":
      lines.push("```" + (p.language ?? ""), rich, "```");
      break;
    case "equation": {
      const expr = (block.equation as { expression?: string } | undefined)?.expression ?? rich;
      lines.push(`${indent}$$ ${expr} $$`);
      break;
    }
    case "divider":
      lines.push("---");
      break;
    default:
      if (rich) lines.push(`${indent}${rich}`);
      break;
  }

  if (block.children) {
    const nestDepth = block.type === "bulleted_list_item" || block.type === "numbered_list_item" || block.type === "to_do" || block.type === "toggle" ? depth + 1 : depth;
    for (const child of block.children) {
      if (PAGE_BLOCK_TYPES.has(child.type)) continue;
      lines.push(...renderBlock(child, nestDepth, resolve));
    }
  }
  return lines;
}

export function renderBlocks(blocks: readonly BlockNode[], resolve?: LinkResolver): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (PAGE_BLOCK_TYPES.has(b.type)) continue;
    out.push(...renderBlock(b, 0, resolve));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function contentLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

const MAX_RICH_TEXT = 2000;

function plainRich(content: string): RichText[] {
  if (content.length === 0) return [];
  const out: RichText[] = [];
  for (let i = 0; i < content.length; i += MAX_RICH_TEXT) {
    out.push({ type: "text", text: { content: content.slice(i, i + MAX_RICH_TEXT) } });
  }
  return out;
}

function mkBlock(type: string, payload: Record<string, unknown>): BlockNode {
  return { object: "block", type, [type]: payload };
}

function blockForLine(line: string): BlockNode {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^### (.*)$/))) return mkBlock("heading_3", { rich_text: plainRich(m[1]) });
  if ((m = line.match(/^## (.*)$/))) return mkBlock("heading_2", { rich_text: plainRich(m[1]) });
  if ((m = line.match(/^# (.*)$/))) return mkBlock("heading_1", { rich_text: plainRich(m[1]) });
  if ((m = line.match(/^- \[([ x])\] (.*)$/))) {
    return mkBlock("to_do", { rich_text: plainRich(m[2]), checked: m[1] === "x" });
  }
  if ((m = line.match(/^- (.*)$/))) return mkBlock("bulleted_list_item", { rich_text: plainRich(m[1]) });
  if ((m = line.match(/^1\. (.*)$/))) return mkBlock("numbered_list_item", { rich_text: plainRich(m[1]) });
  if ((m = line.match(/^> (.*)$/))) return mkBlock("quote", { rich_text: plainRich(m[1]) });
  if (line === "---") return mkBlock("divider", {});
  return mkBlock("paragraph", { rich_text: plainRich(line) });
}

export function blocksFromMarkdown(lines: readonly string[]): BlockNode[] {
  const blocks = lines.map(blockForLine);
  const anchor = mkBlock("paragraph", { rich_text: plainRich("anchor") });
  const back = contentLines(renderBlocks([anchor, ...blocks])).slice(1);
  const at = back.findIndex((line, i) => line !== lines[i]);
  if (back.length !== lines.length || at !== -1) {
    const i = at === -1 ? Math.min(back.length, lines.length) : at;
    throw new Error(
      `notion memory: line ${i + 1} cannot be stored as a Notion block without changing it ` +
        `(would read back as ${JSON.stringify(back[i] ?? "(nothing)")}, not ${JSON.stringify(lines[i] ?? "(nothing)")}). ` +
        `The write is refused rather than saved in a form the next read would report differently.`,
    );
  }
  return blocks;
}

export function pageTitle(block: BlockNode): string {
  const cp = (block.child_page ?? block.child_database) as { title?: string } | undefined;
  return cp?.title?.trim() || "untitled";
}
