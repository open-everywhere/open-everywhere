import { randomBytes } from "node:crypto";
import { runtimeRoleGrantsSql } from "../operational/postgres.js";

export const RUNTIME_ROLE_NAME = "oe_runtime";

export const OWNER_URL_ENV = "OE_DB_OWNER_URL";

export function generateRuntimePassword(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function deriveRuntimeUrl(ownerUrl: string, role: string, password: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`deriveRuntimeUrl: "${role}" is not a plain lowercase identifier`);
  }
  let u: URL;
  try {
    u = new URL(ownerUrl);
  } catch {
    throw new Error("deriveRuntimeUrl: the owner DATABASE_URL is not a valid URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(`deriveRuntimeUrl: not a postgres URL (${u.protocol})`);
  }
  u.username = role;
  u.password = password;
  return u.toString();
}

export function twoRoleProvisioningSql(role: string, password: string): string[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`twoRoleProvisioningSql: "${role}" is not a plain lowercase identifier`);
  }
  const lit = password.replace(/'/g, "''");
  return [`CREATE ROLE ${role} LOGIN PASSWORD '${lit}'`, ...runtimeRoleGrantsSql(role)];
}
