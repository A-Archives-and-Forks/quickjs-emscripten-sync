import type { QuickJSHandle, QuickJSContext } from "quickjs-emscripten";

import { isObject } from "./util";
import { call, consume, isHandleObject, mayConsumeAll } from "./vmutil";

export type SyncMode = "both" | "vm" | "host";

export type Wrapped<T> = T & { __qes_wrapped: never };

export function wrap<T = any>(
  ctx: QuickJSContext,
  target: T,
  proxyKeySymbol: symbol,
  proxyKeySymbolHandle: QuickJSHandle,
  marshal: (target: any) => [QuickJSHandle, boolean],
  syncMode?: (target: T) => SyncMode | undefined,
  wrappable?: (target: unknown) => boolean,
  syncEnabled = true,
): Wrapped<T> | undefined {
  // These built-ins rely on internal slots or non-property access, so a proxy
  // would break them; they are marshalled by value instead of being wrapped.
  if (
    !isObject(target) ||
    target instanceof Promise ||
    target instanceof Date ||
    target instanceof ArrayBuffer ||
    ArrayBuffer.isView(target) ||
    target instanceof Map ||
    target instanceof Set ||
    (wrappable && !wrappable(target))
  )
    return undefined;

  if (isWrapped(target, proxyKeySymbol)) return target;

  // Sync globally disabled: skip the proxy, but still treat the object as
  // "wrapped" so the rest of the pipeline handles it uniformly.
  if (!syncEnabled) return target as Wrapped<T>;

  const rec = new Proxy(target as any, {
    get(obj, key) {
      return key === proxyKeySymbol ? obj : Reflect.get(obj, key);
    },
    set(obj, key, value, receiver) {
      const v = unwrap(value, proxyKeySymbol);
      const sync = syncMode?.(receiver) ?? "host";
      // Set on the target directly (not via `receiver`) so creating a new
      // property does not re-enter the `defineProperty` trap.
      if ((sync !== "vm" && !Reflect.set(obj, key, v)) || sync === "host" || !ctx.alive)
        return true;

      mayConsumeAll(
        [marshal(receiver), marshal(key), marshal(v)],
        (receiverHandle, keyHandle, valueHandle) => {
          const [handle2, unwrapped] = unwrapHandle(ctx, receiverHandle, proxyKeySymbolHandle);
          if (unwrapped) {
            handle2.consume(h => ctx.setProp(h, keyHandle, valueHandle));
          } else {
            ctx.setProp(handle2, keyHandle, valueHandle);
          }
        },
      );

      return true;
    },
    deleteProperty(obj, key) {
      const sync = syncMode?.(rec) ?? "host";
      return mayConsumeAll([marshal(rec), marshal(key)], (recHandle, keyHandle) => {
        const [handle2, unwrapped] = unwrapHandle(ctx, recHandle, proxyKeySymbolHandle);

        if (sync === "vm" || Reflect.deleteProperty(obj, key)) {
          if (sync === "host" || !ctx.alive) return true;

          if (unwrapped) {
            handle2.consume(h => call(ctx, `(a, b) => delete a[b]`, undefined, h, keyHandle));
          } else {
            call(ctx, `(a, b) => delete a[b]`, undefined, handle2, keyHandle);
          }
        }
        return true;
      });
    },
    defineProperty(obj, key, descriptor) {
      const sync = syncMode?.(rec) ?? "host";
      const desc: PropertyDescriptor = { ...descriptor };
      if ("value" in desc) desc.value = unwrap(desc.value, proxyKeySymbol);
      if (typeof desc.get === "function") desc.get = unwrap(desc.get, proxyKeySymbol);
      if (typeof desc.set === "function") desc.set = unwrap(desc.set, proxyKeySymbol);

      if (sync !== "vm" && !Reflect.defineProperty(obj, key, desc)) return false;
      if (sync === "host" || !ctx.alive) return true;

      mayConsumeAll(
        [marshal(rec), marshal(key), marshal(desc)],
        (recHandle, keyHandle, descHandle) => {
          const [handle2, unwrapped] = unwrapHandle(ctx, recHandle, proxyKeySymbolHandle);
          const define = (h: QuickJSHandle) =>
            call(
              ctx,
              `(o, k, d) => { Object.defineProperty(o, k, d); }`,
              undefined,
              h,
              keyHandle,
              descHandle,
            ).dispose();
          if (unwrapped) handle2.consume(define);
          else define(handle2);
        },
      );
      return true;
    },
  }) as Wrapped<T>;
  return rec;
}

