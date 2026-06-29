export interface RichText {
  readonly plain_text?: string;
  readonly text?: { readonly content?: string };
  readonly annotations?: { readonly bold?: boolean; readonly italic?: boolean; readonly code?: boolean };
}

export interface BlockNode {
  readonly id?: string;
  readonly type: string;
  readonly has_children?: boolean;
  readonly children?: readonly BlockNode[];
  readonly [key: string]: unknown;
}

export const PAGE_BLOCK_TYPES = new Set(["child_page", "child_database"]);

function renderRich(rich: readonly RichText[] | undefined): string {
  if (!rich) return "";
  return rich
    .map((rt) => {
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

function renderBlock(block: BlockNode, depth: number): string[] {
  const p = payload(block);
  const rich = renderRich(p.rich_text);
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  switch (block.type) {
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
      lines.push(...renderBlock(child, nestDepth));
    }
  }
  return lines;
}

export function renderBlocks(blocks: readonly BlockNode[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (PAGE_BLOCK_TYPES.has(b.type)) continue;
    out.push(...renderBlock(b, 0));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function pageTitle(block: BlockNode): string {
  const cp = (block.child_page ?? block.child_database) as { title?: string } | undefined;
  return cp?.title?.trim() || "untitled";
}
