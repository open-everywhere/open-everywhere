const { taintContextLine, isLiveTaintLine, liveTaintGateDecision, liveMeasurementVerdict } = await import("./e2e/taint-context-line.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const liveWebTainted = 'reply prose before it… context: unattended: false · tainted: true (web) …reply prose after';

const liveClean = "context: unattended: false · tainted: false";

const liveLinearTainted = "context: unattended: false · tainted: true (linear)";

const suppliedTrueOverClean =
  "context: unattended: false · tainted: true — supplied by the caller, not this turn's own signal (this turn: false)";

const suppliedTrueWithWebAside =
  "context: unattended: false · tainted: true — supplied by the caller, not this turn's own signal (this turn: true (web))";

const suppliedFalse = "context: unattended: false · tainted: false — supplied by the caller, not this turn's own signal (this turn: false)";

{
  ok(
    taintContextLine(liveWebTainted) === "context: unattended: false · tainted: true (web) …reply prose after",
    "taintContextLine: pulls the `context:` line out of surrounding prose, to end of text/line",
  );
  ok(taintContextLine("no context line here at all") === "", "taintContextLine: absent line → empty string, not a false match");
}

{
  ok(isLiveTaintLine(taintContextLine(liveWebTainted)), "isLiveTaintLine: a genuine live tainted:true(web) line reads as live");
  ok(isLiveTaintLine(taintContextLine(liveClean)), "isLiveTaintLine: a genuine live tainted:false line ALSO reads as live (label is about supply, not the bit)");
  ok(isLiveTaintLine(taintContextLine(liveLinearTainted)), "isLiveTaintLine: a genuine live linear-tainted line reads as live");
  ok(!isLiveTaintLine(taintContextLine(suppliedTrueOverClean)), "isLiveTaintLine: a supplied tainted:true over a clean turn does NOT read as live");
  ok(!isLiveTaintLine(taintContextLine(suppliedTrueWithWebAside)), "isLiveTaintLine: a supplied line still fails live even when its own aside also says web");
  ok(!isLiveTaintLine(taintContextLine(suppliedFalse)), "isLiveTaintLine: a supplied tainted:false line does NOT read as live either");
  ok(!isLiveTaintLine(""), "isLiveTaintLine: an absent line is never live (=== false, not merely unmatched)");
}

{
  const oldArmAGate1 = (text: string): boolean => /tainted:\s*true/i.test(text);
  const oldArmAGate2 = (text: string): boolean => /\bweb\b/i.test(text);
  const newArmAGate1 = (text: string): boolean => {
    const line = taintContextLine(text);
    return isLiveTaintLine(line) && /tainted:\s*true/i.test(line);
  };
  const newArmAGate2 = (text: string): boolean => {
    const line = taintContextLine(text);
    return isLiveTaintLine(line) && /\bweb\b/i.test(line);
  };

  ok(oldArmAGate1(suppliedTrueOverClean), "ANTI-VACUITY (ARM A gate 1): the OLD bare regex WRONGLY passes a supplied tainted:true over a clean turn");
  ok(!newArmAGate1(suppliedTrueOverClean), "ANTI-VACUITY (ARM A gate 1 FIXED): the NEW live-gated check correctly refuses the same forged line");
  ok(newArmAGate1(liveWebTainted), "ANTI-VACUITY (ARM A gate 1 control): the NEW check still passes a genuine live tainted:true");

  ok(
    oldArmAGate1(suppliedTrueWithWebAside) && oldArmAGate2(suppliedTrueWithWebAside),
    "ANTI-VACUITY (ARM A gates 1+2): the OLD gates BOTH wrongly pass a supplied line whose own aside also mentions web",
  );
  ok(
    !newArmAGate1(suppliedTrueWithWebAside) && !newArmAGate2(suppliedTrueWithWebAside),
    "ANTI-VACUITY (ARM A gates 1+2 FIXED): the NEW gates BOTH correctly refuse that same forged line",
  );
  ok(newArmAGate2(liveWebTainted), "ANTI-VACUITY (ARM A gate 2 control): the NEW check still passes a genuine live web-tainted line");

  const oldArmDGate = (text: string): boolean => {
    const kinds = /tainted:\s*(?:true|false)\s*(?:\(([^)]*)\))?/i.exec(text)?.[1] ?? "";
    return /tainted:\s*(?:true|false)/i.test(text) && !/\blinear\b/i.test(kinds);
  };
  const newArmDGate = (text: string): boolean => {
    const line = taintContextLine(text);
    const kinds = /tainted:\s*(?:true|false)\s*(?:\(([^)]*)\))?/i.exec(line)?.[1] ?? "";
    return isLiveTaintLine(line) && /tainted:\s*(?:true|false)/i.test(line) && !/\blinear\b/i.test(kinds);
  };

  ok(oldArmDGate(suppliedFalse), "ANTI-VACUITY (ARM D): the OLD gate WRONGLY passes a supplied line with no kind breakdown at all");
  ok(!newArmDGate(suppliedFalse), "ANTI-VACUITY (ARM D FIXED): the NEW live-gated check correctly refuses the same forged (unfalsifiable) line");
  ok(newArmDGate(liveClean), "ANTI-VACUITY (ARM D control, true positive): the NEW check still passes a genuine live untainted read");
  ok(!newArmDGate(liveLinearTainted), "ANTI-VACUITY (ARM D control, regression caught): a genuine live LINEAR-tainted line still fails the gate (not vacuous the other way either)");
  ok(oldArmDGate(liveLinearTainted) === false, "ANTI-VACUITY (ARM D control): the OLD gate also caught a genuine linear regression — the defect was specific to the supplied shape, not a blanket vacuity");
}

