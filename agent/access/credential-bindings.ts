import { parseCredentialBindingsFile, type CredentialBindingsFile } from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";
import bindingsJson from "./credential-bindings.json" with { type: "json" };

const overlay: CredentialBindingsFile = parseCredentialBindingsFile(bindingsJson);

export function loadCredentialBindingsOverlay(): CredentialBindingsFile {
  return overlay;
}
