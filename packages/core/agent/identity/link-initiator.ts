import { BINDING_TRUSTED_PLATFORMS } from "../memory/domain.js";
import type { Trust } from "./binding.js";

export function linkInitiatorRefusal(binding: { readonly platform: string; readonly trust: Trust }, act: string): string | undefined {
  if (binding.trust === "internal") return undefined;
  if (!BINDING_TRUSTED_PLATFORMS.has(binding.platform)) return undefined;
  return (
    `I can't ${act} from here — I can't confirm you're inside this organisation. ` +
    `Linking accounts gives one person's identity reach across every surface I can see, so I only ` +
    `do it for confirmed members. If you are one, ask an admin why this surface reads as external.`
  );
}
