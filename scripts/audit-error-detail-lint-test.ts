import assert from "node:assert/strict";
import { blankCommentsAndStrings, parseSource } from "./hook-throw-lint.js";
import { BRAND_MINT_FILE, MIN_PLAUSIBLE_WRITES, auditErrorDetailFindings, carriesRawErrorText, isAuditWriter, readScanFiles, scanTree } from "./audit-error-detail-lint.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const findings = (source: string) => auditErrorDetailFindings("made-up.ts", source).findings;
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

{
  const flow = findings(
    'try { x(); } catch (err) {\n  const message = err instanceof Error ? err.message : String(err);\n  await appendAudit({ org, action: "approval.failed", detail: { id: row.id, ...venue, error: message } });\n}\n',
  );
  ok(flow.length === 1 && flow[0]!.rule === "error-field" && flow[0]!.key === "error", "error-field: `error: message` in an appendAudit detail is refused (approval.failed)");
  ok(flow[0]!.line === 3, "error-field: the finding names the writing LINE (3)");
}
{
  const writes = findings('await appendAudit({\n  org: a.org,\n  action: "memory.delete",\n  detail: { silo, relPath, deleted: false, error: message },\n});\n');
  ok(writes.length === 1 && writes[0]!.line === 4, "error-field: a multi-line appendAudit record is read (memory.delete)");
}
{
  const allowRule = findings('await auditAllowRuleRefused(row, clickerId, "write-failed", { ...venue, error: message });\n');
  ok(allowRule.length === 1, "error-field: a wrapper whose name holds `audit` is a writer (the allow-rule write-failed row)");
}
{
  const egress = findings('await audit({ action: "egress.policy", detail: { hosts, ...(compileError ? { error: compileError } : {}), ...(enforceError ? { enforceError } : {}) } });\n');
  ok(egress.length === 2, "error-field: a conditional spread is read, and the shorthand `{ enforceError }` is refused (egress.policy)");
  ok(egress.map((f) => f.key).join(",") === "error,enforceError", "error-field: both keys are named");
}
{
  ok(findings('await appendAudit({ action: "a", detail: { error: String(err).slice(0, 300) } });\n').length === 1, "error-field: a truncation is not a scrub — `.slice(0, 300)` is refused");
  ok(findings('await appendAudit({ action: "a", detail: { error: err instanceof Error ? err.name : "error" } });\n').length === 1, "error-field: a conditional with one raw branch is refused");
  ok(findings('await appendAudit({ action: "a", detail: { error: `failed: ${err}` } });\n').length === 1, "error-field: a template with a substitution is refused");
  ok(findings('await appendAudit({ action: "a", detail: { error: "a" + err } });\n').length === 1, "error-field: a concatenation that opens with a literal is refused");
  ok(findings('await appendAudit({ action: "a", detail: { deliveryError: e } });\n').length === 1, "error-field: a `…Error` key is error-named");
  ok(findings('await appendAudit({ action: "a", detail: { err } });\n').length === 1, "error-field: the bare `err` shorthand is refused");
  ok(findings('await appendAudit({ action: "a", detail: { error: auditErrorDetail(err) } });\n').length === 1, "error-field: the reducer's RECORD under `error` (no `.error`) is refused");
}
{
  const built = findings('const detail = { id, error: message };\nawait appendAudit({ action: "a", detail });\n');
  ok(built.length === 1 && built[0]!.line === 1, "error-field: a `detail` literal built before the write is read");
}
{
  const raw = findings('await appendAudit({ action: "a", detail: { reason: err instanceof Error ? err.message.slice(0, 200) : String(err) } });\n');
  ok(raw.length === 1 && raw[0]!.rule === "raw-error-text" && raw[0]!.key === "reason", "raw-error-text: `.message` under any key is refused");
  ok(findings('await auditCancel(input, { outcome: "error", note: String(err) });\n')[0]?.rule === "raw-error-text", "raw-error-text: `String(err)` under any key is refused");
  ok(findings('await appendAudit({ action: "a", detail: { trace: e.stack } });\n')[0]?.rule === "raw-error-text", "raw-error-text: `.stack` under any key is refused");
  const templ = findings('await appendAudit({ action: "a", detail: { outcome: `failed: ${err.message}` } });\n');
  ok(templ.length === 1 && templ[0]!.rule === "raw-error-text" && templ[0]!.key === "outcome", "raw-error-text: `.message` inside a template's `${…}` is refused, on its own key only (the blanker hides it)");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `failed: ${auditErrorDetail(err.message).error}` } });\n').length === 0, "raw-error-text (negative control): a template part that goes through the reducer is accepted");
}

