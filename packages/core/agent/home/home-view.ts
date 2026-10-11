import type { Domain } from "../memory/domain.js";
import type { Partition } from "../memory/partition.js";

export interface HomeRoom {
  readonly surfaceKey: string;
  readonly nativeId: string;
}

export interface HomeDomainMembership {
  readonly domain: Domain;
  readonly rooms: readonly HomeRoom[];
}

export interface HomeViewer {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly principalId: string;
  readonly personal?: Partition;
  readonly trust: "internal" | "external";
  readonly domains: readonly HomeDomainMembership[];
}

export interface HomeItemAction {
  readonly id: string;
  readonly label: string;
  readonly kind: "edit" | "confirm";
  readonly confirm?: { readonly title: string; readonly yes: string; readonly note?: string };
}

export interface HomeButton {
  readonly id: string;
  readonly label: string;
}

export type HomeBlock =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "item"; readonly text: string; readonly label?: string; readonly ref?: string; readonly actions: readonly HomeItemAction[] }
  | { readonly kind: "buttons"; readonly buttons: readonly HomeButton[] }
  | { readonly kind: "room"; readonly text: string; readonly room: HomeRoom }
  | { readonly kind: "divider" };

export interface HomeSection {
  readonly id: string;
  readonly order: number;
  build(viewer: HomeViewer): Promise<readonly HomeBlock[]>;
}

export interface HomeActionResult {
  readonly notice: string;
  readonly file?: { readonly filename: string; readonly title: string; readonly content: string };
}

export type HomeActionHandler = (viewer: HomeViewer, ref: string | undefined, input: string | undefined) => Promise<HomeActionResult>;

export const SLACK_HOME_WIRE = { actionPrefix: "oe_home:", modalCallbackId: "oe_home_action" } as const;

const sections = new Map<string, HomeSection>();
const actions = new Map<string, HomeActionHandler>();

export function registerHomeSection(section: HomeSection): void {
  sections.set(section.id, section);
}

export function registerHomeAction(id: string, handler: HomeActionHandler): void {
  actions.set(id, handler);
}

export function homeSections(): readonly HomeSection[] {
  return [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function hasHomeAction(id: string): boolean {
  return actions.has(id);
}

export async function buildHomeView(viewer: HomeViewer): Promise<readonly { readonly id: string; readonly blocks: readonly HomeBlock[] }[]> {
  const out: { id: string; blocks: readonly HomeBlock[] }[] = [];
  for (const section of homeSections()) {
    try {
      out.push({ id: section.id, blocks: await section.build(viewer) });
    } catch (err) {
      console.log(`[open-everywhere:home] section "${section.id}" failed to build: ${String(err)}`);
      out.push({ id: section.id, blocks: [{ kind: "note", text: "This part of the page could not load just now. It is not empty — try opening the page again." }] });
    }
  }
  return out;
}

export async function runHomeAction(viewer: HomeViewer, id: string, ref?: string, input?: string): Promise<HomeActionResult> {
  const handler = actions.get(id);
  if (!handler) return { notice: "That action is not available any more. Open the page again." };
  try {
    return await handler(viewer, ref, input);
  } catch (err) {
    console.log(`[open-everywhere:home] action "${id}" failed: ${String(err)}`);
    return { notice: "That did not work just now, and nothing changed. Try again." };
  }
}

export function homeDomainsFor(trust: "internal" | "external", memberships: readonly HomeDomainMembership[]): readonly HomeDomainMembership[] {
  if (trust !== "internal") return [];
  return memberships.filter((m) => m.domain.memory !== undefined && m.rooms.length > 0);
}

export function _resetHomeRegistry(): void {
  sections.clear();
  actions.clear();
}
