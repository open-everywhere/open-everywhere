import type { HookEventType } from "eve/hooks";
import type { EVE_EVENT_NAMES } from "./eve-event-names.generated.js";

type Table = (typeof EVE_EVENT_NAMES)[number];

type NoDrift<T, Label extends string> = [T] extends [never] ? "in sync" : { readonly [K in Label]: T };

export const TABLE_NAMES_THE_INSTALLED_EVE_LACKS: NoDrift<Exclude<Table, HookEventType>, "removed_or_renamed_by_the_bump"> = "in sync";

export const INSTALLED_EVE_NAMES_THE_TABLE_LACKS: NoDrift<Exclude<HookEventType, Table>, "added_by_the_bump"> = "in sync";
