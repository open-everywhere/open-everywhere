import { expect, test } from "vitest";
import { bootAgent } from "../harness";
import { installHostFetchStub } from "../fetch-stub";
import { DISCORD_COMMAND_GUILDS } from "../../../agent/commands/discord-commands.js";

const API_PREFIX = "https://discord.com/api/v10/";

const STUB_APPLICATION_ID = "1410000000000000002";
const STUB_BOT_TOKEN = "integration-stub-discord-bot-token";

process.env.DISCORD_APPLICATION_ID = STUB_APPLICATION_ID;
process.env.DISCORD_BOT_TOKEN = STUB_BOT_TOKEN;

interface CommandCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const calls: CommandCall[] = [];

installHostFetchStub(API_PREFIX, (url, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.href.slice(API_PREFIX.length);
  calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  if (!/^applications\/[^/]+\/guilds\/[^/]+\/commands$/.test(path)) return undefined;
  if (method === "GET") return Response.json([], { status: 200 });
  if (method === "POST") return Response.json({ id: "stub-command-1" }, { status: 201 });
  return undefined;
});

test("booting the deployment registers its own /oe command, with no operator step", async () => {
  await bootAgent();

  const guild = DISCORD_COMMAND_GUILDS[0];
  expect(guild, "the app declares at least one guild to register into").toBeTruthy();

  const commandCalls = calls.filter((c) => c.path.endsWith("/commands"));
  expect(
    commandCalls.map((c) => c.method),
    "🔴 boot issues the READ and then the WRITE — nothing here happens without all three wirings intact",
  ).toEqual(["GET", "POST"]);

  for (const call of commandCalls) {
    expect(call.path, "…addressed to the application and guild the deployment declares").toBe(
      `applications/${STUB_APPLICATION_ID}/guilds/${guild}/commands`,
    );
  }

  const write = commandCalls[1];
  expect(write?.method, "the write creates-or-updates ONE command and touches no other").toBe("POST");

  const body = write?.body as { name?: string; options?: { name?: string }[] } | undefined;
  expect(body?.name, "the body is the declared /oe command").toBe("oe");
  expect(
    body?.options?.map((o) => o.name),
    "🔴 …carrying `rate` — the subcommand that shipped invisible because only an operator CLI could register it",
  ).toContain("rate");
});