{
  ok(
    liveTaintGateDecision(taintContextLine(suppliedTrueWithWebAside)).hard === false,
    "OPE-789: a model-composed simulation (worker supplied `tainted`) dispatches SOFT — logged, not gated, even when its own aside also says web",
  );
  ok(
    liveTaintGateDecision(taintContextLine(suppliedFalse)).hard === false,
    "OPE-789: a supplied tainted:false line also dispatches SOFT",
  );
  ok(liveTaintGateDecision("").hard === false, "OPE-789: no context line at all dispatches SOFT — never a false hard-pass");

  const decisionLive = liveTaintGateDecision(taintContextLine(liveWebTainted));
  ok(decisionLive.hard === true, "OPE-789: a genuine live tainted:true(web) measurement dispatches HARD");
  ok(
    decisionLive.hard && /tainted:\s*true/i.test(decisionLive.line) && /\bweb\b/i.test(decisionLive.line),
    "OPE-789: on that HARD dispatch, both ARM A assertions (tainted:true, names web) evaluate TRUE — a correct live run passes",
  );

  const decisionLiveClean = liveTaintGateDecision(taintContextLine(liveClean));
  ok(
    decisionLiveClean.hard === true,
    "OPE-789 NEGATIVE CONTROL: a genuine live tainted:false measurement still dispatches HARD (plane failure is never demoted to soft)",
  );
  ok(
    decisionLiveClean.hard && !/tainted:\s*true/i.test(decisionLiveClean.line),
    "OPE-789 NEGATIVE CONTROL: ARM A's tainted:true assertion evaluates FALSE on that live line — the ctx.gate call would still throw",
  );

  const decisionLiveLinear = liveTaintGateDecision(taintContextLine(liveLinearTainted));
  ok(
    decisionLiveLinear.hard === true,
    "OPE-789 NEGATIVE CONTROL: a genuine live linear-tainted line (wrong route for ARM A) still dispatches HARD",
  );
  ok(
    decisionLiveLinear.hard && !/\bweb\b/i.test(decisionLiveLinear.line),
    "OPE-789 NEGATIVE CONTROL: ARM A's \"names web\" assertion evaluates FALSE on that live line — the ctx.gate call would still throw",
  );
}

