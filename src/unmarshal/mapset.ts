import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call, consume } from "../vmutil";

export default function unmarshalMapSet(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  unmarshal: (handle: QuickJSHandle) => [unknown, boolean],
  preUnmarshal: <T>(target: T, handle: QuickJSHandle) => T | undefined,
): Map<any, any> | Set<any> | undefined {
  const isMap = consume(call(ctx, "a => a instanceof Map", undefined, handle), h => ctx.dump(h));
  const isSet =
    !isMap && consume(call(ctx, "a => a instanceof Set", undefined, handle), h => ctx.dump(h));
  if (!isMap && !isSet) return;

  const result: Map<any, any> | Set<any> = isMap ? new Map() : new Set();
  preUnmarshal(result, handle);

  const iterator = ctx.unwrapResult(ctx.getIterator(handle));
  try {
    for (const elResult of iterator) {
      const el = ctx.unwrapResult(elResult);
      if (isMap) {
        const keyHandle = ctx.getProp(el, 0);
        const valueHandle = ctx.getProp(el, 1);
        const [key, disposeKey] = unmarshal(keyHandle);
        const [value, disposeValue] = unmarshal(valueHandle);
        if (disposeKey) keyHandle.dispose();
        if (disposeValue) valueHandle.dispose();
        (result as Map<any, any>).set(key, value);
        el.dispose();
      } else {
        const [value, disposeValue] = unmarshal(el);
        if (disposeValue) el.dispose();
        (result as Set<any>).add(value);
      }
    }
  } finally {
    if (iterator.alive) iterator.dispose();
  }

  return result;
}
