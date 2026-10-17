declare const scrubbedAuditTextBrand: unique symbol;

export type ScrubbedAuditText = string & { readonly [scrubbedAuditTextBrand]: true };

export type AuditTextField = ScrubbedAuditText | number | boolean | null | undefined;

export interface AuditDetail {
  readonly [key: string]: unknown;
  readonly [key: `error${string}`]: AuditTextField;
  readonly [key: `${string}Error${string}`]: AuditTextField;
  readonly err?: AuditTextField;
}

export type AuditDetailBuilder = { -readonly [K in keyof AuditDetail]: AuditDetail[K] };

export type StoredAuditDetail = Readonly<Record<string, unknown>>;
