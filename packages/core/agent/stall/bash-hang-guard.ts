import type { ToolContext, ToolDefinition } from "eve/tools";
import { auditToolAction } from "../audit/tool-action.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { SETTINGS, getSettings } from "../settings/settings.js";

export const DEFAULT_BASH_TIMEOUT_MS: number = SETTINGS.bash.timeoutMs.shipped;

export function bashTimeoutMs(): number {
  return getSettings().bash.timeoutMs;
}

export function backgroundGuardEnabled(): boolean {
  return getSettings().bash.backgroundGuard;
}

interface CommandScan {
  readonly background: readonly string[];
  readonly unquoted: string;
  readonly hasHeredoc: boolean;
}

export function scanCommand(command: string): CommandScan {
  const background: string[] = [];
  let unquoted = "";
  let seg = "";
  let quote: '"' | "'" | null = null;
  let hasHeredoc = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    unquoted += c;
    if (c === "<" && command[i + 1] === "<") {
      hasHeredoc = true;
      break;
    }
    if (c === "&") {
      if (command[i + 1] === "&") {
        unquoted += "&";
        i++;
        seg = "";
        continue;
      }
      if (command[i - 1] === ">" || command[i + 1] === ">") {
        seg += c;
        continue;
      }
      background.push(seg);
      seg = "";
      continue;
    }
    if (c === ";" || c === "\n" || c === "|") {
      if (c === "|" && command[i + 1] === "|") {
        unquoted += "|";
        i++;
      }
      seg = "";
      continue;
    }
    seg += c;
  }

  return { background, unquoted, hasHeredoc };
}

export function redirectsBothStreams(segment: string): boolean {
  if (/&>{1,2}/.test(segment)) return true;
  const stdout = /(?:^|[^0-9<>&])1?>{1,2}/.test(segment);
  const stderr = /(?:^|[^0-9<>&])2>{1,2}/.test(segment);
  return stdout && stderr;
}

export function backgroundsWithoutRedirect(command: string): boolean {
  const { background, unquoted, hasHeredoc } = scanCommand(command);
  if (hasHeredoc) return false;
  if (background.length === 0) return false;
  if (/\bwait\b/.test(unquoted)) return false;
  return background.some((seg) => seg.trim() !== "" && !redirectsBothStreams(seg));
}

export function unredirectedBackgroundMessage(): string {
  return (
    "`bash` did NOT run this command. It backgrounds a process with `&` but redirects neither " +
    "stdout nor stderr, so the backgrounded process keeps the workspace's output stream open and " +
    "this call would hang until it is cut off, rather than returning. Re-run it with BOTH streams redirected — " +
    "`<command> > /tmp/out.log 2>&1 &` (or `> /dev/null 2>&1 &` if you don't need the output) — " +
    "then poll the log or the port to check it came up."
  );
}

export function bashTimeoutMessage(ms: number): string {
  return (
    `\`bash\` gave up waiting after ${Math.round(ms / 1000)}s — the command's output stream never ` +
    "closed, so this call could not return. Most likely cause: did you background a process without " +
    "redirecting stdout/stderr? A background job MUST redirect both (`<command> > /tmp/out.log " +
    "2>&1 &`) or this call can never return. The command may still be running in the workspace — " +
    "check the log or the port with a short command rather than re-running it."
  );
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(bashTimeoutMessage(ms))), ms);
    timer.unref?.();
  });
  promise.catch(() => {
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function withBashHangGuard(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(input: unknown, ctx: ToolContext) {
      const command = typeof (input as { command?: unknown } | undefined)?.command === "string" ? ((input as { command: string }).command) : "";

      if (backgroundGuardEnabled() && backgroundsWithoutRedirect(command)) {
        emitTelemetry("oe.feature.used", { "oe.feature": "bash_hang_guard", "oe.outcome": "failed" });
        await auditToolAction(ctx, "bash.background_unredirected", { tool: "bash" });
        console.warn("[open-everywhere:bash-hang-guard] refused a backgrounded command with no output redirection");
        throw new Error(unredirectedBackgroundMessage());
      }

      const ms = bashTimeoutMs();
      if (ms <= 0) return tool.execute(input, ctx);
      try {
        return await raceTimeout(Promise.resolve(tool.execute(input, ctx)), ms);
      } catch (err) {
        if (err instanceof Error && err.message === bashTimeoutMessage(ms)) {
          emitTelemetry("oe.feature.used", { "oe.feature": "bash_hang_guard", "oe.outcome": "unverified" });
          await auditToolAction(ctx, "bash.timeout", { tool: "bash", timeoutMs: ms });
          console.warn(`[open-everywhere:bash-hang-guard] bash timed out after ${ms}ms`);
        }
        throw err;
      }
    },
  };
}
