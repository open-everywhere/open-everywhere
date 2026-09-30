import {
  assertBindingsValid,
  assertBundlesValid,
  defineBinding,
  defineBundle,
  type Binding,
  type Bundle,
} from "@open-everywhere/core/agent/access/bundle.js";
import { loadGrantsOverlay } from "./grants.js";
import { loadAgentsOverlay } from "../memory/config/agents-overlay.js";
import { loadGroups } from "../identity/groups.js";

const bundles: Bundle[] = [
  defineBundle({
    name: "org-default",
    domains: ["raw.githubusercontent.com"],
    instructions: "Never act outside the access granted to this room.",
  }),
];

const bindings: Binding[] = [
  defineBinding({ bundle: "org-default", scope: { level: "org" } }),
];

const overlay = loadGrantsOverlay();
const agentsOverlay = loadAgentsOverlay();
const mergedBundles: readonly Bundle[] = [...bundles, ...overlay.bundles, ...agentsOverlay.bundles];
const mergedBindings: readonly Binding[] = [...bindings, ...overlay.bindings, ...agentsOverlay.bindings];

assertBundlesValid(mergedBundles);
assertBindingsValid(mergedBindings, mergedBundles, loadGroups());

export function loadBundles(): readonly Bundle[] {
  return mergedBundles;
}

export function loadBindings(): readonly Binding[] {
  return mergedBindings;
}

export function loadBaseBundles(): readonly Bundle[] {
  return bundles;
}

export function loadBaseBindings(): readonly Binding[] {
  return bindings;
}
