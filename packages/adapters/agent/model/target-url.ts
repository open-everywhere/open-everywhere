import type { ModelTarget } from "@open-everywhere/core/agent/adapter-api.js";

export function targetBaseUrl(_name: string, t: ModelTarget): string | undefined {
  return t.url;
}
