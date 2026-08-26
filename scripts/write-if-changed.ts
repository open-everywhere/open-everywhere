import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileIfChanged(abs: string, content: string): boolean {
  if (existsSync(abs) && readFileSync(abs, "utf8") === content) return false;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return true;
}
