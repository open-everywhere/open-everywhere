import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TODO_KIND,
  checkIngestionSites,
  findIngestionSites,
  routeKey,
  type IngestionSite,
} from "../agent/access/ingestion-binding-manifest.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const sitesIn = (src: string): IngestionSite[] => findIngestionSites("fixture.ts", src);
const defectsIn = (src: string) => checkIngestionSites(sitesIn(src));
const rules = (src: string) => defectsIn(src).map((d) => d.rule);

{
  const noKind = `noteIngestionVerdict({ label: "x" }, false);`;
  ok(sitesIn(noKind).length === 1, "synthetic: a noteIngestionVerdict call with no kind is still SEEN as a site");
  ok(rules(noKind).join() === "no-kind", "synthetic: 🔴 …and it is RED for no-kind (label is present here, so only no-kind fires)");

  const withKind = `noteIngestionVerdict({ kind: "webhook", label: "x" }, false);`;
  ok(rules(withKind).length === 0, "synthetic: the same site with a literal known kind is GREEN");
}
{
  const bad = `ingestion: { kind: "sms-message", label: "x" },`;
  ok(rules(bad).join() === "unknown-kind", "synthetic: 🔴 a kind literal not in the ratified table is RED — this is the failure mode a typo or an invented kind produces silently everywhere else in the tree");

  const good = bad.replace("sms-message", "webhook");
  ok(rules(good).length === 0, "synthetic: the same site with a real IngestionKind is GREEN");
}
{
  const noLabel = `ingestion: { kind: "web" },`;
  ok(rules(noLabel).join() === "no-label", "synthetic: 🔴 a site with no label field at all is RED");

  ok(rules(`ingestion: { kind: "web", label: "x" },`).length === 0, "synthetic: a literal label is GREEN");
  ok(rules("ingestion: { kind: \"web\", label: `dyn ${x}` },").length === 0, "synthetic: a TEMPLATE label is GREEN — its runtime value is never required to be static, only its presence");
  ok(rules(`ingestion: { kind: "connector", label: name },`).length === 0, "synthetic: a BOUND IDENTIFIER label (\`label: name\`) is GREEN — the real shape access/untrusted-projection.ts uses for a connector name");
  ok(rules(`ingestion: { kind: "skill-declared", label },`).length === 0, "synthetic: a bare SHORTHAND \`label\` property is GREEN — the real shape tools/sandbox_tools.ts uses for a sanitized runtime name");
}
{
  const unexplained = `ingestion: { kind: "TODO", label: "x" },`;
  ok(rules(unexplained).join() === "todo-unexplained", `synthetic: 🔴 kind: "${TODO_KIND}" with no adjacent comment is RED, not silently accepted`);
  ok(sitesIn(unexplained)[0]!.pending === false, "synthetic: …and the site itself is NOT marked pending — an unexplained TODO earns no exemption");

  const explainedAbove = `// TODO(ingestion): waiting on OPE-XXX to decide the source instance\ningestion: { kind: "TODO", label: "x" },`;
  ok(defectsIn(explainedAbove).length === 0, "synthetic: the SAME kind with a TODO(ingestion) comment directly above is GREEN — no defect");
  ok(sitesIn(explainedAbove)[0]!.pending === true, "synthetic: …and IS marked pending — the inventory generator's signal that this route is accepted-but-unresolved, not a normal route");

  const explainedSameLine = `ingestion: { kind: "TODO", label: "x" }, // TODO(ingestion): same-line is also adjacent`;
  ok(defectsIn(explainedSameLine).length === 0 && sitesIn(explainedSameLine)[0]!.pending === true, "synthetic: a same-line TODO(ingestion) comment counts as adjacent too");
}

{
  ok(sitesIn(`ingestion: { kind: "web", label: "x" },`)[0]!.form === "ingestion-property", "synthetic-shape: `ingestion: { … }` is form ingestion-property");

  const hoisted = `const ingestion = { kind: "aws", label: "aws" } as const;`;
  ok(sitesIn(hoisted).length === 1 && sitesIn(hoisted)[0]!.form === "ingestion-const", "synthetic-shape: `const ingestion = { … }` is form ingestion-const — the aws-output.ts / pr-feedback.ts shape shared by two+ call sites");

  ok(sitesIn(`noteIngestionVerdict({ kind: "chat-message", label: "x" }, taintMarkLands());`)[0]!.form === "noteIngestionVerdict", "synthetic-shape: a single-line noteIngestionVerdict call is form noteIngestionVerdict");

  const multiline = `noteIngestionVerdict(\n  { kind: "github", label: \`walk_pr:\${pr.repo}\` },\n  false,\n);`;
  const mSites = sitesIn(multiline);
  ok(mSites.length === 1 && mSites[0]!.form === "noteIngestionVerdict" && mSites[0]!.kindLiteral === "github", "synthetic-shape: a noteIngestionVerdict call whose `{` sits on the LINE AFTER the paren is still SEEN and still resolves its kind — the real pr-walkthrough.ts shape");

  const chat = sitesIn(`ingestion: chatReadIngestion("read_x", output),`)[0]!;
  ok(chat.form === "chatReadIngestion" && chat.kindLiteral === "chat-message" && chat.labelText === "read_x", "synthetic-shape: chatReadIngestion(label, out) is SEEN, its kind is the factory's own binding (chat-message), and its label is the call's first argument");
}

