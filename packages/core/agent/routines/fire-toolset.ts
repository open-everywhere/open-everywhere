import { declarationForPermissionKind } from "../approvals/session-grant.js";
import { readConnectionExecuteTarget } from "../access/connection-execute-target.js";

const TOOL_DECLARATION_PREFIX = "tool:";

export interface DeclaredConnectorOp {
  readonly connection: string;
  readonly tool: string;
  readonly qualifiedName: string;
}

export interface ConnectionOperation {
  readonly name: string;
}

export interface ConnectionCatalogue {
  readonly connection: string;
  readonly ops: readonly ConnectionOperation[];
}

export interface DeclaredOpResolution {
  readonly resolved: readonly DeclaredConnectorOp[];
  readonly unresolved: readonly string[];
}

export function declaredConnectorToolNames(kinds: readonly string[]): string[] {
  const out: string[] = [];
  for (const kind of kinds) {
    const declaration = declarationForPermissionKind(kind);
    if (declaration === undefined || !declaration.startsWith(TOOL_DECLARATION_PREFIX)) continue;
    const tool = declaration.slice(TOOL_DECLARATION_PREFIX.length);
    if (tool.length > 0 && !out.includes(tool)) out.push(tool);
  }
  return out;
}

export function resolveDeclaredConnectorOps(input: {
  readonly declared: readonly string[];
  readonly catalogues: readonly ConnectionCatalogue[];
  readonly alreadyResolved?: readonly string[];
}): DeclaredOpResolution {
  const already = new Set(input.alreadyResolved ?? []);
  const resolved: DeclaredConnectorOp[] = [];
  const unresolved: string[] = [];
  for (const qualifiedName of input.declared) {
    if (already.has(qualifiedName)) continue;
    const matches: DeclaredConnectorOp[] = [];
    for (const catalogue of input.catalogues) {
      for (const op of catalogue.ops) {
        if (`${catalogue.connection}__${op.name}` !== qualifiedName) continue;
        matches.push({ connection: catalogue.connection, tool: op.name, qualifiedName });
      }
    }
    const only = matches.length === 1 ? matches[0]! : undefined;
    if (only !== undefined && readConnectionExecuteTarget({ connection: only.connection, tool: only.tool }) !== undefined) resolved.push(only);
    else unresolved.push(qualifiedName);
  }
  return { resolved, unresolved };
}

export function candidateConnectionsForDeclarations(declared: readonly string[], connections: readonly string[]): string[] {
  const out: string[] = [];
  for (const connection of connections) {
    if (connection.length === 0 || out.includes(connection)) continue;
    if (declared.some((name) => name.startsWith(`${connection}__`))) out.push(connection);
  }
  return out;
}

export const ROUTINE_DECLARED_OPS_RESOLVED_ACTION = "routine.declared_ops_resolved";
