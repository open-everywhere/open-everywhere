import { EventEmitter } from "node:events";
import { attachPoolErrorHandler } from "../agent/postgres/neon.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

class FakePool extends EventEmitter {}

const pool = new FakePool();
ok(pool.listenerCount("error") === 0, "sanity: no error listener before the fix runs");

attachPoolErrorHandler(pool);
ok(pool.listenerCount("error") >= 1, "attachPoolErrorHandler() registers an 'error' listener");

let threw = false;
try {
  pool.emit("error", new Error("idle connection teardown (simulated)"));
} catch {
  threw = true;
}
ok(!threw, "emitting 'error' after attachPoolErrorHandler() does not throw");

attachPoolErrorHandler({});
ok(true, "attachPoolErrorHandler() tolerates a pool with no .on()");

console.log(`✓ neon-pool-error: ${passed} assertions passed`);
