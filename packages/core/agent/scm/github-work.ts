import { resolveAccessFor } from "../access/request.js";
import { hasGithubWorkGrant } from "../access/work-grant.js";
import type { BindableContext } from "../identity/binding.js";

export function githubWorkMount(ctx: BindableContext): boolean {
  try {
    return hasGithubWorkGrant(resolveAccessFor(ctx).repos);
  } catch {
    return true;
  }
}
