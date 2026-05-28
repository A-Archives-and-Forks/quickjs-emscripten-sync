import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import unmarshalCustom, { defaultCustom } from "./custom";
import unmarshalFunction from "./function";
import unmarshalMapSet from "./mapset";
import unmarshalObject from "./object";
import unmarshalPrimitive from "./primitive";
import unmarshalPromise from "./promise";

export type Options = {
  ctx: QuickJSContext;
  /** marshal returns handle and boolean indicates that the handle should be disposed after use */
  marshal: (target: unknown) => [QuickJSHandle, boolean];
  find: (handle: QuickJSHandle) => unknown | undefined;
  pre: <T = unknown>(target: T, handle: QuickJSHandle) => T | undefined;
  custom?: Iterable<(obj: QuickJSHandle, ctx: QuickJSContext) => any>;
};

export function unmarshal(handle: QuickJSHandle, options: Options): any {
  const [result] = unmarshalInner(handle, options);
  return result;
}

function unmarshalInner(handle: QuickJSHandle, options: Options): [any, boolean] {
  const { ctx, marshal, find, pre } = options;

  {
    const [target, ok] = unmarshalPrimitive(ctx, handle);
    if (ok) return [target, false];
  }

  {
    const target = find(handle);
    if (target) {
      return [target, true];
    }
  }

  const unmarshal2 = (h: QuickJSHandle) => unmarshalInner(h, options);

  // Custom types (Symbol, Date, ArrayBuffer, TypedArray, ...) are unmarshalled
  // by value and not tracked in the map, so their source handle is not owned by
  // anyone else and the caller must dispose it.
  const custom = unmarshalCustom(ctx, handle, pre, [...defaultCustom, ...(options.custom ?? [])]);
  if (custom) return [custom, true];

  // Map/Set are unmarshalled by value (snapshot copy), so the source handle is
  // not tracked and the caller must dispose it.
  const mapSet = unmarshalMapSet(ctx, handle, unmarshal2, pre);
  if (mapSet) return [mapSet, true];

  const result =
    unmarshalPromise(ctx, handle, marshal, pre) ??
    unmarshalFunction(ctx, handle, marshal, unmarshal2, pre) ??
    unmarshalObject(ctx, handle, unmarshal2, pre);

  return [result, false];
}

export default unmarshal;
