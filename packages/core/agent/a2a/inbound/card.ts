import { A2A_PROTOCOL_VERSION, AgentCard, type AgentCard as AgentCardShape } from "@a2a-js/sdk";
import type { A2aInboundDeclaration } from "./declaration.js";

export const A2A_INBOUND_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_INBOUND_CARD_ROUTE = `${A2A_INBOUND_CARD_PATH}/`;
export const A2A_INBOUND_RPC_PATH = "/a2a/jsonrpc";

const JWT_SCHEME = "bearerJwt";
const SECRET_SCHEME = "bearerSecret";

export function buildInboundAgentCard(declaration: A2aInboundDeclaration, baseUrl: string): AgentCardShape {
  const usesJwt = declaration.callers.some((c) => c.auth.scheme === "jwt");
  const usesSecret = declaration.callers.some((c) => c.auth.scheme === "bearer");
  const securitySchemes: AgentCardShape["securitySchemes"] = {};
  if (usesJwt) {
    securitySchemes[JWT_SCHEME] = {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: { description: "An OAuth 2.0 access token (a JWT) from an issuer this deployment declared, for this deployment's audience.", scheme: "Bearer", bearerFormat: "JWT" },
      },
    };
  }
  if (usesSecret) {
    securitySchemes[SECRET_SCHEME] = {
      scheme: { $case: "httpAuthSecurityScheme", value: { description: "A bearer secret this deployment issued to the caller.", scheme: "Bearer", bearerFormat: "" } },
    };
  }
  const securityRequirements = Object.keys(securitySchemes).map((name) => ({ schemes: { [name]: { list: [] } } }));
  return {
    name: declaration.name,
    description: declaration.description,
    supportedInterfaces: [{ url: `${baseUrl}${A2A_INBOUND_RPC_PATH}`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: undefined,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: declaration.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: [],
      examples: [...(s.examples ?? [])],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      securityRequirements: [],
    })),
    documentationUrl: "",
    signatures: [],
  };
}

export function inboundAgentCardJson(declaration: A2aInboundDeclaration, baseUrl: string): unknown {
  return AgentCard.toJSON(buildInboundAgentCard(declaration, baseUrl));
}
