import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call, consumeAll } from "../vmutil";

export default function marshalCustom(
  ctx: QuickJSContext,
  target: unknown,
  preMarshal: (target: unknown, handle: QuickJSHandle) => QuickJSHandle | undefined,
  custom: Iterable<(target: unknown, ctx: QuickJSContext) => QuickJSHandle | undefined>,
): QuickJSHandle | undefined {
  let handle: QuickJSHandle | undefined;
  for (const c of custom) {
    handle = c(target, ctx);
    if (handle) break;
  }
  return handle ? preMarshal(target, handle) ?? handle : undefined;
}

export function symbol(target: unknown, ctx: QuickJSContext): QuickJSHandle | undefined {
  if (typeof target !== "symbol") return;
  const handle = call(
    ctx,
    "d => Symbol(d)",
    undefined,
    target.description ? ctx.newString(target.description) : ctx.undefined,
  );
  return handle;
}

export function date(target: unknown, ctx: QuickJSContext): QuickJSHandle | undefined {
  if (!(target instanceof Date)) return;
  const handle = call(ctx, "d => new Date(d)", undefined, ctx.newNumber(target.getTime()));
  return handle;
}

export function arrayBuffer(target: unknown, ctx: QuickJSContext): QuickJSHandle | undefined {
  if (target instanceof ArrayBuffer) {
    return ctx.newArrayBuffer(target.slice(0));
  }
  if (ArrayBuffer.isView(target)) {
    // TypedArray or DataView: copy the viewed bytes and rebuild in the VM.
    const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength).slice();
    return consumeAll(
      [ctx.newArrayBuffer(bytes.buffer), ctx.newString(target.constructor.name)],
      ([buf, name]) => call(ctx, `(buf, name) => new globalThis[name](buf)`, undefined, buf, name),
    );
  }
}

export const defaultCustom = [symbol, date, arrayBuffer];
