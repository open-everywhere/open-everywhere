#!/usr/bin/env node
import { formatSkillEnvelope } from "../agent/access/skill-envelope.js";

export function runWrapUntrusted(argv: readonly string[], stdin: string): string {
  let source: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") {
      source = argv[i + 1];
      i++;
    } else if (a.startsWith("--source=")) {
      source = a.slice("--source=".length);
    }
  }
  return formatSkillEnvelope(stdin, { source });
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("oe-wrap-untrusted.ts") || entry.endsWith("oe-wrap-untrusted.js");
}

if (isMain()) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => {
    const stdin = Buffer.concat(chunks).toString("utf8");
    const args = process.argv.slice(2).filter((a) => a !== "wrap-untrusted");
    process.stdout.write(runWrapUntrusted(args, stdin));
  });
}
