import { declarationForPermissionKind } from "../approvals/session-grant.js";

const TOOL_DECLARATION_PREFIX = "tool:";

export interface ProjectedConnectorOp {
  readonly connection: string;
  readonly description: string;
  readonly qualifiedName: string;
  readonly tool: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface ConnectionOperation {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface ConnectionCatalogue {
  readonly connection: string;
  readonly ops: readonly ConnectionOperation[];
}

export interface DeclaredOpProjection {
  readonly mount: readonly ProjectedConnectorOp[];
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

export function projectDeclaredConnectorOps(input: {
  readonly declared: readonly string[];
  readonly catalogues: readonly ConnectionCatalogue[];
  readonly alreadyProjected?: readonly string[];
}): DeclaredOpProjection {
  const already = new Set(input.alreadyProjected ?? []);
  const mount: ProjectedConnectorOp[] = [];
  const unresolved: string[] = [];
  for (const qualifiedName of input.declared) {
    if (already.has(qualifiedName)) continue;
    const matches: ProjectedConnectorOp[] = [];
    for (const catalogue of input.catalogues) {
      for (const op of catalogue.ops) {
        if (`${catalogue.connection}__${op.name}` !== qualifiedName) continue;
        matches.push({
          connection: catalogue.connection,
          description: op.description,
          qualifiedName,
          tool: op.name,
          ...(op.inputSchema !== undefined ? { inputSchema: op.inputSchema } : {}),
          ...(op.outputSchema !== undefined ? { outputSchema: op.outputSchema } : {}),
        });
      }
    }
    if (matches.length === 1) mount.push(matches[0]!);
    else unresolved.push(qualifiedName);
  }
  return { mount, unresolved };
}

export function candidateConnectionsForDeclarations(declared: readonly string[], connections: readonly string[]): string[] {
  const out: string[] = [];
  for (const connection of connections) {
    if (connection.length === 0 || out.includes(connection)) continue;
    if (declared.some((name) => name.startsWith(`${connection}__`))) out.push(connection);
  }
  return out;
}

export const ROUTINE_DECLARED_OPS_MOUNTED_ACTION = "routine.declared_ops_mounted";
