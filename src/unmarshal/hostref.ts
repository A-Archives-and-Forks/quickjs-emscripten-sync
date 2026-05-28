import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

/**
 * If `handle` is an opaque HostRef, resolve it back to the original host value.
 * Returns a wrapper so the caller can tell "resolved to a falsy value" apart
 * from "not a HostRef". `toHostRef` is cheap for non-HostRef handles.
 */
export default function unmarshalHostRef(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
): { value: unknown } | undefined {
  const ref = ctx.toHostRef(handle);
  if (!ref) return;
  try {
    return { value: ref.value };
  } finally {
    // toHostRef returns a HostRef wrapping a *dup* of the handle, so disposing
    // it does not affect the caller's handle.
    ref.dispose();
  }
}