{
  ok(findings('await appendAudit({ action: "a", detail: { id, ...auditErrorDetail(err) } });\n').length === 0, "accepted: the spread `...auditErrorDetail(err)`");
  ok(findings('await appendAudit({ action: "a", detail: { error: auditErrorDetail(err).error } });\n').length === 0, "accepted: `auditErrorDetail(err).error`");
  ok(findings('await appendAudit({ action: "a", detail: { error: auditErrorDetail(e instanceof Error ? e.name : "x").error } });\n').length === 0, "accepted: a reducer call whose argument holds a conditional");
  ok(findings('await appendAudit({ action: "a", detail: { error: "timeout", errorCount: 0, failedError: null } });\n').length === 0, "accepted: literals");
  ok(findings('await appendAudit({ action: "a", detail: { error: ok ? "none" : auditErrorDetail(err).error } });\n').length === 0, "accepted: a conditional whose every branch is accepted");
  ok(findings('const error = auditErrorDetail(err).error;\nawait appendAudit({ action: "a", detail: { error } });\nawait appendAudit({ action: "b", detail: { error: error } });\n').length === 0, "accepted: a name the file binds to `auditErrorDetail(…).error`, long form and shorthand");
  ok(findings('await auditRoutineFireLost(r, error, deps);\n').length === 0, "accepted: a POSITIONAL argument named `error` is not a field");
  ok(findings('export async function auditLink(input: { readonly org: string; error: unknown }): Promise<void> {}\n').length === 0, "accepted: a writer's DECLARATION is a type, not a write");
  ok(findings('const x = { error: message };\nlog({ error: message });\n').length === 0, "accepted: an object outside any audit write is not read");
  ok(findings('await appendAudit({ action: "a", detail: { chars: input.message.length } });\n').length === 0, "accepted: the LENGTH of a message is a number, not its text");
  ok(findings('// appendAudit({ detail: { error: message } })\nconst s = "appendAudit({ error: message })";\n').length === 0, "accepted: a comment or a string that quotes a write is not a write");
  ok(findings('await appendAudit({ action: "a", detail: { frames: auditErrorFrames(err), ...auditErrorDetail(err) } });\n').length === 0, "accepted: the frames reducer is not raw text");
}
{
  ok(isAuditWriter("appendAudit") && isAuditWriter("audit") && isAuditWriter("noteAudienceChange") && isAuditWriter("auditRetirement"), "writers: the road names and every `audit` name are writers");
  ok(!isAuditWriter("auditErrorDetail") && !isAuditWriter("readAudit") && !isAuditWriter("log"), "writers (negative control): the reducers, a read and an unrelated call are not");
  ok(carriesRawErrorText("String(err)") && !carriesRawErrorText("auditErrorDetail(String(err)).error"), "raw text: a reducer call hides the raw text inside it");
}

{
  ok(findings('const message = err.message;\nawait appendAudit({ action: "a", detail: { reason: message } });\n').length === 0, "LIMIT 1: raw text held in a variable under a NON-error key is not seen — put error text under an error-named key");
  ok(findings('const row = { error: message };\nawait appendAudit({ action: "a", detail: row });\n').length === 0, "LIMIT 2: a record built under a name with no `detail` in it is not read — for an error-named key the type brand refuses it (OPE-2549)");
  ok(findings('const extra = { error: message };\nawait appendAudit({ action: "a", detail: { ...extra } });\n').length === 0, "LIMIT 3: a spread of an object built elsewhere is not followed — for an error-named key the type brand refuses it (OPE-2549)");
  ok(findings('function quiet(message: string) {\n  return appendAudit({ action: "a", detail: { message: message.slice(0, 500) } });\n}\n').length === 0, "LIMIT 4: a PARAMETER holding error text under a non-error key is not seen");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: errBrief(err) } });\n').length === 0, "LIMIT 5: error text a helper renders is not seen — the helper must scrub");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `failed: ${`x ${String(err)}`}` } });\n').length === 1, "CLOSED (OPE-2549): a template NESTED in a template's `${…}` is now read — the blanker walks the parts");
}