{
  const armDGateResult = (text: string): "soft" | boolean => {
    const line = taintContextLine(text);
    const decision = liveTaintGateDecision(line);
    if (!decision.hard) return "soft";
    const kinds = /tainted:\s*(?:true|false)\s*(?:\(([^)]*)\))?/i.exec(decision.line)?.[1] ?? "";
    return /tainted:\s*(?:true|false)/i.test(decision.line) && !/\blinear\b/i.test(kinds);
  };

  ok(armDGateResult(suppliedFalse) === "soft", "OPE-799: ARM D's composed gate dispatches SOFT on a supplied (simulated) line with no kind breakdown — logged, not gated");
  ok(armDGateResult(suppliedTrueWithWebAside) === "soft", "OPE-799: ARM D's composed gate also dispatches SOFT when the supplied line's own aside mentions web — a worker habit unrelated to the linear kind check");

  ok(armDGateResult(liveClean) === true, "OPE-799: ARM D's composed gate stays HARD and PASSES on a genuine live untainted read");

  ok(armDGateResult(liveLinearTainted) === false, "OPE-799 NEGATIVE CONTROL: a genuine live LINEAR-tainted line still fails ARM D's composed gate — dispatch stayed HARD, the assertion correctly evaluates false");
}

{
  const liveGithubTainted = "context: unattended: false · tainted: true (github)";

  const armBGateResult = (text: string, expectTaint: boolean): "soft" | boolean => {
    const decision = liveTaintGateDecision(taintContextLine(text));
    if (!decision.hard) return "soft";
    return expectTaint ? /tainted:\s*true/i.test(decision.line) && /\bgithub\b/i.test(decision.line) : !/\bgithub\b/i.test(decision.line);
  };

  ok(armBGateResult(liveClean, false) === true, "OPE-844: ARM B's composed gate PASSES a genuine live untainted read on a PRIVATE-repo fixture (relaxation, correct)");
  ok(armBGateResult(liveGithubTainted, true) === true, "OPE-844: ARM B's composed gate PASSES a genuine live github-tainted read on a PUBLIC-repo fixture (tainting, correct)");

  ok(armBGateResult(liveGithubTainted, false) === false, "OPE-844 REGRESSION CHECK: a PRIVATE-repo fixture that DOES mark github FAILS the gate — over-marking a trusted source is the exact defect the relaxation-only ruling forbids");
  ok(armBGateResult(liveClean, true) === false, "OPE-844 REGRESSION CHECK: a PUBLIC-repo fixture whose read stays clean FAILS the gate — this is precisely \"no leg proves the github route reaches the mark\", caught rather than silently passed");

  ok(armBGateResult(liveWebTainted, false) === true, "OPE-844: a live line naming \"web\" (not github) still passes the PRIVATE-repo (absent) direction — github specifically is what's asserted, not taintedness in general");

  ok(armBGateResult(suppliedTrueOverClean, true) === "soft", "OPE-844: a model-supplied (simulated) line dispatches SOFT on ARM B too — never gated as a plane defect");
}

