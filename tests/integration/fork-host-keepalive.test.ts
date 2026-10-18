import { expect, test } from "vitest";

import { bootAgent } from "./harness";

test("a request after a stalled loop reuses the keep-alive socket without a reset (OPE-2586)", async () => {
  const { base } = await bootAgent();
  const first = await fetch(`${base}/eve/v1/health`);
  await first.text();
  await new Promise((r) => setTimeout(r, 50));
  const until = Date.now() + 6_500;
  while (Date.now() < until) {
  }
  const second = await fetch(`${base}/eve/v1/health`);
  await second.text();
  expect(second.status).toBe(first.status);
});
