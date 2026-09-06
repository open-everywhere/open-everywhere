const SKIPPABLE_PREFIXES = [
  ".claude/",
  "docs/",
];

function isRootMarkdown(path: string): boolean {
  return !path.includes("/") && path.toLowerCase().endsWith(".md");
}

export function isSkippablePath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return isRootMarkdown(normalized) || SKIPPABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isSkippableDiff(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isSkippablePath);
}

export function runtimePaths(paths: string[]): string[] {
  return paths.filter((path) => !isSkippablePath(path));
}

const UNSHIPPED_PREFIXES = [
  "scripts/",
];

export function shipsInDeployedFunction(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  if (isSkippablePath(normalized)) return false;
  return !UNSHIPPED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function deployedRuntimePaths(paths: string[]): string[] {
  return paths.filter(shipsInDeployedFunction);
}