{
  const plain = findings('function f(extra: Record<string, unknown>) {\n  return appendAudit({ action: "a", detail: { id, ...extra } });\n}\n');
  ok(plain.length === 1 && plain[0]!.rule === "plain-record-spread" && plain[0]!.line === 2, "plain-record-spread: a spread of a name typed `Record<string, unknown>` in an audit write is refused");
  ok(findings('function f(o: { readonly anchor?: Readonly<Record<string, string>> }) {\n  return appendAudit({ action: "a", detail: { id, ...(o.anchor ?? {}) } });\n}\n').length === 1, "plain-record-spread: a Readonly record field, reached through a member and `?? {}`, is refused");
  ok(findings('await appendAudit({ action: "a", detail: { ...Object.fromEntries(pairs), id } });\n').length === 1, "plain-record-spread: `...Object.fromEntries(…)` is refused");
  ok(findings('function f(extra: AuditDetail) {\n  return appendAudit({ action: "a", detail: { id, ...extra } });\n}\n').length === 0, "plain-record-spread (negative control): a spread of an `AuditDetail` is accepted");
  ok(findings('function f(extra: Record<string, unknown>) {\n  log({ ...extra });\n}\n').length === 0, "plain-record-spread (negative control): a spread outside an audit write is not read");
  ok(findings('await appendAudit({ action: "a", detail: { ...auditErrorDetail(err), id } });\n').length === 0, "plain-record-spread (negative control): a call to a function the tree does not declare as returning a plain record is accepted");
  ok(findings('function diag(): Record<string, string> { return {}; }\nawait appendAudit({ action: "a", detail: { id, ...diag() } });\n').length === 1, "plain-record-spread: a call to a function declared to return `Record<string, …>` is refused (the TS gap)");
  ok(findings('const diag = (x: number): Readonly<Record<string, unknown>> => ({});\nawait appendAudit({ action: "a", detail: { id, ...diag(1) } });\n').length === 1, "plain-record-spread: an arrow declared to return a plain record is refused");
  ok(auditErrorDetailFindings("w.ts", 'await appendAudit({ action: "a", detail: { id, ...fieldsOf(x) } });\n', new Set(["fieldsOf"])).findings.length === 1, "plain-record-spread: a helper declared in ANOTHER scanned file is refused through the tree set");
  ok(findings('function f(d: StoredAuditDetail) {\n  return appendAudit({ action: "a", detail: { id, ...d } });\n}\n').length === 1, "plain-record-spread: a spread of a `StoredAuditDetail` (a read row) is refused");
  ok(findings('function f(d: { [k: string]: string }) {\n  return appendAudit({ action: "a", detail: { id, ...d } });\n}\n').length === 1, "plain-record-spread: an inline index-signature type is refused");
  ok(findings('function f(extra: Record<string, unknown>) {\n  return appendAudit({ action: "a", detail: { id, ...(extra.ok ? { a: 1 } : {}) } });\n}\n').length === 0, "plain-record-spread (negative control): the TEST of a conditional spread is not its subject");
  ok(findings('class C {\n  diag(): Record<string, string> { return {}; }\n  async w() { await appendAudit({ action: "a", detail: { id, ...this.diag() } }); }\n}\n').length === 1, "plain-record-spread: a METHOD declared to return a plain record is refused");
  ok(findings('const diag = function (): Record<string, string> { return {}; };\nawait appendAudit({ action: "a", detail: { id, ...diag() } });\n').length === 1, "plain-record-spread: a function EXPRESSION declared to return a plain record is refused");
  ok(findings('const diag = <T,>(x: T): Record<string, string> => ({});\nawait appendAudit({ action: "a", detail: { id, ...diag(1) } });\n').length === 1, "plain-record-spread: a GENERIC arrow declared to return a plain record is refused");
}
{
  const nested = findings('const s = `a ${xs.map((x) => `${x}`).join(",")} b`;\nawait appendAudit({ action: "a", detail: { error: message } });\n');
  ok(nested.length === 1 && nested[0]!.line === 2, "blanker: a write AFTER a nested template is still read (it used to blank the rest of the file)");
  const pg = findings('function q(name: string) {\n  return `"${name.replace(/"/g, \'""\')}"`;\n}\nawait appendAudit({ action: "a", detail: { error: message } });\n');
  ok(pg.length === 1 && pg[0]!.line === 4, "blanker: a regex holding a quote inside a template part does not hide the rest of the file");
  const top = findings('const strip = (s: string) => s.replace(/[`\'"]/g, "");\nawait appendAudit({ action: "a", detail: { error: message } });\n');
  ok(top.length === 1 && top[0]!.line === 2, "blanker: a top-level regex holding a backtick and quotes does not hide the rest of the file");
  ok(findings('const half = total / 2; const s = "a/b";\nawait appendAudit({ action: "a", detail: { error: message } });\n').length === 1, "blanker (negative control): a division is not a regex, so the write after it is still read");
  const afterComment = findings('f(a, // note\n  /can\'t/);\nawait appendAudit({ action: "a", detail: { error: message } });\n');
  ok(afterComment.length === 1 && afterComment[0]!.line === 3, "blanker: a quoted regex on the line after a `//` comment is judged by the token before the comment");
  const afterIf = findings('if (ok) /\'/.test(s);\nawait appendAudit({ action: "a", detail: { error: message } });\n');
  ok(afterIf.length === 1 && afterIf[0]!.line === 2, "blanker: a regex that opens a statement after `if (…)` is a regex, so the write after it is read (CLOSED, OPE-2554)");
  const afterWhile = findings('while (go()) /"/g.exec(s);\nfor (;;) /`/.test(s);\nawait appendAudit({ action: "a", detail: { error: message } });\n');
  ok(afterWhile.length === 1 && afterWhile[0]!.line === 3, "blanker: a quoted regex after `while (…)` and `for (…)` does not hide the rest of the file");
  ok(findings('const r = (a + b) / 2; const s = "it\'s";\nawait appendAudit({ action: "a", detail: { error: message } });\n').length === 1, "blanker (negative control): a division after `)` is still a division");
  const jsx = 'const el = <p>appendAudit(error, message.stack)</p>;\n';
  const jsxCode = blankCommentsAndStrings(jsx, parseSource(jsx, "v.tsx"));
  ok(!jsxCode.includes("appendAudit") && jsxCode.includes("const el"), "blanker: JSX text in a `.tsx` file is text, so it is blanked, and the code around it is kept");
  ok(auditErrorDetailFindings("v.tsx", jsx).findings.length === 0, "blanker: a write QUOTED in JSX text is not a write");
  ok(throws(() => parseSource(jsx, "v.ts")), "parser: JSX in a `.ts` file is a syntax error, and it throws (the dialect follows the file name)");
  ok(throws(() => auditErrorDetailFindings("m.ts", "const a = xs as AuditDetail[];\nconst b = ;\n")), "parser: a file with a syntax error throws, so the lint never reports it clean");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `x ${{ a: 1 }.a + err.message}` } });\n').length === 1, "raw-error-text: a template part that opens with an object literal is parsed as an expression and read");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `x ${ { a: 1, b: 2 }[k] + "{" + err.message + "}" }` } });\n').length === 1, "raw-error-text: balanced braces inside strings in a template part do not hide the read");
  for (const part of ['"}" + err.message', "a /* } */ + err.message", '/}/.test(s) ? err.message : ""']) {
    ok(findings(`await appendAudit({ action: "a", detail: { outcome: \`x \${${part}}\` } });\n`).length === 1, `raw-error-text: a lone \`}\` in a literal or a comment does not close the part early (\`\${${part}}\`)`);
  }
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `x ${ { m: err.message }.m }` } });\n').length === 1, "raw-error-text: an object literal inside a template part is read");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `x ${(() => { return err.message; })()}` } });\n').length === 1, "raw-error-text: a function body inside a template part is read");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: `x ${ { m: scrubAuditText(err.message) }.m }` } });\n').length === 0, "raw-error-text (negative control): a reducer call inside a part's object literal is still accepted");
  ok(findings('await appendAudit({ action: "a", detail: { meta: { note: `x ${err.message}` } } });\n').map((f) => f.key).join(",") === "note", "raw-error-text: a template in a nested object answers for its own key only");
}

