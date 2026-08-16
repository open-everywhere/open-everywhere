const { taintContextLine, isLiveTaintLine } = await import("./e2e/taint-context-line.js");

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

console.log(`✓ taint-context-line: ${passed} assertions — isLiveTaintLine discriminates a live explain_permission read from a model-supplied simulation, and the old bare-regex gates are shown forgeable where the new ones refuse`);
