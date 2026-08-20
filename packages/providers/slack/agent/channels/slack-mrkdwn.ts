const CODE_PLACEHOLDER = "￼";

export function markdownToSlackMrkdwn(text: string): string {
  if (!text) return text;

  const blocks: string[] = [];
  const stash = (s: string): string => {
    const token = `${CODE_PLACEHOLDER}${blocks.length}${CODE_PLACEHOLDER}`;
    blocks.push(s);
    return token;
  };
  let out = text.replace(/```[\s\S]*?```/g, (m) => stash(m));
  out = out.replace(/`[^`\n]+`/g, (m) => stash(m));

  out = out.replace(/^ {0,3}#{1,6}[ \t]+(.+)$/gm, (_m, body: string) => `*${body.trim()}*`);

  out = out.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_m, label: string, url: string) => `<${url}|${label}>`);

  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => `*${body}*`);
  out = out.replace(/__([^_\n]+)__/g, (_m, body: string) => `*${body}*`);

  out = out.replace(/~~([^~\n]+)~~/g, (_m, body: string) => `~${body}~`);

  out = out.replace(/^(\s*)[-*][ \t]+/gm, (_m, indent: string) => `${indent}• `);

  out = out.replace(new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, "g"), (_m, i: string) => blocks[Number(i)] ?? "");

  return out;
}
