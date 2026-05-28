import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call } from "../vmutil";

export default function marshalMapSet(
  ctx: QuickJSContext,
  target: unknown,
  marshal: (target: unknown) => QuickJSHandle,
  preMarshal: (target: unknown, handle: QuickJSHandle) => QuickJSHandle | undefined,
): QuickJSHandle | undefined {
  if (target instanceof Map) {
    const raw = call(ctx, "() => new Map()");
    const handle = preMarshal(target, raw) ?? raw;
    for (const [k, v] of target) {
      call(ctx, "(m, k, v) => m.set(k, v)", undefined, raw, marshal(k), marshal(v)).dispose();
    }
    return handle;
  }

  if (target instanceof Set) {
    const raw = call(ctx, "() => new Set()");
    const handle = preMarshal(target, raw) ?? raw;
    for (const v of target) {
      call(ctx, "(s, v) => s.add(v)", undefined, raw, marshal(v)).dispose();
    }
    return handle;
  }
}
