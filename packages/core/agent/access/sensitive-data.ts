import { SECRET_SHAPES } from "../audit/secret-shapes.js";
import { getSettings, type SensitivePatternSetting } from "../settings/settings.js";

export type SensitiveTier = "strictest" | "explicit";

export type SensitiveCategory = "card-number" | "government-id" | "secret" | "health" | "personal-finance" | "custom" | "unscannable";

export interface SensitiveFinding {
  readonly tier: SensitiveTier;
  readonly category: SensitiveCategory;
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

export interface SensitiveDetector {
  readonly type: string;
  readonly tier: SensitiveTier;
  readonly category: SensitiveCategory;
  readonly pattern: RegExp;
  readonly check?: (value: string) => boolean;
}

export function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function cardBrandValid(digits: string): boolean {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  if (digits.startsWith("4")) return n === 13 || n === 16 || n === 19;
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return n === 16;
  if (p2 === 34 || p2 === 37) return n === 15;
  if (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) return n >= 16 && n <= 19;
  if (p4 >= 3528 && p4 <= 3589) return n >= 16 && n <= 19;
  if ((p3 >= 300 && p3 <= 305) || p2 === 36 || p2 === 38 || p2 === 39) return n >= 14 && n <= 19;
  if (p2 === 62) return n >= 16 && n <= 19;
  return false;
}

function cardCheck(value: string): boolean {
  const digits = digitsOf(value);
  return cardBrandValid(digits) && luhnValid(digits);
}

export function mrzCheckDigit(field: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i]!;
    let v: number;
    if (c >= "0" && c <= "9") v = c.charCodeAt(0) - 48;
    else if (c >= "A" && c <= "Z") v = c.charCodeAt(0) - 55;
    else v = 0;
    sum += v * weights[i % 3]!;
  }
  return sum % 10;
}

function mrzCheck(value: string): boolean {
  const doc = value.slice(0, 9);
  const docCheck = Number(value[9]);
  const birth = value.slice(13, 19);
  const birthCheck = Number(value[19]);
  return mrzCheckDigit(doc) === docCheck && mrzCheckDigit(birth) === birthCheck;
}

