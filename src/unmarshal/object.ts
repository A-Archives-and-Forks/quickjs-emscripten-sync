import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call, consume } from "../vmutil";

import unmarshalProperties from "./properties";

export default function unmarshalObject(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  unmarshal: (handle: QuickJSHandle) => [unknown, boolean],
  preUnmarshal: <T>(target: T, handle: QuickJSHandle) => T | undefined,
): object | undefined {
  if (ctx.typeof(handle) !== "object" || ctx.sameValue(handle, ctx.null)) return;

  const raw = consume(call(ctx, "Array.isArray", undefined, handle), r => ctx.dump(r)) ? [] : {};
  const obj = preUnmarshal(raw, handle) ?? raw;

  const prototype = consume(
    call(
      ctx,
      `o => {
      const p = Object.getPrototypeOf(o);
      return !p || p === Object.prototype || p === Array.prototype ? undefined : p;
    }`,
      undefined,
      handle,
    ),
    prototype => {
      if (ctx.typeof(prototype) === "undefined") return;
      const [proto] = unmarshal(prototype);
      return proto;
    },
  );
  if (typeof prototype === "object") {
    Object.setPrototypeOf(obj, prototype);
  }

  unmarshalProperties(ctx, handle, raw, unmarshal);

  return obj;
}
