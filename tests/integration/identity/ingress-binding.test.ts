import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const SECOND_DISCORD_USER_ID = "300000000000000104";

const EVE_APP_PRINCIPAL = "eve:app";

function triggerElement(prompt: string): string {
  const open = prompt.lastIndexOf("<message ");
  if (open < 0) throw new Error(`no <message> element in the prompt the model received:\n${prompt.slice(0, 2000)}`);
  const close = prompt.indexOf("</message>", open);
  if (close < 0) throw new Error(`unterminated <message> element in the prompt:\n${prompt.slice(open, open + 2000)}`);
  return prompt.slice(open, close + "</message>".length);
}

function promptOf(req: RecordedRequest): string {
  return req.messages
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join("\n");
}

async function parentRequestFor(handle: ScriptedHandle, nonce: string, label: string): Promise<RecordedRequest> {
  return waitFor(() => handle.requests.find((r) => r.role === "parent" && promptOf(r).includes(nonce)), label);
}

test("a signed relay mention binds to its author's EXACT principal id, on the model's prompt AND in the audit trail", async () => {
  await bootAgent();
  const handle = disposeLater(registerScript({ parent: [{ say: `oe-bind-ok ${randomBytes(4).toString("hex")}` }] }));
  const nonce = randomBytes(4).toString("hex");
  const cursor = await auditCursor();

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${nonce} who am I to you`,
  });

  const trigger = triggerElement(promptOf(await parentRequestFor(handle, nonce, "the scripted model to see the wake")));

  expect(trigger).toContain('trigger="true"');
  expect(trigger).toContain(nonce);

  expect(trigger).toContain(`author-id="${DISCORD_USER_ID}"`);
  expect(trigger).not.toContain(`author-id="${SECOND_DISCORD_USER_ID}"`);

  expect(trigger).toContain('trust="principal"');
  expect(trigger).not.toContain('trust="unauth"');
  expect(trigger).toContain('from="human"');

  const row = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["egress.policy"])).find((r) => r.principalId !== undefined),
    "a session-start egress.policy row carrying a principal id",
  );
  expect(row.principalId).toBe(DISCORD_USER_ID);
  expect(row.platform).toBe("discord");
  expect(row.principalId).not.toBe(EVE_APP_PRINCIPAL);
  expect(row.principalId).not.toBe(SECOND_DISCORD_USER_ID);
  expect(row.principalId).not.toBe("");
});

test("a SECOND delivery from a DIFFERENT author re-derives identity — the first author's binding does not ride along", async () => {
  await bootAgent();
  const handle = disposeLater(registerScript({ parent: [{ say: `oe-bind2-ok ${randomBytes(4).toString("hex")}` }] }));
  const first = randomBytes(4).toString("hex");
  const second = randomBytes(4).toString("hex");

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${first} first speaker here`,
    userId: DISCORD_USER_ID,
  });
  const firstReq = await parentRequestFor(handle, first, "the model to see the FIRST author's wake");
  expect(triggerElement(promptOf(firstReq))).toContain(`author-id="${DISCORD_USER_ID}"`);

  await discordMentionWake({
    channelId: DISCORD_LISTED_CHANNEL_ID,
    text: `<@9000000000000000001> ${second} second speaker here`,
    userId: SECOND_DISCORD_USER_ID,
  });
  const secondReq = await parentRequestFor(handle, second, "the model to see the SECOND author's wake");
  const prompt = promptOf(secondReq);
  const trigger = triggerElement(prompt);

  expect(trigger).toContain(second);
  expect(prompt).toContain(first);

  expect(trigger).toContain(`author-id="${SECOND_DISCORD_USER_ID}"`);
  expect(trigger).not.toContain(`author-id="${DISCORD_USER_ID}"`);
  expect(trigger).toContain('trust="principal"');

  const beforeTrigger = prompt.slice(0, prompt.lastIndexOf("<message "));
  expect(beforeTrigger).toContain(`author-id="${DISCORD_USER_ID}"`);
  expect(beforeTrigger).not.toContain(`author-id="${SECOND_DISCORD_USER_ID}"`);

  expect(firstReq.fault).toBeUndefined();
  expect(secondReq.fault).toBeUndefined();
});