export function nhsValid(value: string): boolean {
  const d = digitsOf(value);
  if (d.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (d.charCodeAt(i) - 48) * (10 - i);
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === d.charCodeAt(9) - 48;
}

export function ibanValid(value: string): boolean {
  const s = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const ch of v) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

export function abaValid(value: string): boolean {
  const d = digitsOf(value);
  if (d.length !== 9) return false;
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (d.charCodeAt(i) - 48) * w[i % 3]!;
  return sum % 10 === 0;
}

const SECRET_SHAPE_NAMES: Readonly<Record<string, string>> = { "sk-": "sk", "xox": "slack", "gh[": "github", "AKI": "aws-key" };

const HEALTH_TERMS =
  "diabetes|cancer|tumou?r|leukaemia|leukemia|lymphoma|hiv|aids|hepatitis|asthma|epilepsy|depression|anxiety disorder|bipolar|schizophrenia|adhd|autism|dementia|alzheimer'?s|parkinson'?s|multiple sclerosis|arthritis|hypertension|heart disease|stroke|covid(?:-19)?|tuberculosis|pregnan(?:t|cy)|miscarriage|insulin|metformin|chemotherapy|antidepressants?|sertraline|fluoxetine|methadone|opioids?|\\w+ disorder|\\w+ syndrome|\\w+ disease";

export const SHIPPED_DETECTORS: readonly SensitiveDetector[] = [
  {
    type: "card-luhn",
    tier: "strictest",
    category: "card-number",
    pattern: /(?<![\d.,-])(\d{13,19}|\d{4}[ .-]\d{4}[ .-]\d{4}[ .-]\d{4}(?:[ .-]\d{3})?|\d{4}[ .-]\d{6}[ .-]\d{4,5}|\d(?: \d){12,18})(?![\d-]|[.,]\d| \d)/g,
    check: cardCheck,
  },
  {
    type: "us-ssn",
    tier: "strictest",
    category: "government-id",
    pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
  },
  {
    type: "us-ssn-labelled",
    tier: "strictest",
    category: "government-id",
    pattern: /\b(?:SSN|social security(?: number| no\.?)?)\b[^\d\n]{0,20}((?!000|666|9\d\d)\d{3} ?(?!00)\d{2} ?(?!0000)\d{4})(?!\d)/gi,
  },
  {
    type: "uk-nino",
    tier: "strictest",
    category: "government-id",
    pattern: /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  },
  {
    type: "passport-labelled",
    tier: "strictest",
    category: "government-id",
    pattern: /\bpassport\b(?:[ \t]*(?:number|no\.?|num\.?|#|id))?[ \t]*(?:is|was|=|:|-)?[ \t]*\b((?=(?:[A-Z]*\d){5})[A-Z0-9]{6,9})\b/gi,
    check: (v) => /\d/.test(v) && v === v.toUpperCase(),
  },
  {
    type: "passport-mrz",
    tier: "strictest",
    category: "government-id",
    pattern: /([A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d[MFX<]\d{6}\d[A-Z0-9<]{14}[\d<]\d)/g,
    check: mrzCheck,
  },
  {
    type: "nhs-number",
    tier: "strictest",
    category: "government-id",
    pattern: /\bNHS\b[^\d\n]{0,25}(\d{3} ?\d{3} ?\d{4})(?!\d)/gi,
    check: nhsValid,
  },
  ...SECRET_SHAPES.filter((shape) => !shape.source.includes("Bearer")).map(
    (shape): SensitiveDetector => ({ type: `secret-${SECRET_SHAPE_NAMES[shape.source.slice(2, 5)] ?? "token"}`, tier: "strictest", category: "secret", pattern: shape }),
  ),
  { type: "secret-bearer", tier: "strictest", category: "secret", pattern: /\bBearer\s+(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*/g },
  { type: "secret-private-key", tier: "strictest", category: "secret", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  { type: "secret-github-pat", tier: "strictest", category: "secret", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { type: "secret-google-api-key", tier: "strictest", category: "secret", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "secret-stripe", tier: "strictest", category: "secret", pattern: /\b[rs]k_live_[0-9A-Za-z]{16,}/g },
  {
    type: "iban",
    tier: "explicit",
    category: "personal-finance",
    pattern: /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g,
    check: ibanValid,
  },
  {
    type: "uk-sort-code",
    tier: "explicit",
    category: "personal-finance",
    pattern: /\bsort[ -]?code\b[^\d\n]{0,15}(\d{2}[- ]?\d{2}[- ]?\d{2})(?!\d)/gi,
  },
  {
    type: "us-routing-number",
    tier: "explicit",
    category: "personal-finance",
    pattern: /\b(?:routing|ABA)\b(?: number| no\.?| #)?[^\d\n]{0,10}(\d{9})(?!\d)/gi,
    check: abaValid,
  },
  {
    type: "bank-account-number",
    tier: "explicit",
    category: "personal-finance",
    pattern: /\bbank account\b(?: number| no\.?| #)?[^\d\n]{0,10}(\d{6,17})(?!\d)/gi,
  },
  {
    type: "health-diagnosis",
    tier: "explicit",
    category: "health",
    pattern: new RegExp(`\\b(?:diagnosed with|diagnosis of|suffers from|suffering from|prescribed|is taking|treatment for)\\b[^.\\n]{0,40}?\\b(?:${HEALTH_TERMS})\\b`, "gi"),
  },
  {
    type: "health-record-number",
    tier: "explicit",
    category: "health",
    pattern: /\b(?:MRN|medical record (?:number|no\.?|#))\b[^A-Za-z0-9\n]{0,5}([A-Z0-9-]{5,})/gi,
    check: (v) => /\d/.test(v),
  },
  {
    type: "health-icd10",
    tier: "explicit",
    category: "health",
    pattern: /\bICD-?10(?:-CM)?(?: code)?\b[^A-Za-z0-9\n]{0,5}([A-TV-Z]\d{2}(?:\.\d{1,4})?)\b/gi,
  },
];

function detectorFromSetting(row: SensitivePatternSetting): SensitiveDetector {
  const flags = (row.flags ?? "").replace(/g/g, "");
  return { type: `custom:${row.type}`, tier: row.tier, category: "custom", pattern: new RegExp(row.pattern, `${flags}g`) };
}

function activeDetectors(): readonly SensitiveDetector[] {
  let extra: readonly SensitivePatternSetting[] = [];
  try {
    extra = getSettings().sensitiveData.extraPatterns;
  } catch {
    extra = [];
  }
  return extra.length === 0 ? SHIPPED_DETECTORS : [...SHIPPED_DETECTORS, ...extra.map(detectorFromSetting)];
}

const MAX_SCAN_CHARS = 4_194_304;

export const UNSCANNABLE_TYPE = "input-too-large";

export function scanSensitive(text: string, detectors: readonly SensitiveDetector[] = activeDetectors()): SensitiveFinding[] {
  if (text.length > MAX_SCAN_CHARS) return [{ tier: "strictest", category: "unscannable", type: UNSCANNABLE_TYPE, start: 0, end: 0 }];
  const scanned = text;
  const findings: SensitiveFinding[] = [];
  for (const d of detectors) {
    const re = new RegExp(d.pattern.source, d.pattern.flags.includes("g") ? d.pattern.flags : `${d.pattern.flags}g`);
    for (const m of scanned.matchAll(re)) {
      if (m[0].length === 0) continue;
      const value = m[1] ?? m[0];
      if (d.check !== undefined && !d.check(value)) continue;
      const start = m.index ?? 0;
      findings.push({ tier: d.tier, category: d.category, type: d.type, start, end: start + m[0].length });
    }
  }
  return findings.sort((a, b) => a.start - b.start);
}

const CATEGORY_WORDS: Readonly<Record<SensitiveCategory, string>> = {
  "card-number": "a card number",
  "government-id": "a government ID number",
  secret: "a secret or credential",
  health: "health data",
  "personal-finance": "personal financial data",
  custom: "data this organisation marks as sensitive",
  unscannable: "an input too large or too deeply nested to check",
};

export function describeCategories(findings: readonly SensitiveFinding[]): string {
  const order = Object.keys(CATEGORY_WORDS) as SensitiveCategory[];
  const present = order.filter((c) => findings.some((f) => f.category === c));
  const words = present.map((c) => CATEGORY_WORDS[c]);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function redactSpans(text: string, findings: readonly SensitiveFinding[]): string {
  if (findings.some((f) => f.category === "unscannable")) return `[withheld: ${CATEGORY_WORDS.unscannable}]`;
  const spans = [...findings].filter((f) => f.end <= text.length).sort((a, b) => a.start - b.start);
  if (spans.length === 0) return text;
  let out = "";
  let at = 0;
  for (const f of spans) {
    if (f.start < at) {
      at = Math.max(at, f.end);
      continue;
    }
    out += text.slice(at, f.start) + `[withheld: ${CATEGORY_WORDS[f.category]}]`;
    at = f.end;
  }
  return out + text.slice(at);
}

export function redactStrictest(text: string, findings: readonly SensitiveFinding[] = scanSensitive(text)): string {
  return redactSpans(text, findings.filter((f) => f.tier === "strictest"));
}
