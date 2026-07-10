import assert from "node:assert/strict";
import { checkIpRateLimit, firstForwardedIp, __clearIpRateLimitForTest } from "../src/ip-limit.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(firstForwardedIp("1.2.3.4") === "1.2.3.4", "single IP header value");
  ok(firstForwardedIp("1.2.3.4, 5.6.7.8") === "1.2.3.4", "takes the FIRST hop of a comma-separated chain");
  ok(firstForwardedIp(["9.9.9.9", "1.1.1.1"]) === "9.9.9.9", "takes the first element when header is an array");
  ok(firstForwardedIp(undefined) === "unknown", "missing header falls back to the literal string 'unknown', never throws");
  ok(firstForwardedIp("") === "unknown", "empty header falls back to 'unknown'");
}

{
  __clearIpRateLimitForTest();
  const now = 1_800_000_000_000;
  const ip = "203.0.113.7";

  for (let i = 0; i < 60; i++) {
    ok(checkIpRateLimit(ip, now) === true, `request ${i + 1}/60 within the per-minute window is allowed`);
  }
  ok(checkIpRateLimit(ip, now) === false, "the 61st request in the same window is rejected");

  const nextWindow = now + 60_000;
  ok(checkIpRateLimit(ip, nextWindow) === true, "a new window resets the counter");

  __clearIpRateLimitForTest();
  ok(checkIpRateLimit("10.0.0.1", now) === true, "a fresh IP after a test reset is unaffected by prior state");
}

console.log(`ip-limit.test.ts: ${n} assertions passed`);