{
  ok(sitesIn(`  ingestion?: IngestionSource;`).length === 0, "synthetic-negative: an interface FIELD (`ingestion?:`) is not a declaration site — the `?` breaks the trigger");
  ok(
    sitesIn(`export function noteIngestionVerdict(src: IngestionSource | undefined, taintsToday: boolean): void {`).length === 0,
    "synthetic-negative: noteIngestionVerdict's own DEFINITION is not a site — the first token after the paren is `src`, not `{`",
  );
  ok(
    sitesIn(`export function chatReadIngestion(label: string, out: { readonly authoredByNonMember?: boolean }): IngestionSource {`).length === 0,
    "synthetic-negative: chatReadIngestion's own DEFINITION is not a site — the first token after the paren is `label`, not a quote",
  );
  ok(sitesIn(`// A provider read tool DECLARES what it is ingesting (\`ingestion: { kind, … }\` on its`).length === 0, "synthetic-negative: the shape quoted inside a comment (adapter-api.ts's own header) is not a site — comment-stripped before matching");
  ok(sitesIn(`{ channel: { kind: "notion" }, session: { auth: {} } }`).length === 0, "synthetic-negative: an UNRELATED \`kind:\` (a channel bindable's kind, provider channel files' real shape) is not a site — none of the four triggers fire without \`ingestion:\`/\`noteIngestionVerdict(\`/\`chatReadIngestion(\`/\`const ingestion =\`");
  ok(sitesIn(`  readonly kind: "connector";`).length === 0, "synthetic-negative: a TYPE declaration whose member happens to be named \`kind\` (permission-evidence.ts's ConnectorGrantUsage, an unrelated interface) is not a site");
}

{
  const a = { file: "a.ts", form: "ingestion-property" as const, labelText: "read_x" };
  const b = { file: "a.ts", form: "ingestion-const" as const, labelText: "read_x" };
  const c = { file: "b.ts", form: "ingestion-property" as const, labelText: "read_x" };
  ok(routeKey(a) === routeKey(b), "routeKey: two sites in the SAME file with the same label collide on purpose (the generator disambiguates with a #2 suffix, not this function) — key is file+label, not file+form");
  ok(routeKey(a) !== routeKey(c), "routeKey: the same label in a DIFFERENT file is a different route");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function tsFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
{
  const providerDirs = ["slack", "notion", "linear", "github", "teams", "discord"]
    .map((p) => join(root, "..", "providers", p, "agent"))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  const files = [...tsFilesUnder(join(root, "agent")), ...providerDirs.flatMap(tsFilesUnder)];
  ok(files.length > 100, `real: the scan actually read core's + providers' agent trees (${files.length} files) — a green over an empty file list is a green produced by blindness`);

  const sites = files.flatMap((f) => findIngestionSites(relative(root, f), readFileSync(f, "utf8")));
  const defects = checkIngestionSites(sites);
  ok(defects.length === 0, `real: every ingestion declaration site in the shipped tree binds a literal known kind with a label (${defects.map((d) => `${d.file}:${d.line} ${d.rule}`).join(", ")})`);

  const at = (needle: string) => sites.filter((s) => s.file.endsWith(needle));
  ok(at("access/aws-output.ts").some((s) => s.form === "ingestion-const" && s.kindLiteral === "aws"), "real: access/aws-output.ts's hoisted `const ingestion = { kind: \"aws\", … }` is SEEN — one descriptor shared by the stdout AND stderr fences");
  ok(at("scm/pr-feedback.ts").some((s) => s.form === "ingestion-const" && s.kindLiteral === "github"), "real: scm/pr-feedback.ts's hoisted `const ingestion = { kind: \"github\", … }` is SEEN — shared by four fenced-body call sites in one function");
  ok(at("review/pr-walkthrough.ts").some((s) => s.form === "noteIngestionVerdict" && s.kindLiteral === "github"), "real: review/pr-walkthrough.ts's noteIngestionVerdict — the multi-line paren-then-brace shape — is SEEN and resolves kind: github");
  ok(at("tools/read_channel.ts").some((s) => s.form === "chatReadIngestion" && s.kindLiteral === "chat-message"), "real: tools/read_channel.ts's chatReadIngestion call is SEEN, kind bound through the factory");
  const wakeEnvelope = at("channels/wake-envelope.ts");
  ok(wakeEnvelope.length === 2, `real: channels/wake-envelope.ts carries exactly its two known sites (chat-message body, handoff note) — saw ${wakeEnvelope.length}`);
  ok(wakeEnvelope.some((s) => s.kindLiteral === "handoff"), "real: …one of which is the handoff-note site (OPE-340)");
  ok(at("webhooks/dispatch.ts").length === 2, "real: webhooks/dispatch.ts carries both its webhook-body and webhook-summary sites");
  ok(at("access/untrusted-projection.ts").some((s) => s.kindLiteral === "connector" && s.labelText === "name"), "real: access/untrusted-projection.ts's connector site is SEEN with its bound-identifier label (`label: name`)");
  ok(at("tools/sandbox_tools.ts").some((s) => s.kindLiteral === "skill-declared" && s.hasLabel && s.labelText === undefined), "real: tools/sandbox_tools.ts's skill-declared site is SEEN with its bare shorthand `label` property");

  ok(sites.length >= 28, `real: the inventory is at least the ~28 sites re-derived for OPE-545 (saw ${sites.length}) — a collapse here means the detector stopped seeing, not that routes went away`);

  const channelRead = readFileSync(join(root, "agent", "channels", "channel-read.ts"), "utf8");
  ok(/export function chatReadIngestion\(/.test(channelRead), "real: channels/channel-read.ts still exports chatReadIngestion — the factory this lint's shape-4 trust depends on");
  ok(/return\s*\{\s*kind:\s*"chat-message"/.test(channelRead), "real: 🔴 …and its body still literally returns `{ kind: \"chat-message\", … }` — the promise findIngestionSites trusts without re-checking every call site");
}

console.log(`✓ ingestion-binding-lint-test: ${passed} assertion(s) passed`);
