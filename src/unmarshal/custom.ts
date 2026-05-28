import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call, consume } from "../vmutil";

export default function unmarshalCustom(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  preUnmarshal: <T>(target: T, handle: QuickJSHandle) => T | undefined,
  custom: Iterable<(handle: QuickJSHandle, ctx: QuickJSContext) => any>,
): symbol | undefined {
  let obj: any;
  for (const c of custom) {
    obj = c(handle, ctx);
    if (obj) break;
  }
  return obj ? preUnmarshal(obj, handle) ?? obj : undefined;
}

export function symbol(handle: QuickJSHandle, ctx: QuickJSContext): symbol | undefined {
  if (ctx.typeof(handle) !== "symbol") return;
  const desc = ctx.getString(ctx.getProp(handle, "description"));
  return Symbol(desc);
}

export function date(handle: QuickJSHandle, ctx: QuickJSContext): Date | undefined {
  if (!consume(call(ctx, "a => a instanceof Date", undefined, handle), h => ctx.dump(h))) return;
  const t = consume(call(ctx, "a => a.getTime()", undefined, handle), h => ctx.getNumber(h));
  return new Date(t);
}

export function arrayBuffer(
  handle: QuickJSHandle,
  ctx: QuickJSContext,
): ArrayBuffer | ArrayBufferView | undefined {
  if (consume(call(ctx, "a => a instanceof ArrayBuffer", undefined, handle), h => ctx.dump(h))) {
    const lifetime = ctx.getArrayBuffer(handle);
    const copy = lifetime.value.slice();
    lifetime.dispose();
    return copy.buffer;
  }

  if (consume(call(ctx, "a => ArrayBuffer.isView(a)", undefined, handle), h => ctx.dump(h))) {
    const name = consume(call(ctx, "a => a.constructor.name", undefined, handle), h =>
      ctx.getString(h),
    );
    const Ctor = (globalThis as any)[name];
    if (typeof Ctor !== "function") return;
    const bufHandle = call(
      ctx,
      "a => a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)",
      undefined,
      handle,
    );
    const lifetime = ctx.getArrayBuffer(bufHandle);
    const bytes = lifetime.value.slice();
    lifetime.dispose();
    bufHandle.dispose();
    return new Ctor(bytes.buffer);
  }
}

export const defaultCustom = [symbol, date, arrayBuffer];
