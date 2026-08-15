import { checkCapabilityDocs, docCodeSpans, UNDOCUMENTED_TOOLS } from "../agent/docs/capability-map.js";
import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const doc = (path: string, ...spans: string[]) => ({ path, spans });
const check = (toolNames: string[], docs: { path: string; spans: string[] }[], exempt: Record<string, string> = {}) =>
  checkCapabilityDocs({ toolNames, docs, exempt });

{
  const r = check(["reply", "brand_new_tool"], [doc("docs/a.md", "reply")]);
  ok(r.problems.length === 1, "1a: exactly one problem for one undocumented tool");
  ok(r.problems[0].includes('"brand_new_tool"'), "1b: the problem names the undocumented tool");
  ok(r.problems[0].includes("UNDOCUMENTED_TOOLS"), "1c: the problem tells the author both ways out");
  ok(r.documented.length === 1 && r.documented[0] === "reply", "1d: the covered tool is still reported covered");
}

{
  const r = check(["a_tool", "b_tool", "c_tool"], []);
  ok(r.problems.length === 3, "2: an empty doc set fails for EVERY tool (the vacuous-lint case)");
}

{
  const r = check(["reply"], [doc("docs/a.md", "reply")]);
  ok(r.problems.length === 0, "3a: an exact inline span documents the tool");
  ok(r.coverage.get("reply")?.[0] === "docs/a.md", "3b: coverage names the documenting page");
}
{
  const r = check(["agent"], [doc("docs/a.md", "agent/tools/foo.ts", "the agent", "agents")]);
  ok(r.problems.length === 1, "4: a span merely CONTAINING the name does not document it");
}
{
  const r = check(["forget"], [doc("docs/a.md", "forget()")]);
  ok(r.problems.length === 0, "5: the `name()` call form counts as a mention");
}
{
  const spans = docCodeSpans("Use `reply` here.\n\n```ts\nconst x = `write_file`;\n```\n\nAnd `reply` again.\n");
  ok(spans.includes("reply"), "6a: an inline span in prose is extracted");
  ok(!spans.includes("write_file"), "6b: a span inside a FENCED block does not count (a sample is not documentation)");
  ok(spans.filter((s) => s === "reply").length === 1, "6c: spans are de-duplicated");
  ok(docCodeSpans("` padded `").includes("padded"), "6d: span text is trimmed");
  ok(!docCodeSpans("a ` b\nc ` d").includes("b\nc"), "6e: a span never crosses a newline");
}

{
  const r = check(["real_tool"], [], { real_tool: "a stated reason" });
  ok(r.problems.length === 0, "7: an exempt, undocumented tool passes — the table is a real escape hatch");
  ok(r.exempted[0] === "real_tool", "7b: the exemption is reported, not hidden");
}
{
  const r = check(["real_tool"], [doc("docs/a.md", "real_tool")], { gone_tool: "stale" });
  ok(r.problems.length === 1 && r.problems[0].includes("stale exemption"), "8: an exemption for a tool that is not mounted fails (it cannot outlive its tool)");
}
{
  const r = check(["real_tool"], [doc("docs/a.md", "real_tool")], { real_tool: "waived anyway" });
  ok(r.problems.length === 1 && r.problems[0].includes("drop the exemption"), "9a: an exemption for a DOCUMENTED tool fails as redundant");
  const empty = check(["real_tool"], [], { real_tool: "   " });
  ok(empty.problems.length === 1 && empty.problems[0].includes("empty reason"), "9b: an exemption with no reason fails — the reason IS the review");
}

{
  const shipped = Object.keys(UNDOCUMENTED_TOOLS).sort();
  ok(
    shipped.join(",") === "browser_tools,delegation_tools,sandbox_tools,task_cancel,task_sleep,task_update",
    `10a: the shipped exemption table is exactly the three resolver files plus the three still-undocumented flag-gated eve task tools (found: ${shipped.join(", ") || "none"}). If you are adding a row, justify it here too.`,
  );
  ok(
    shipped.every((n) => n in TOOL_CONSEQUENCE),
    "10b: every exempt name is a real registered tool (consequence-lint pins TOOL_CONSEQUENCE to the mounted surface)",
  );
  const SANCTIONED_REASONS = ["resolver file", "not mounted:"] as const;
  ok(
    shipped.every((n) => SANCTIONED_REASONS.some((r) => (UNDOCUMENTED_TOOLS[n] ?? "").includes(r))),
    "10c: every exemption states one of the TWO sanctioned reasons — a resolver FILE, or a tool eve gates behind a flag OE does not enable. Free-text reasons do not clear the bar",
  );
  const flagGated = shipped.filter((n) => (UNDOCUMENTED_TOOLS[n] ?? "").includes("not mounted:"));
  ok(flagGated.length > 0, "10e (guard): the flag-gated class is non-empty, so the check below is exercising something");
  ok(
    flagGated.every((n) => {
      const reason = UNDOCUMENTED_TOOLS[n] ?? "";
      return reason.includes("experimental.tasks") && /OPE-\d+/u.test(reason);
    }),
    "10e: every flag-gated exemption names the FLAG that would invalidate it and the OPE ticket that owns the flip — the row carries its own expiry, because nothing here can read eve's runtime flag",
  );
  ok(shipped.length * 10 < Object.keys(TOOL_CONSEQUENCE).length, "10d: exemptions stay a rounding error against the tool surface, not the norm");
}

console.log(`✓ capability-docs: ${passed} assertions — totality fails closed on an undocumented capability, and the exemption table cannot grow into a blanket`);