{
  const armB = { arm: "ARM B (github)", what: "no `taint.verdict` row of kind `github` landed" };
  const armC = { arm: "ARM C (notion)", what: "the forge-replayed wake produced no `taint.verdict` row for kind `notion`" };

  const mixed = liveMeasurementVerdict(["ARM A (web, live context line)"], [armB, armC]);
  ok(mixed.cannotRun === undefined, "OPE-2031: one arm measured and two went silent ⇒ NOT cannot-run — the leg scores on the arm that has evidence, which is exactly the run boards #228 and #229 skipped");
  ok(mixed.logged.length === 2, "OPE-2031: both silent arms are still recorded — the honest record OPE-1877 demanded is not the thing that was wrong");
  ok(
    mixed.logged.some((l) => l.includes("ARM B (github)")) && mixed.logged.some((l) => l.includes("ARM C (notion)")),
    "OPE-2031: each silent arm is LOGGED BY NAME — a reader of the board can tell which route went unmeasured without opening the run log",
  );
  ok(
    mixed.logged.every((l) => l.includes("ARM A (web, live context line)")),
    "OPE-2031: the logged line names the arm(s) that DID measure, so the record says what the run rests on rather than only what it missed",
  );

  const none = liveMeasurementVerdict([], [armB, armC]);
  ok(typeof none.cannotRun === "string" && none.cannotRun.length > 0, "OPE-2031: NO arm measured ⇒ CANNOT RUN — a leg that measured nothing must not report a proof it did not make (OPE-1877, ships #216/#217)");
  ok(
    none.cannotRun!.includes("ARM B (github)") && none.cannotRun!.includes("ARM C (notion)"),
    "OPE-2031: the cannot-run reason names every silent arm, so the skip says WHICH routes went unmeasured",
  );
  ok(none.logged.length === 2, "OPE-2031: a cannot-run run still emits the per-arm log lines — the skip reason and the record are both written");

  const onlySilent = liveMeasurementVerdict([], [armB]);
  ok(typeof onlySilent.cannotRun === "string", "OPE-2031 NEGATIVE CONTROL: ONE arm ran, it measured nothing, and nothing else measured ⇒ still CANNOT RUN — the rule is about the absence of evidence, not about a count of silent arms");

  const allMeasured = liveMeasurementVerdict(["ARM A (web, live context line)", "ARM B (github) — the `taint.verdict` row"], []);
  ok(allMeasured.cannotRun === undefined && allMeasured.logged.length === 0, "OPE-2031: every arm measured ⇒ no skip and no silent-arm log line");

  const noneRan = liveMeasurementVerdict([], []);
  ok(noneRan.cannotRun === undefined && noneRan.logged.length === 0, "OPE-2031: no arm RAN at all ⇒ no cannot-run from this helper — an undrivable fixture is its own skip, not an unmeasured route");
}

{
  const renderedSupplied =
    "context: unattended: false · tainted: true — supplied by the caller, not this turn's own signal (this turn: true (web))";

  const mentionThenLine =
    "The worker fetched `<https://raw.githubusercontent.com/octocat/Hello-World/master/README>` successfully, then called `explain_permission` as requested. Exact `context:` line:\n`" +
    renderedSupplied +
    "`";
  const picked = taintContextLine(mentionThenLine);
  ok(
    picked.startsWith(renderedSupplied),
    `OPE-2059 (a): a prose mention before the quoted line returns the RENDERED line, not the mention — got ${JSON.stringify(picked)}`,
  );
  ok(liveTaintGateDecision(picked).hard === false, "OPE-2059 (a): the rendered supplied line dispatches SOFT (hard === false), so the board #233 false red cannot recur");

  const liveAlone = "context: unattended: false · tainted: true (web)";
  ok(taintContextLine(liveAlone) === liveAlone, "OPE-2059 (b): a rendered live line alone is returned unchanged");
  const liveDecision = liveTaintGateDecision(taintContextLine(liveAlone));
  ok(liveDecision.hard === true && liveDecision.line === liveAlone, "OPE-2059 (b) NEGATIVE CONTROL: the rendered live line still dispatches HARD (hard === true)");

  const sameLine = "Exact `context:` line: `" + liveAlone + "` — done.";
  const pickedSame = taintContextLine(sameLine);
  ok(
    pickedSame.startsWith(liveAlone),
    `OPE-2059 (c): a same-line prose mention yields the rendered part, starting at its own \`context:\` — got ${JSON.stringify(pickedSame)}`,
  );

  ok(taintContextLine("The worker fetched the page and called explain_permission.") === "", "OPE-2059 (d): no `context:` occurrence ⇒ empty string");

  ok(
    taintContextLine("see context: first mention\nand context: second mention") === "context: first mention",
    "OPE-2059: with no rendered shape anywhere, the first `context:` occurrence is still the answer",
  );
}

console.log(`✓ taint-context-line: ${passed} assertions — isLiveTaintLine discriminates a live explain_permission read from a model-supplied simulation, the old bare-regex gates are shown forgeable where the new ones refuse, OPE-789/OPE-799's liveTaintGateDecision demotes only the non-live path on ARM A and ARM D while a genuine live plane failure still dispatches HARD on either arm, OPE-844's ARM B direction gate is proven to catch both a private-repo over-mark and a public-repo under-mark, and OPE-2031's liveMeasurementVerdict reports CANNOT RUN only when NO arm measured while naming every silent arm either way`);
