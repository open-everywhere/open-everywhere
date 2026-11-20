import { seatCutPostureNow, seatWithheldFromModelCall, type SeatCutPosture } from "../access/seat-cut.js";
import type { RoutableModel, RoutedCallOptions } from "./routing.js";

function toolNameOf(entry: unknown): string | undefined {
  const name = (entry as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Removes from one model call's `tools` list each tool that the seat cut withholds
 * (`access/seat-cut.ts#seatWithheldFromModelCall`), and returns the options unchanged when it
 * removes nothing. The list is the set the model sees, so the model never sees a withheld tool, as
 * on eve 0.x. When the removed entry was the last one and carried `providerOptions` (eve puts the
 * prompt-cache breakpoint on the last tool), the new last entry takes them.
 */
export function cutOfferedTools(options: RoutedCallOptions, posture: SeatCutPosture): RoutedCallOptions {
  const tools = (options as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0) return options;
  const names = tools.flatMap((entry) => {
    const name = toolNameOf(entry);
    return name === undefined ? [] : [name];
  });
  const withheld = new Set(seatWithheldFromModelCall(names, posture));
  if (withheld.size === 0) return options;
  const kept = tools.filter((entry) => {
    const name = toolNameOf(entry);
    return name === undefined || !withheld.has(name);
  });
  const last = tools[tools.length - 1] as { providerOptions?: unknown } | undefined;
  const newLast = kept[kept.length - 1] as { providerOptions?: unknown } | undefined;
  if (last !== undefined && newLast !== undefined && newLast !== last && last.providerOptions !== undefined && newLast.providerOptions === undefined) {
    kept[kept.length - 1] = { ...newLast, providerOptions: last.providerOptions };
  }
  return { ...options, tools: kept };
}

/**
 * Wraps one resolved model so that each of its calls offers only the tools the seat holds. Every
 * primary-model resolver applies it: `resolvePrimaryModel`, and the scripted model of the
 * integration tier. eve resolves the model before each model call, inside the step, so the posture
 * is read once here, where the seat cut's own resolvers read it.
 */
const WRAPPED = new WeakMap<object, unknown>();

/** The model `withSeatToolCut` wrapped, or `model` itself when it is not such a wrapper. */
export function unwrapSeatToolCut<TModel>(model: TModel): TModel {
  const inner = typeof model === "object" && model !== null ? WRAPPED.get(model) : undefined;
  return (inner ?? model) as TModel;
}

export function withSeatToolCut<TModel extends RoutableModel>(inner: TModel, posture: SeatCutPosture = seatCutPostureNow()): TModel {
  const shim: RoutableModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options: RoutedCallOptions) {
      return inner.doGenerate(cutOfferedTools(options, posture));
    },
    async doStream(options: RoutedCallOptions) {
      return inner.doStream(cutOfferedTools(options, posture));
    },
  };
  WRAPPED.set(shim, inner);
  return shim as TModel;
}
