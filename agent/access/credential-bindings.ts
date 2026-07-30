import { parseCredentialBindingsFile, type CredentialBindingsFile } from "@open-everywhere/core/agent/access/credential-bindings-codemod.js";
import bindingsOverlay from "./credential-bindings.generated.js";

const overlay: CredentialBindingsFile = parseCredentialBindingsFile(bindingsOverlay);

export function loadCredentialBindingsOverlay(): CredentialBindingsFile {
  return overlay;
}
