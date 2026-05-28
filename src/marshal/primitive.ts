import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

export default function marshalPrimitive(
  ctx: QuickJSContext,
  target: unknown,
): QuickJSHandle | undefined {
  switch (typeof target) {
    case "undefined":
      return ctx.undefined;
    case "number":
      return ctx.newNumber(target);
    case "string":
      return ctx.newString(target);
    case "boolean":
      return target ? ctx.true : ctx.false;
    case "bigint":
      return ctx.newBigInt(target);
    case "object":
      return target === null ? ctx.null : undefined;
  }

  return undefined;
}