{
  ok(findings('import { extra } from "./elsewhere.js";\nawait appendAudit({ action: "a", detail: { id, ...extra } });\n').length === 0, "LIMIT: a plain-record VARIABLE imported from another file is not seen — its type lives in that file");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: (() => { return err.message; })() } });\n').length === 0, "LIMIT: a function body directly in the value (not in a template part) is skipped like a nested object");
  ok(findings('function f(extra: Record<string, unknown>, ok: boolean) {\n  return appendAudit({ action: "a", detail: { id, ...(ok ? extra : {}) } });\n}\n').length === 0, "LIMIT: a plain record in a BRANCH of a conditional spread is not seen — only a spread's subject is read");
}

{
  const scan = scanTree(readScanFiles());
  ok(scan.writes >= MIN_PLAUSIBLE_WRITES, `tree: the scan read ${scan.writes} audit writes, at or above the floor of ${MIN_PLAUSIBLE_WRITES}`);
  ok(scan.findings.length === 0, `tree: no audit write stores raw error text (found: ${scan.findings.map((f) => `${f.file}:${f.line} ${f.key}`).join("; ")})`);
  ok(scanTree([]).writes < MIN_PLAUSIBLE_WRITES, "tree: an empty walk falls under the floor, so main() refuses it");
}

{
  ok(findings('await appendAudit({ action: "a", detail: { deliveryError: scrubAuditText(text) } });\n').length === 0, "accepted: `scrubAuditText(…)` under an error-named key");
  ok(findings('const note = scrubAuditText(text);\nawait appendAudit({ action: "a", detail: { error: note } });\n').length === 0, "accepted: a name the file binds to `scrubAuditText(…)`");
  ok(findings('await appendAudit({ action: "a", detail: { outcome: scrubAuditText(err.message) } });\n').length === 0, "accepted: raw text INSIDE `scrubAuditText(…)` is not raw");
  ok(findings('await appendAudit({ action: "a", detail: { error: scrubAuditText(text).slice(0, 9) } });\n').length === 1, "error-field: a value that only STARTS with the reducer is refused");
  ok(!isAuditWriter("scrubAuditText"), "writers: `scrubAuditText` is a reducer, not a write");
  const cast = findings('const x = raw as ScrubbedAuditText;\nconst y = <ScrubbedAuditText>raw;\n');
  ok(cast.length === 2 && cast.every((f) => f.rule === "brand-cast") && cast[0]!.line === 1 && cast[1]!.line === 2, "brand-cast: both cast forms are refused, on their lines");
  ok(findings('// a cast `as ScrubbedAuditText` in a comment\nconst s = "as ScrubbedAuditText";\n').length === 0, "brand-cast (negative control): a comment or a string that names the cast is not a cast");
  ok(auditErrorDetailFindings(BRAND_MINT_FILE, "function f(text: string) { return text as ScrubbedAuditText; }\n").findings.length === 0, "brand-cast (negative control): the module that mints the brand may cast");
  const shapeCast = findings('const d = raw as AuditDetail;\nconst e = raw as unknown as AuditDetail;\nconst f = raw as AuditDetailBuilder;\n');
  ok(shapeCast.length === 3 && shapeCast.every((f) => f.rule === "brand-cast"), "brand-cast: a cast of a whole detail to `AuditDetail`, through `unknown` or not, is refused");
  ok(findings('const d: AuditDetail = { id };\nfunction g(x: AuditDetailBuilder) {}\n').length === 0, "brand-cast (negative control): annotating with the detail type is not a cast");
  ok(findings('const h = async (): Promise<AuditDetail> => ({});\nconst xs: Array<ScrubbedAuditText> = [];\nconst m = new Map<string, AuditDetail>();\n').length === 0, "brand-cast (negative control): a type ARGUMENT (`Promise<AuditDetail>`) is not a cast");
  ok(findings('function g(raw: string) { return <ScrubbedAuditText>raw; }\nasync function h(x: unknown) { return await <AuditDetail>x; }\nconst g = (x: unknown) => <AuditDetail>x;\n').length === 3, "brand-cast: an angle cast after a keyword or an arrow (`return <ScrubbedAuditText>raw`, `=> <AuditDetail>x`) is refused");
  ok(findings('const xs = Array.of<AuditDetail>(d);\n').length === 0, "brand-cast (negative control): a type argument after a MEMBER named like a keyword (`Array.of<AuditDetail>`) is not a cast");
  ok(findings('type T = ScrubbedAuditText;\nconst v: ScrubbedAuditText = scrubAuditText(t);\n').length === 0, "brand-cast (negative control): naming the type is not a cast");
  const containers = findings(
    [
      "const a = <AuditDetail[]>xs;",
      "const b = xs as Array<AuditDetail>;",
      "const c = xs as readonly ScrubbedAuditText[];",
      "const d = m as Record<string, ScrubbedAuditText>;",
      "const e = r as { error: ScrubbedAuditText };",
      "const f = p as Promise<AuditDetail>;",
      "const g = t as [AuditDetail, number];",
      "const h = xs as unknown as ReadonlyArray<AuditDetailBuilder>;",
      'const i = x as import("./scrubbed-text.js").AuditDetail;',
      "const j = x as audit.ScrubbedAuditText | undefined;",
      "",
    ].join("\n"),
  );
  ok(containers.length === 10 && containers.every((f) => f.rule === "brand-cast"), `brand-cast: a cast to a CONTAINER of the brand is refused, in every form (found ${containers.length}: ${containers.map((f) => f.value).join("; ")})`);
  ok(containers.map((f) => f.line).join(",") === "1,2,3,4,5,6,7,8,9,10", "brand-cast: each container cast is named on its own line");
  ok(findings('const xs: AuditDetail[] = [];\nconst ys = [] satisfies AuditDetail[];\nconst n = x as { AuditDetail: string };\nconst k = x as const;\n').length === 0, "brand-cast (negative control): an annotation, `satisfies`, a property NAMED like the brand and `as const` are not brand casts");
  ok(auditErrorDetailFindings(BRAND_MINT_FILE, "const xs = raw as ScrubbedAuditText[];\n").findings.length === 0, "brand-cast (negative control): the module that mints the brand may cast to a container of it");
  const renamed = findings('import type { AuditDetail as AD, ScrubbedAuditText as S } from "./scrubbed-text.js";\nconst a = x as AD;\nconst b = y as S[];\n');
  ok(renamed.length === 2 && renamed[0]!.line === 2 && renamed[1]!.line === 3, "brand-cast: a cast to a RENAMED import of the brand is refused");
  ok(findings('import type { "AuditDetail" as AD } from "./s.js";\nimport AE = audit.ScrubbedAuditText;\nexport import AF = audit.AuditDetail;\nconst a = x as AD;\nconst b = y as AE;\nconst c = z as AF;\n').length === 3, "brand-cast: a string-named import and an `import X =` alias of the brand, exported or not, are refused");
  ok(findings('import type { Other as AuditDetailish } from "./x.js";\nconst a = x as AuditDetailish;\n').length === 0, "brand-cast (negative control): a renamed import of another type is not the brand");
  ok(findings("type D = AuditDetail[];\nconst a = xs as D;\n").length === 0, "LIMIT: a cast to a local ALIAS of the brand is not seen — the rule reads the type as written, not resolved");
}

console.log(`audit-error-detail-lint-test: ${n} assertions passed`);
