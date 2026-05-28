import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

import { call } from "../vmutil";

export default function marshalProperties(
  ctx: QuickJSContext,
  target: object | ((...args: any[]) => any),
  handle: QuickJSHandle,
  marshal: (target: unknown) => QuickJSHandle,
  disposeTransient: (handle: QuickJSHandle) => void = () => {},
): void {
  const descs = ctx.newObject();
  // Property values may be transient (json copies / BigInt) with no owner; once
  // `Object.defineProperties` has copied them into `handle` the standalone
  // handles are redundant and disposed below. Owned handles are left untouched.
  const transient: QuickJSHandle[] = [];
  const cb = (key: string | number | symbol, desc: PropertyDescriptor) => {
    const keyHandle = marshal(key);
    const valueHandle = typeof desc.value === "undefined" ? undefined : marshal(desc.value);
    const getHandle = typeof desc.get === "undefined" ? undefined : marshal(desc.get);
    const setHandle = typeof desc.set === "undefined" ? undefined : marshal(desc.set);
    if (valueHandle) transient.push(valueHandle);
    if (getHandle) transient.push(getHandle);
    if (setHandle) transient.push(setHandle);

    ctx.newObject().consume(descObj => {
      Object.entries(desc).forEach(([k, v]) => {
        const v2 =
          k === "value"
            ? valueHandle
            : k === "get"
            ? getHandle
            : k === "set"
            ? setHandle
            : v
            ? ctx.true
            : ctx.false;
        if (v2) {
          ctx.setProp(descObj, k, v2);
        }
      });
      ctx.setProp(descs, keyHandle, descObj);
    });
  };

  try {
    const desc = Object.getOwnPropertyDescriptors(target);
    Object.entries(desc).forEach(([k, v]) => cb(k, v));
    Object.getOwnPropertySymbols(desc).forEach(k => cb(k, (desc as any)[k]));

    call(ctx, `Object.defineProperties`, undefined, handle, descs).dispose();
    // Safe only after defineProperties has dup'd the values into `handle`; `descs`
    // still holds its own references until its own dispose() in the finally.
    for (const h of transient) disposeTransient(h);
  } finally {
    descs.dispose();
  }
}
