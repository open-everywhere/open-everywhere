import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const APP_ROOT_ENV = "OE_APP_ROOT";

export function findUpward(start: string, isRoot: (dir: string) => boolean): string | undefined {
  let dir = resolvePath(start);
  for (;;) {
    if (isRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isAppRoot(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "agent", "agent.ts"));
}

export interface AppRootInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export function resolveAppRoot(input: AppRootInput = {}): string {
  const env = input.env ?? process.env;
  const pinned = env[APP_ROOT_ENV];
  if (pinned !== undefined && pinned !== "") {
    if (!isAbsolute(pinned)) throw new Error(`${APP_ROOT_ENV}=${pinned} is not an absolute path. Set it to the absolute path of the app directory.`);
    if (!isAppRoot(pinned)) throw new Error(`${APP_ROOT_ENV}=${pinned} is not an Open Everywhere app: it needs package.json and agent/agent.ts.`);
    return pinned;
  }
  const start = walkStart(env, input.cwd ?? process.cwd());
  const found = findUpward(start, isAppRoot);
  if (found !== undefined) return found;
  throw new Error(
    `No Open Everywhere app found at or above ${start} (an app holds package.json and agent/agent.ts). Run from inside the app, or set ${APP_ROOT_ENV} to its absolute path.`,
  );
}

function walkStart(env: Readonly<Record<string, string | undefined>>, cwd: string): string {
  const initCwd = env.INIT_CWD;
  const packageJson = env.npm_package_json;
  if (initCwd === undefined || initCwd === "" || packageJson === undefined || packageJson === "") return cwd;
  return samePath(dirname(packageJson), cwd) ? initCwd : cwd;
}

function samePath(a: string, b: string): boolean {
  if (resolvePath(a) === resolvePath(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function appPath(relPath: string, root: string = resolveAppRoot()): string {
  return join(root, relPath);
}

export async function importAppModule<T>(relPath: string, root: string = resolveAppRoot()): Promise<T> {
  // hosted-inline-exempt: operator/test-time scripts load the deployer's app by path. This module
  return (await import(pathToFileURL(join(root, relPath)).href)) as T;
}
