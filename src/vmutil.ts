import type {
  Disposable,
  QuickJSContext,
  QuickJSHandle,
  QuickJSDeferredPromise,
  SuccessOrFail,
} from "quickjs-emscripten";

/**
 * Unwrap a VM result, disposing the error handle on failure.
 *
 * `ctx.unwrapResult` throws the error handle without disposing it, which leaks
 * the handle. Under memory pressure the leak cascades: reading the error needs
 * the VM, which is already exhausted, so cleanup is skipped entirely. Here we
 * read the error host-side, always dispose the handle, then throw a host Error.
 */
export function unwrapResult<T>(ctx: QuickJSContext, result: SuccessOrFail<T, QuickJSHandle>): T {
  if ("error" in result && result.error) {
    const { error } = result;
    let dumped: any;
    try {
      dumped = ctx.dump(error);
    } catch {
      // VM may be unable to read the error (e.g. out of memory); fall back below.
    } finally {
      if (error.alive) error.dispose();
    }
    const err = new Error(
      typeof dumped === "object" && dumped && "message" in dumped
        ? String(dumped.message)
        : dumped !== undefined
        ? String(dumped)
        : "quickjs-emscripten-sync: VM evaluation failed",
    );
    if (typeof dumped === "object" && dumped) {
      if ("name" in dumped) err.name = String(dumped.name);
      if ("stack" in dumped) err.stack = String(dumped.stack);
    }
    throw err;
  }
  return result.value;
}

export function fn(
  ctx: QuickJSContext,
  code: string,
): ((thisArg: QuickJSHandle | undefined, ...args: QuickJSHandle[]) => QuickJSHandle) & Disposable {
  const handle = unwrapResult(ctx, ctx.evalCode(code));
  const f: any = (thisArg: QuickJSHandle | undefined, ...args: QuickJSHandle[]): any => {
    return unwrapResult(ctx, ctx.callFunction(handle, thisArg ?? ctx.undefined, ...args));
  };
  const disposeFn = () => handle.dispose();
  f.dispose = disposeFn;
  f[Symbol.dispose] = disposeFn;
  f.alive = true;
  Object.defineProperty(f, "alive", {
    get: () => handle.alive,
  });
  return f;
}

// Compiled functions for `call` can be cached per context, keyed by code: the
// code passed to `call` is always a constant literal, so recompiling the same
// helper on every call (isHandleObject, defineProperties, etc.) was a dominant
// cost. Caching is opt-in per context via `enableFnCache` because cached
// handles outlive a single call and must be disposed with `disposeFnCache`;
// the Arena enables it in its constructor and disposes it in `dispose`. For
// contexts without a cache, `call` keeps its original compile-and-dispose
// behaviour so standalone callers don't leak handles.
const fnCache = new WeakMap<QuickJSContext, Map<string, QuickJSHandle>>();

/** Enable per-context caching of compiled functions used by `call`. */
export function enableFnCache(ctx: QuickJSContext): void {
  if (!fnCache.has(ctx)) fnCache.set(ctx, new Map());
}

/** Dispose all compiled functions cached for a context and disable caching. */
export function disposeFnCache(ctx: QuickJSContext): void {
  const cache = fnCache.get(ctx);
  if (!cache) return;
  for (const handle of cache.values()) {
    if (handle.alive) handle.dispose();
  }
  fnCache.delete(ctx);
}

export function call(
  ctx: QuickJSContext,
  code: string,
  thisArg?: QuickJSHandle,
  ...args: QuickJSHandle[]
): QuickJSHandle {
  const cache = fnCache.get(ctx);
  if (!cache) {
    const f = fn(ctx, code);
    try {
      return f(thisArg, ...args);
    } finally {
      f.dispose();
    }
  }

  let handle = cache.get(code);
  if (!handle || !handle.alive) {
    handle = unwrapResult(ctx, ctx.evalCode(code));
    cache.set(code, handle);
  }
  return unwrapResult(ctx, ctx.callFunction(handle, thisArg ?? ctx.undefined, ...args));
}

export function instanceOf(ctx: QuickJSContext, a: QuickJSHandle, b: QuickJSHandle): boolean {
  return ctx.dump(call(ctx, "(a, b) => a instanceof b", undefined, a, b));
}

export function isHandleObject(ctx: QuickJSContext, h: QuickJSHandle): boolean {
  return ctx.dump(
    call(ctx, `a => typeof a === "object" && a !== null || typeof a === "function"`, undefined, h),
  );
}

export function json(ctx: QuickJSContext, target: any): QuickJSHandle {
  const json = JSON.stringify(target);
  if (!json) return ctx.undefined;
  return call(ctx, `JSON.parse`, undefined, ctx.newString(json));
}

/**
 * Run `cb` with `handle`, then dispose `handle` even if `cb` throws.
 *
 * Unlike `handle.consume`, which skips disposal when its callback throws, this
 * helper disposes in a `finally` so error paths don't leak the handle.
 */
export function consume<T extends QuickJSHandle, K>(handle: T, cb: (handle: T) => K): K {
  try {
    return cb(handle);
  } finally {
    if (handle.alive) handle.dispose();
  }
}

export function consumeAll<T extends QuickJSHandle[], K>(handles: T, cb: (handles: T) => K): K {
  try {
    return cb(handles);
  } finally {
    for (const h of handles) {
      if (h.alive) h.dispose();
    }
  }
}

export function mayConsume<T>(
  [handle, shouldBeDisposed]: [QuickJSHandle, boolean],
  fn: (h: QuickJSHandle) => T,
) {
  try {
    return fn(handle);
  } finally {
    if (shouldBeDisposed) {
      handle.dispose();
    }
  }
}

export function mayConsumeAll<T, H extends QuickJSHandle[]>(
  handles: { [P in keyof H]: [QuickJSHandle, boolean] },
  fn: (...args: H) => T,
) {
  try {
    return fn(...(handles.map(h => h[0]) as H));
  } finally {
    for (const [handle, shouldBeDisposed] of handles) {
      if (shouldBeDisposed) {
        handle.dispose();
      }
    }
  }
}

function isQuickJSDeferredPromise(d: Disposable): d is QuickJSDeferredPromise {
  return "handle" in d;
}

export function handleFrom(d: QuickJSDeferredPromise | QuickJSHandle): QuickJSHandle {
  return isQuickJSDeferredPromise(d) ? d.handle : d;
}
