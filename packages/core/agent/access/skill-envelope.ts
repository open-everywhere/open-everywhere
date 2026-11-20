import { randomBytes } from "node:crypto";
import type { ToolModelOutput } from "eve/tools";
import { bash, type BashToolOutput } from "eve/tools/bash";
import { ingestUntrusted } from "./untrusted.js";

export const SKILL_ENVELOPE_OPEN_PREFIX = "<<<OE-UNTRUSTED ";
export const SKILL_ENVELOPE_CLOSE_PREFIX = "<<<END-OE-UNTRUSTED ";
export const SKILL_ENVELOPE_MARKER_END = ">>>";

const OPEN_MARKER_RE = /^<<<OE-UNTRUSTED ([0-9a-f]{16,}) source=([^>]*)>>>$/;

export function mintSkillEnvelopeNonce(): string {
  return randomBytes(16).toString("hex");
}

export function sanitizeSkillEnvelopeSource(label: string | undefined): string {
  const cleaned = (label ?? "").trim().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "external";
}

export function formatSkillEnvelope(content: string, opts: { source?: string; nonce?: string } = {}): string {
  const nonce = opts.nonce ?? mintSkillEnvelopeNonce();
  const label = sanitizeSkillEnvelopeSource(opts.source);
  return (
    `${SKILL_ENVELOPE_OPEN_PREFIX}${nonce} source=${label}${SKILL_ENVELOPE_MARKER_END}\n` +
    `${content}\n` +
    `${SKILL_ENVELOPE_CLOSE_PREFIX}${nonce}${SKILL_ENVELOPE_MARKER_END}`
  );
}

export type SkillEnvelopeSegment =
  | { readonly untrusted: false; readonly text: string }
  | { readonly untrusted: true; readonly source: string; readonly content: string };

export function extractSkillEnvelopes(stdout: string): SkillEnvelopeSegment[] {
  const segments: SkillEnvelopeSegment[] = [];
  const pushText = (text: string) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.untrusted === false) {
      segments[segments.length - 1] = { untrusted: false, text: last.text + text };
    } else {
      segments.push({ untrusted: false, text });
    }
  };

  let pos = 0;
  while (pos < stdout.length) {
    const openIdx = stdout.indexOf(SKILL_ENVELOPE_OPEN_PREFIX, pos);
    if (openIdx === -1) {
      pushText(stdout.slice(pos));
      break;
    }
    const termIdx = stdout.indexOf(SKILL_ENVELOPE_MARKER_END, openIdx);
    const marker = termIdx === -1 ? null : OPEN_MARKER_RE.exec(stdout.slice(openIdx, termIdx + SKILL_ENVELOPE_MARKER_END.length));
    if (marker === null) {
      const skipTo = openIdx + SKILL_ENVELOPE_OPEN_PREFIX.length;
      pushText(stdout.slice(pos, skipTo));
      pos = skipTo;
      continue;
    }
    if (openIdx > pos) pushText(stdout.slice(pos, openIdx));
    const nonce = marker[1];
    const source = marker[2];
    const contentStart = termIdx + SKILL_ENVELOPE_MARKER_END.length;
    const closeMarker = `${SKILL_ENVELOPE_CLOSE_PREFIX}${nonce}${SKILL_ENVELOPE_MARKER_END}`;
    const closeIdx = stdout.indexOf(closeMarker, contentStart);
    if (closeIdx === -1) {
      segments.push({ untrusted: true, source, content: stdout.slice(contentStart) });
      break;
    }
    segments.push({ untrusted: true, source, content: stdout.slice(contentStart, closeIdx) });
    pos = closeIdx + closeMarker.length;
  }

  return segments;
}

type BashOutput = BashToolOutput;

function eveBashModelOutput(output: BashOutput): ToolModelOutput {
  const render = bash.toModelOutput;
  if (render === undefined) {
    throw new Error("skill-envelope: eve's bash definition carries no toModelOutput, so a bash result has no model rendering to keep. Read eve's bash tool again.");
  }
  const rendered = render(output);
  if (rendered instanceof Promise) {
    throw new Error("skill-envelope: eve's bash toModelOutput returned a promise. This wrapper renders synchronously. Read eve's bash tool again.");
  }
  return rendered;
}

export function bashModelOutput(output: unknown): ToolModelOutput {
  const o = output as BashOutput;
  const stdout = typeof o?.stdout === "string" ? o.stdout : "";
  const segments = extractSkillEnvelopes(stdout);
  if (!segments.some((s) => s.untrusted)) {
    return eveBashModelOutput(o);
  }
  const rebuiltStdout = segments
    .map((s) => {
      if (!s.untrusted) return s.text;
      const label = sanitizeSkillEnvelopeSource(s.source);
      return ingestUntrusted(s.content, { source: `skill-declared ${label}` });
    })
    .join("");
  return eveBashModelOutput({ ...o, stdout: rebuiltStdout });
}
