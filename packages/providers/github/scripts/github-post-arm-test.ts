
import assert from "node:assert/strict";
import type { UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";
import { githubPostArm } from "../agent/channels/github-post-arm.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const GH_ORIGIN: UnifiedWakeOrigin = { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55 };

ok(githubPostArm.platform === "github", "arm is tagged platform=github");
ok(githubPostArm.describeRedriveTarget!(GH_ORIGIN) === "github acme/payments-api#55", "redrive target description: github owner/repo#issue (token-free)");
ok(githubPostArm.redriveContainerId!(GH_ORIGIN) === "acme/payments-api", "redrive container id: owner/repo");

{
  const seen: { origin: unknown; text: string }[] = [];
  const deps = { postGitHub: async (origin: UnifiedWakeOrigin, text: string) => { seen.push({ origin, text }); return "id-99"; } } as unknown as Parameters<NonNullable<typeof githubPostArm.dispatchUnified>>[2];
  const id = await githubPostArm.dispatchUnified!(GH_ORIGIN, "hello from the unified window", deps);
  ok(id === "id-99", "dispatchUnified returns the poster's comment id");
  ok(seen.length === 1 && seen[0]!.text === "hello from the unified window", "dispatchUnified routes the text through the injected poster (deps.postGitHub)");
  assert.deepStrictEqual(seen[0]!.origin, GH_ORIGIN, "dispatchUnified passes the github origin through unchanged");
}

console.log(`✓ github-post-arm: ${passed} assertions passed`);
