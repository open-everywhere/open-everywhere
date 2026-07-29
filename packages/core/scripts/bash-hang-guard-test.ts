import assert from "node:assert/strict";
import type { ToolContext, ToolDefinition } from "eve/tools";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  bashTimeoutMs,
  backgroundGuardEnabled,
  scanCommand,
  redirectsBothStreams,
  backgroundsWithoutRedirect,
  unredirectedBackgroundMessage,
  bashTimeoutMessage,
  withBashHangGuard,
} from "../agent/stall/bash-hang-guard.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const fakeCtx = {} as ToolContext;

function fakeBash(opts: { delayMs?: number; hang?: boolean } = {}): { tool: ToolDefinition; ran: string[] } {
  const ran: string[] = [];
  const tool = {
    description: "fake bash",
    inputSchema: {},
    outputSchema: {},
    async execute(input: unknown) {
      ran.push((input as { command: string }).command);
      if (opts.hang) await new Promise(() => {});
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { exitCode: 0, stdout: "hi", stderr: "", truncated: false };
    },
  } as unknown as ToolDefinition;
  return { tool, ran };
}

async function refusal(tool: ToolDefinition, command: string): Promise<string | null> {
  try {
    await tool.execute({ command }, fakeCtx);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

{
  delete process.env.OE_BASH_TIMEOUT_MS;
  ok(bashTimeoutMs() === DEFAULT_BASH_TIMEOUT_MS && DEFAULT_BASH_TIMEOUT_MS === 600_000, "config: default timeout is 600s");
  ok(
    DEFAULT_BASH_TIMEOUT_MS > 400_000,
    "config: the default clears the ~400s foreground command measured returning cleanly in prod (OPE-132)",
  );
  process.env.OE_BASH_TIMEOUT_MS = "90000";
  ok(bashTimeoutMs() === 90_000, "config: OE_BASH_TIMEOUT_MS overrides the default");
  process.env.OE_BASH_TIMEOUT_MS = "0";
  ok(bashTimeoutMs() === 0, "config: 0 disables the timeout");
  process.env.OE_BASH_TIMEOUT_MS = "off";
  ok(bashTimeoutMs() === 0, "config: off disables the timeout");
  process.env.OE_BASH_TIMEOUT_MS = "garbage";
  ok(bashTimeoutMs() === DEFAULT_BASH_TIMEOUT_MS, "config: unparseable falls back to the default (fail-safe on)");
  delete process.env.OE_BASH_TIMEOUT_MS;

  delete process.env.OE_BASH_BACKGROUND_GUARD;
  ok(backgroundGuardEnabled(), "config: the background guard is armed by default");
  process.env.OE_BASH_BACKGROUND_GUARD = "off";
  ok(!backgroundGuardEnabled(), "config: OE_BASH_BACKGROUND_GUARD=off disarms the detector");
  delete process.env.OE_BASH_BACKGROUND_GUARD;
}

{
  ok(backgroundsWithoutRedirect("python3 -m http.server 8000 &"), "broken: `python3 -m http.server 8000 &` (bare background)");
  ok(
    backgroundsWithoutRedirect(`nohup node -e 'require("http").createServer((_,r)=>r.end("<h1>OK</h1>")).listen(8000)' &`),
    "broken: nohup + node -e with NO redirect (nohup is irrelevant — the redirect is the whole thing)",
  );
  ok(
    backgroundsWithoutRedirect(`node -e 'require("http").createServer((_,r)=>r.end("x")).listen(8000)' &\nsleep 1 && curl -s localhost:8000`),
    "broken: backgrounded server on the first line, then a foreground poll (the `&` is mid-command, not at the end)",
  );
}

{
  ok(
    !backgroundsWithoutRedirect("nohup python3 -m http.server 8000 > /dev/null 2>&1 &"),
    "correct: `> /dev/null 2>&1 &` is not flagged (the live 1.4s counter-example)",
  );
  ok(!backgroundsWithoutRedirect("npm run dev > /tmp/dev.log 2>&1 &"), "correct: redirect to a log file is not flagged");
  ok(!backgroundsWithoutRedirect("npm run dev &> /tmp/dev.log &"), "correct: the combined `&>` redirect is not flagged");
  ok(!backgroundsWithoutRedirect("npm run dev >> /tmp/dev.log 2>> /tmp/dev.log &"), "correct: appending redirects are not flagged");
  ok(!backgroundsWithoutRedirect("npm run dev 1> /tmp/o.log 2> /tmp/e.log &"), "correct: explicit 1>/2> to separate files is not flagged");
  ok(backgroundsWithoutRedirect("npm run dev > /tmp/dev.log &"), "broken: stdout redirected but stderr still on the pipe");
}

{
  ok(!backgroundsWithoutRedirect("npm ci && npm run build"), "not background: `&&` is a sequencer");
  ok(!backgroundsWithoutRedirect("npm test 2>&1 | tail -20"), "not background: `2>&1` is redirection, not a background `&`");
  ok(!backgroundsWithoutRedirect("echo hello"), "not background: a plain command");
  ok(!backgroundsWithoutRedirect(`echo "a & b"`), "not background: `&` inside double quotes is literal text");
  ok(!backgroundsWithoutRedirect(`node -e 'const x = a && b; console.log(x)'`), "not background: `&&` inside a single-quoted -e script");
  ok(!backgroundsWithoutRedirect("grep -r 'foo' . || true"), "not background: `||`");
  ok(!backgroundsWithoutRedirect("printf 'a\\&b'"), "not background: a backslash-escaped `&` is literal");

  const scan = scanCommand(`node -e 'x & y' > /dev/null 2>&1 & echo done`);
  ok(scan.background.length === 1, "scanner: exactly one backgrounded segment (the quoted `&` is not one)");
  ok(redirectsBothStreams(scan.background[0]!), "scanner: the backgrounded segment is seen as fully redirected");
  ok(!redirectsBothStreams("nohup node server.js"), "scanner: an unredirected segment is seen as unredirected");
  ok(!redirectsBothStreams("node server.js 2>&1"), "scanner: `2>&1` alone is NOT a stdout redirect (the classic mis-parse)");
}

{
  ok(!backgroundsWithoutRedirect("sleep 30 & wait"), "fail-open: a command that `wait`s reaps the child, so its streams do close");
  ok(!backgroundsWithoutRedirect("cat <<EOF > f.txt\nfoo &\nEOF"), "fail-open: a heredoc body is not parseable by this scanner");
}

{
  const { tool, ran } = fakeBash();
  const wrapped = withBashHangGuard(tool);
  const msg = await refusal(wrapped, "python3 -m http.server 8000 &");
  ok(msg !== null, "wrapper: a bare-background command is refused (throws a recoverable tool error)");
  ok(ran.length === 0, "wrapper: the refused command was NOT run — no semantics were changed, nothing was rewritten");
  ok(msg === unredirectedBackgroundMessage(), "wrapper: the refusal is the authored diagnostic");
  ok(/> \/tmp\/out\.log 2>&1 &/.test(msg!), "wrapper: the refusal hands back the CORRECTED form, not just a complaint");
  ok(/hang/i.test(msg!) && /stdout/.test(msg!) && /stderr/.test(msg!), "wrapper: the refusal names the cause (hang + both streams)");
}

{
  const { tool, ran } = fakeBash();
  const wrapped = withBashHangGuard(tool);
  const out = (await wrapped.execute({ command: "npm run dev > /tmp/dev.log 2>&1 &" }, fakeCtx)) as { exitCode: number; stdout: string };
  ok(ran.length === 1 && ran[0] === "npm run dev > /tmp/dev.log 2>&1 &", "wrapper: the correct form runs VERBATIM (no rewrite)");
  ok(out.exitCode === 0 && out.stdout === "hi", "wrapper: the tool's own result is passed through untouched");
}

{
  process.env.OE_BASH_TIMEOUT_MS = "1000";
  const { tool } = fakeBash({ hang: true });
  const wrapped = withBashHangGuard(tool);
  const keepAlive = setInterval(() => {}, 50);
  const msg = await refusal(wrapped, "./scripts/start-daemon.sh");
  clearInterval(keepAlive);
  ok(msg !== null, "timeout: a command that never returns fails BOUNDED instead of stalling");
  ok(msg === bashTimeoutMessage(1000), "timeout: the failure is the authored diagnostic");
  ok(/gave up waiting after 1s/.test(msg!), "timeout: the diagnostic states how long it waited");
  ok(/output stream never closed/.test(msg!), "timeout: the diagnostic states WHAT it observed (the stream never closed — NOT that output was flowing; the measured hang shape emits zero bytes)");
  ok(
    /background a process without redirecting stdout\/stderr/.test(msg!),
    "timeout: the diagnostic NAMES the likely cause (an unredirected background process)",
  );
  ok(/> \/tmp\/out\.log 2>&1 &/.test(msg!), "timeout: the diagnostic hands back the corrected form");
  ok(/still be running in the workspace/.test(msg!), "timeout: the diagnostic says the command may still be alive — don't just re-run it");
  delete process.env.OE_BASH_TIMEOUT_MS;
}

{
  process.env.OE_BASH_TIMEOUT_MS = "5000";
  const { tool } = fakeBash({ delayMs: 5 });
  const wrapped = withBashHangGuard(tool);
  const out = (await wrapped.execute({ command: "echo hi" }, fakeCtx)) as { exitCode: number };
  ok(out.exitCode === 0, "timeout: a command that finishes in time is unaffected");
  delete process.env.OE_BASH_TIMEOUT_MS;
}

{
  process.env.OE_BASH_BACKGROUND_GUARD = "off";
  const { tool, ran } = fakeBash();
  const wrapped = withBashHangGuard(tool);
  await wrapped.execute({ command: "python3 -m http.server 8000 &" }, fakeCtx);
  ok(ran.length === 1, "disable: OE_BASH_BACKGROUND_GUARD=off lets the broken form through (the escape hatch works)");
  delete process.env.OE_BASH_BACKGROUND_GUARD;

  process.env.OE_BASH_TIMEOUT_MS = "0";
  const slow = fakeBash({ delayMs: 30 });
  const wrapped2 = withBashHangGuard(slow.tool);
  const out = (await wrapped2.execute({ command: "sleep 0.03" }, fakeCtx)) as { exitCode: number };
  ok(out.exitCode === 0 && slow.ran.length === 1, "disable: OE_BASH_TIMEOUT_MS=0 removes the timeout race entirely");
  delete process.env.OE_BASH_TIMEOUT_MS;
}

console.log(`✓ bash-hang-guard: ${n} assertions passed`);
