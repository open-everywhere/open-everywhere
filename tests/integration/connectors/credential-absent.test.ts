import { afterAll, expect, test } from "vitest";
import { bootAgent, NOTION_WORKSPACE_ID, notionCommentEventPost, readAuditRows, waitFor } from "../harness";

const CHANNEL_KEY_REF = "db:notion:channel-key";

const UNRESOLVED = "credential.unresolved";

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

test("an ABSENT db credential row: the delivery still acks 200, and the deployment names the ref it could not resolve", async () => {
  await bootAgent({ sharedSqlite: true });
  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const res = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: "it-ope-639-comment-1" });

  expect(res.status).toBe(200);

  const rows = await waitFor(
    async () => {
      const found = (await readAuditRows({ actions: [UNRESOLVED], sinceIso })).filter(
        (r) => (r.detail as { ref?: unknown } | undefined)?.ref === CHANNEL_KEY_REF,
      );
      return found.length > 0 ? found : undefined;
    },
    `a ${UNRESOLVED} row naming ${CHANNEL_KEY_REF}`,
    20_000,
  );

  const detail = rows[0]!.detail as { ref?: unknown; broker?: unknown; reason?: unknown };
  expect(detail.ref).toBe(CHANNEL_KEY_REF);
  expect(detail.broker).toBe("db");
  expect(detail.reason).toBe("no-stored-row");
  expect(rows[0]!.platform).toBe("credential");

  const serialised = JSON.stringify(rows[0]);
  expect(serialised).not.toMatch(/apiKey|plaintext|ciphertext|secret_/u);
});
