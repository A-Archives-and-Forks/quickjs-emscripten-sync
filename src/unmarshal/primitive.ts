import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

export default function unmarshalPrimitive(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
): [any, boolean] {
  const ty = ctx.typeof(handle);
  if (ty === "undefined" || ty === "number" || ty === "string" || ty === "boolean") {
    return [ctx.dump(handle), true];
  }
  if (ty === "bigint") {
    return [ctx.getBigInt(handle), true];
  }
  if (ty === "object" && ctx.sameValue(handle, ctx.null)) {
    return [null, true];
  }

  return [undefined, false];
}
