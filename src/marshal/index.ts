import type { QuickJSDeferredPromise, QuickJSHandle, QuickJSContext } from "quickjs-emscripten";

import marshalCustom, { defaultCustom } from "./custom";
import marshalFunction from "./function";
import marshalHostRef from "./hostref";
import marshalJSON from "./json";
import marshalMapSet from "./mapset";
import marshalObject from "./object";
import marshalPrimitive from "./primitive";
import marshalPromise from "./promise";

export type Options = {
  ctx: QuickJSContext;
  unmarshal: (handle: QuickJSHandle) => unknown;
  isMarshalable?: (target: unknown) => boolean | "json";
  marshalByReference?: (target: unknown) => boolean;
  registerHostRef?: (target: unknown, handle: QuickJSHandle) => QuickJSHandle;
  find: (target: unknown) => QuickJSHandle | undefined;
  pre: (
    target: unknown,
    handle: QuickJSHandle | QuickJSDeferredPromise,
    mode: true | "json" | undefined,
  ) => QuickJSHandle | undefined;
  preApply?: (target: (...args: any[]) => any, thisArg: unknown, args: unknown[]) => any;
  custom?: Iterable<(obj: unknown, ctx: QuickJSContext) => QuickJSHandle | undefined>;
};

export function marshal(target: unknown, options: Options): QuickJSHandle {
  const { ctx, unmarshal, isMarshalable, find, pre } = options;

  {
    const primitive = marshalPrimitive(ctx, target);
    if (primitive) {
      return primitive;
    }
  }

  {
    const handle = find(target);
    if (handle) return handle;
  }

  // Opt-in pass-by-reference: hand the object to the VM as an opaque HostRef
  // instead of marshalling its contents. Bypasses isMarshalable on purpose.
  if (options.marshalByReference?.(target) && options.registerHostRef) {
    const handle = marshalHostRef(ctx, target, options.registerHostRef);
    if (handle) return handle;
  }

  const marshalable = isMarshalable?.(target);
  if (marshalable === false) {
    return ctx.undefined;
  }

  const pre2 = (target: any, handle: QuickJSHandle | QuickJSDeferredPromise) =>
    pre(target, handle, marshalable);
  if (marshalable === "json") {
    return marshalJSON(ctx, target, pre2);
  }

  const marshal2 = (t: unknown) => marshal(t, options);
  return (
    marshalCustom(ctx, target, pre2, [...defaultCustom, ...(options.custom ?? [])]) ??
    marshalPromise(ctx, target, marshal2, pre2) ??
    marshalFunction(ctx, target, marshal2, unmarshal, pre2, options.preApply) ??
    marshalMapSet(ctx, target, marshal2, pre2) ??
    marshalObject(ctx, target, marshal2, pre2) ??
    ctx.undefined
  );
}

export default marshal;
