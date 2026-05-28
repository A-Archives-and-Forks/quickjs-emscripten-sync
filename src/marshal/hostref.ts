import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

/**
 * Marshal a host object as an opaque HostRef handle instead of deep-copying or
 * proxying it. The guest cannot read the object, but can hold it and pass it
 * back to the host, where it unmarshals to the original object by reference.
 */
export default function marshalHostRef(
  ctx: QuickJSContext,
  target: unknown,
  // Registers handle <-> target without wrapping (a proxy would hide the opaque
  // HostRef). Keeps identity and lets the arena dispose the handle on teardown.
  register: (target: unknown, handle: QuickJSHandle) => QuickJSHandle,
): QuickJSHandle | undefined {
  if (typeof target !== "object" && typeof target !== "function") return;
  if (target === null) return;
  return register(target, ctx.newHostRef(target as object).handle);
}
