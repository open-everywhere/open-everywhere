export const LINK_SET_REF_PREFIX = "linkSet:";

export function isLinkSetRef(value: string): boolean {
  return value.startsWith(LINK_SET_REF_PREFIX);
}

export function parseLinkSetRef(value: string): string | undefined {
  if (!value.startsWith(LINK_SET_REF_PREFIX)) return undefined;
  const id = value.slice(LINK_SET_REF_PREFIX.length);
  if (id.length === 0 || /[/\s]/u.test(id)) return undefined;
  return id;
}

export function isValidLinkSetRef(value: string): boolean {
  return parseLinkSetRef(value) !== undefined;
}
