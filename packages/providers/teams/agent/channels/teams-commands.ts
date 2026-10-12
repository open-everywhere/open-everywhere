import { parseOeCommandTokens, oeCommandName, type OeCommand } from "@open-everywhere/core/agent/adapter-api.js";

function tokensOf(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function parseTeamsOeCommand(text: string, addressed: boolean, commandName: string = oeCommandName()): OeCommand | null {
  const name = commandName.trim().toLowerCase();
  if (name.length === 0) return null;
  const [head, ...rest] = tokensOf(text);
  if (head === undefined) return null;
  const lead = head.toLowerCase();
  if (lead === `/${name}`) return parseOeCommandTokens(rest);
  if (!addressed || lead !== name || rest.length === 0) return null;
  const command = parseOeCommandTokens(rest);
  return command.kind === "error" ? null : command;
}
