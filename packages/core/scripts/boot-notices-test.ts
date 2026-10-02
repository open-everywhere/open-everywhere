import assert from "node:assert/strict";
import { registerBootNotice, registeredBootNoticeNames, resetBootNotices, runBootNotices } from "../agent/boot/notices.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

console.log("boot notices:");

{
  resetBootNotices();
  ok(registeredBootNoticeNames().length === 0, "a reset registry is empty");

  registerBootNotice("a", async () => undefined);
  registerBootNotice("b", async () => undefined);
  ok(registeredBootNoticeNames().join(",") === "a,b", "notices are listed in registration order");

  let which = "";
  registerBootNotice("a", async () => void (which = "second"));
  ok(registeredBootNoticeNames().join(",") === "a,b", "re-registering a name does not add a second entry");
  await runBootNotices();
  ok(which === "second", "the LAST registration under a name is the one that runs");
}

{
  resetBootNotices();
  const order: string[] = [];
  registerBootNotice("first", async () => void order.push("first"));
  registerBootNotice("second", async () => void order.push("second"));
  registerBootNotice("third", async () => void order.push("third"));
  await runBootNotices();
  ok(order.join(",") === "first,second,third", "every notice runs, in registration order");

  resetBootNotices();
  const log: string[] = [];
  registerBootNotice("slow", async () => {
    log.push("slow:start");
    await new Promise((r) => setTimeout(r, 10));
    log.push("slow:end");
  });
  registerBootNotice("fast", async () => void log.push("fast"));
  await runBootNotices();
  ok(log.join(",") === "slow:start,slow:end,fast", "🔴 notices run SEQUENTIALLY — a slow one finishes before the next starts");
}

{
  resetBootNotices();
  const ran: string[] = [];
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  try {
    registerBootNotice("before", async () => void ran.push("before"));
    registerBootNotice("boom", async () => {
      throw new Error("the store is unreachable");
    });
    registerBootNotice("after", async () => void ran.push("after"));

    await runBootNotices();
    console.warn = realWarn;

    ok(ran.join(",") === "before,after", "🔴 a throwing notice does not stop the ones after it");
    ok(warnings.length === 1, "the failure is reported once");
    ok(warnings[0]?.includes("boom") === true, "the report NAMES the notice that failed");
    ok(warnings[0]?.includes("the store is unreachable") === true, "…and carries the reason");
  } finally {
    console.warn = realWarn;
  }
}

{
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  try {
    resetBootNotices();
    ok(registeredBootNoticeNames().length === 0, "a reset registry holds no notices");
    await runBootNotices();
    console.warn = realWarn;
    ok(warnings.length === 0, "running an empty registry warns about nothing");

    warnings.length = 0;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
    let ranAfter = false;
    registerBootNotice("void", (() => undefined) as unknown as () => Promise<void>);
    registerBootNotice("after-void", async () => void (ranAfter = true));
    await runBootNotices();
    console.warn = realWarn;
    ok(warnings.length === 0, "a notice returning no promise warns about nothing");
    ok(ranAfter, "…and the notice after it still runs");
  } finally {
    console.warn = realWarn;
    resetBootNotices();
  }
}

console.log(`✓ boot notices: ${n} assertions`);