export function wrapHandle(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  proxyKeySymbol: symbol,
  proxyKeySymbolHandle: QuickJSHandle,
  unmarshal: (handle: QuickJSHandle) => any,
  syncMode?: (target: QuickJSHandle) => SyncMode | undefined,
  wrappable?: (target: QuickJSHandle, ctx: QuickJSContext) => boolean,
  syncEnabled = true,
): [Wrapped<QuickJSHandle> | undefined, boolean] {
  if (!isHandleObject(ctx, handle) || (wrappable && !wrappable(handle, ctx)))
    return [undefined, false];

  if (isHandleWrapped(ctx, handle, proxyKeySymbolHandle)) return [handle, false];

  // Sync globally disabled: skip the VM-side proxy.
  if (!syncEnabled) return [handle as Wrapped<QuickJSHandle>, false];

  const getSyncMode = (h: QuickJSHandle) => {
    const res = syncMode?.(unmarshal(h));
    if (typeof res === "string") return ctx.newString(res);
    return ctx.undefined;
  };

  const setter = (h: QuickJSHandle, keyHandle: QuickJSHandle, valueHandle: QuickJSHandle) => {
    const target = unmarshal(h);
    if (!target) return;
    const key = unmarshal(keyHandle);
    if (key === "__proto__") return; // for security
    const value = unmarshal(valueHandle);
    unwrap(target, proxyKeySymbol)[key] = value;
  };

  const deleter = (h: QuickJSHandle, keyHandle: QuickJSHandle) => {
    const target = unmarshal(h);
    if (!target) return;
    const key = unmarshal(keyHandle);
    Reflect.deleteProperty(unwrap(target, proxyKeySymbol), key);
  };

  const definer = (h: QuickJSHandle, keyHandle: QuickJSHandle, descHandle: QuickJSHandle) => {
    const target = unmarshal(h);
    if (!target) return;
    const key = unmarshal(keyHandle);
    if (key === "__proto__") return; // for security
    const desc = unmarshal(descHandle);
    Object.defineProperty(unwrap(target, proxyKeySymbol), key, desc);
  };

  const proxyFuncs = ctx.newFunction("proxyFuncs", (t, ...args) => {
    const name = ctx.getNumber(t);
    switch (name) {
      case 1:
        return getSyncMode(args[0]);
      case 2:
        return setter(args[0], args[1], args[2]);
      case 3:
        return deleter(args[0], args[1]);
      case 4:
        return definer(args[0], args[1], args[2]);
    }
    return ctx.undefined;
  });
  // Use the exception-safe consume so proxyFuncs is disposed even if compiling
  // the proxy below throws (e.g. under memory pressure).
  return consume(proxyFuncs, proxyFuncs => [
    call(
      ctx,
      `(target, sym, proxyFuncs) => {
          const rec =  new Proxy(target, {
            get(obj, key, receiver) {
              return key === sym ? obj : Reflect.get(obj, key, receiver)
            },
            set(obj, key, value, receiver) {
              const v = typeof value === "object" && value !== null || typeof value === "function"
                ? value[sym] ?? value
                : value;
              const sync = proxyFuncs(1, receiver) ?? "vm";
              if (sync === "host" || Reflect.set(obj, key, v)) {
                if (sync !== "vm") {
                  proxyFuncs(2, receiver, key, v);
                }
              }
              return true;
            },
            deleteProperty(obj, key) {
              const sync = proxyFuncs(1, rec) ?? "vm";
              if (sync === "host" || Reflect.deleteProperty(obj, key)) {
                if (sync !== "vm") {
                  proxyFuncs(3, rec, key);
                }
              }
              return true;
            },
            defineProperty(obj, key, descriptor) {
              const sync = proxyFuncs(1, rec) ?? "vm";
              if (sync === "host" || Reflect.defineProperty(obj, key, descriptor)) {
                if (sync !== "vm") {
                  proxyFuncs(4, rec, key, descriptor);
                }
              }
              return true;
            },
          });
          return rec;
        }`,
      undefined,
      handle,
      proxyKeySymbolHandle,
      proxyFuncs,
    ) as Wrapped<QuickJSHandle>,
    true,
  ]);
}

export function unwrap<T>(obj: T, key: string | symbol): T {
  return isObject(obj) ? ((obj as any)[key] as T) ?? obj : obj;
}

export function unwrapHandle(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  key: QuickJSHandle,
): [QuickJSHandle, boolean] {
  if (!isHandleWrapped(ctx, handle, key)) return [handle, false];
  return [ctx.getProp(handle, key), true];
}

export function isWrapped<T>(obj: T, key: string | symbol): obj is Wrapped<T> {
  return isObject(obj) && !!(obj as any)[key];
}

export function isHandleWrapped(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  key: QuickJSHandle,
): handle is Wrapped<QuickJSHandle> {
  return !!ctx.dump(
    call(
      ctx,
      // Built-ins that must not be wrapped (internal slots / non-property access)
      // report as "wrapped" so wrapHandle leaves them alone.
      `(a, s) => (a instanceof Promise) || (a instanceof Date) || (a instanceof ArrayBuffer) || (ArrayBuffer.isView(a)) || (a instanceof Map) || (a instanceof Set) || (typeof a === "object" && a !== null || typeof a === "function") && !!a[s]`,
      undefined,
      handle,
      key,
    ),
  );
}
