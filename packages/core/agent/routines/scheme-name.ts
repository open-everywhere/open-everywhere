export interface SchemeNamed {
  readonly source: string;
  readonly scheme?: string;
}

export interface WebhookIdentity {
  readonly name: string;
  readonly scheme: string;
}

export function webhookScheme(x: SchemeNamed): string {
  return x.scheme ?? x.source;
}

export function webhookName(x: SchemeNamed): string {
  return x.source;
}

export function webhookIdentity(x: SchemeNamed): WebhookIdentity {
  return { name: webhookName(x), scheme: webhookScheme(x) };
}

export function isSingleStringIdentity(x: SchemeNamed): boolean {
  const id = webhookIdentity(x);
  return id.name === id.scheme;
}
