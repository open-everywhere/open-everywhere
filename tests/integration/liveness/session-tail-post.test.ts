import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

import { bootAgent, disposeLater, discordMentionWake, DISCORD_LISTED_CHANNEL_ID, readAuditRows, registerScript, sleep, waitFor } from "../harness";

interface TailRow {
  readonly surface_key: string;
  readonly token: string;
  readonly entry_json: string;
}
interface TailEntry {
  readonly kind: string;
  readonly from: string;
  readonly text: string;
  readonly at: string;
  readonly container?: string;
}

function readTailRows(): readonly (TailRow & { readonly entry: TailEntry })[] {
  const path = process.env.OE_SQLITE_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("session-tail-post test: OE_SQLITE_PATH is unset — bootAgent({ sharedSqlite: true }) did not run.");
  }
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT surface_key, token, entry_json FROM session_tail ORDER BY seq ASC").all() as unknown as readonly TailRow[];
    return rows.map((r) => ({ ...r, entry: JSON.parse(r.entry_json) as TailEntry }));
  } finally {
    db.close();
  }
}

test("a standing seat's own reply reaches its generation's tail ring", async () => {
  await bootAgent({ sharedSqlite: true });
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  const marker = randomBytes(4).toString("hex");
  const question = `tail probe ${marker}`;
  const answer = `answered ${marker}`;
  disposeLater(registerScript({ parent: [{ say: answer }] }));

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: question, messageId: `it-tail-${marker}` });

  await waitFor(
    async () => (await readAuditRows({ actions: ["reply.post"], sinceIso })).find((r) => (r.detail as { chars?: unknown } | undefined)?.chars === answer.length),
    "a reply.post audit row for this turn's scripted say",
  );
  await sleep(2_000);

  const rows = readTailRows();
  const wakes = rows.filter((r) => r.entry.kind === "wake");
  const posts = rows.filter((r) => r.entry.kind === "post");

  expect(posts.length).toBe(1);
  expect(posts[0]!.entry.text).toBe(answer);
  expect(posts[0]!.entry.from).toBe("self");

  expect(wakes.length).toBeGreaterThan(0);
  const wake = wakes.find((r) => r.entry.text.includes(question));
  expect(wake).toBeDefined();
  expect(posts[0]!.token).toBe(wake!.token);
  expect(posts[0]!.surface_key).toBe(wake!.surface_key);

  expect(posts[0]!.entry.container).toBe(wake!.entry.container);
  expect(Date.parse(posts[0]!.entry.at)).toBeGreaterThanOrEqual(Date.parse(wake!.entry.at));

  expect(rows.filter((r) => r.entry.kind === "post" && r.entry.text === answer).length).toBe(1);
});
