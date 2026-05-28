import variant from "@jitl/quickjs-wasmfile-debug-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten";
import { describe, expect, it } from "vitest";

import { Arena } from ".";

// A non-plain object that defaultIsMarshalable would reject, forcing the
// "json" marshal path.
class Weird {
  x = 1;
}

const jsonIsMarshalable = (t: unknown) =>
  typeof t !== "object" || t === null || Object.getPrototypeOf(t) === Object.prototype
    ? true
    : "json";

async function withArena(
  options: ConstructorParameters<typeof Arena>[1],
  fn: (arena: Arena) => void,
) {
  const mod = await newQuickJSWASMModuleFromVariant(variant as any);
  const ctx = mod.newContext();
  const arena = new Arena(ctx, options);
  fn(arena);
  arena.dispose();
  // The debug-sync runtime aborts on dispose if any GC object handle leaked, so
  // simply reaching here without an Emscripten abort means no leak.
  expect(() => ctx.dispose()).not.toThrow();
}

describe("json marshal path handle leak", () => {
  it("does not leak when a nested value is marshalled via json", async () => {
    await withArena({ isMarshalable: jsonIsMarshalable }, arena => {
      // Outer object goes through the proxy/object path; the nested `weird`
      // property resolves to "json", creating a JSON.parse handle that nobody
      // would otherwise dispose.
      arena.expose({ obj: { weird: new Weird() } });
      expect(arena.evalCode(`obj.weird.x`)).toBe(1);
    });
  });

  it("does not leak nor double-dispose a top-level json value", async () => {
    await withArena({ isMarshalable: jsonIsMarshalable }, arena => {
      // host fn receives a top-level json value as an argument; the handle is
      // disposed by mayConsume and must not be re-disposed on dispose().
      let received: any;
      arena.expose({ sink: (v: any) => (received = v) });
      arena.evalCode(`sink`);
      const fn = arena.evalCode(`sink`);
      fn(new Weird());
      expect(received).toEqual({ x: 1 });
    });
  });

  it("does not leak with the default marshal mode (json)", async () => {
    // With no isMarshalable option the default mode is "json", so even a plain
    // nested object exercises the json path that used to leak. (Functions are
    // dropped by json serialization, so this path only carries plain values.)
    await withArena(undefined, arena => {
      arena.expose({ data: { a: { b: 1 } } });
      expect(arena.evalCode(`data.a.b`)).toBe(1);
    });
  });

  it("does not leak when a json value round-trips VM -> host", async () => {
    await withArena({ isMarshalable: jsonIsMarshalable }, arena => {
      const received: any[] = [];
      arena.expose({ host: { f: (v: any) => received.push(v) } });
      // VM builds a non-plain object and passes it to the host callback.
      arena.evalCode(`
        const o = Object.create({ tag: "proto" });
        o.a = 1;
        host.f({ nested: o });
      `);
      expect(received).toEqual([{ nested: { a: 1 } }]);
    });
  });
});

describe("value-marshalled built-ins do not leak when nested", () => {
  // Map/Set/Date/ArrayBuffer/TypedArray are excluded from proxy wrapping and
  // marshalled by value, so they get no entry in `_map`. A top-level one is
  // disposed by mayConsume, but a nested one used to have no owner and leaked
  // its handle (aborting the debug runtime on dispose).
  const builtinMarshalable = (t: unknown) =>
    t instanceof Map || t instanceof Set ? true : jsonIsMarshalable(t);

  it("nested Map", async () => {
    await withArena({ isMarshalable: builtinMarshalable }, arena => {
      arena.expose({ data: { m: new Map<string, unknown>([["b", new Weird()]]) } });
      expect(arena.evalCode(`data.m.get("b").x`)).toBe(1);
    });
  });

  it("nested Set", async () => {
    await withArena({ isMarshalable: builtinMarshalable }, arena => {
      arena.expose({ data: { s: new Set<number>([1, 2]) } });
      expect(arena.evalCode(`data.s.size`)).toBe(2);
    });
  });

  it("nested Date and TypedArray", async () => {
    await withArena({ isMarshalable: true }, arena => {
      arena.expose({ data: { d: new Date(0), a: new Uint8Array([1, 2, 3]) } });
      expect(arena.evalCode(`data.a[1]`)).toBe(2);
    });
  });

  it("deeply nested Map", async () => {
    await withArena({ isMarshalable: builtinMarshalable }, arena => {
      arena.expose({ data: { a: { b: { m: new Map<string, number>([["x", 9]]) } } } });
      expect(arena.evalCode(`data.a.b.m.get("x")`)).toBe(9);
    });
  });
});

describe("transient handles are freed as they are consumed (no accumulation)", () => {
  // Marshal `make(i)` many times, disposing the top-level handle each time
  // (mirroring `mayConsume`). With syncEnabled:false nothing is retained in
  // `_map`, so any growth in live VM memory / object count is a genuine leak of
  // a nested transient (json copy or BigInt) that was not disposed.
  async function liveGrowth(
    make: (i: number) => unknown,
    isMarshalable: ConstructorParameters<typeof Arena>[1] extends infer O
      ? O extends { isMarshalable?: infer M }
        ? M
        : never
      : never,
  ) {
    const mod = await newQuickJSWASMModuleFromVariant(variant as any);
    const ctx = mod.newContext();
    const arena = new Arena(ctx, { isMarshalable, syncEnabled: false }) as any;
    const mem = () => ctx.runtime.computeMemoryUsage().consume((h: any) => ctx.dump(h));
    const marshalOne = (i: number) => {
      // `_marshal` returns [handle, shouldBeDisposed]; honour it like mayConsume.
      const [h, shouldDispose] = arena._marshal(make(i));
      if (shouldDispose && h.alive) h.dispose();
    };
    // Warm up so one-time shape/atom allocations are not counted.
    for (let i = 0; i < 30; i++) marshalOne(i);
    const before = mem();
    for (let i = 0; i < 200; i++) marshalOne(i + 100000);
    const after = mem();
    arena.dispose();
    ctx.dispose();
    return {
      usedBytes: after.memory_used_size - before.memory_used_size,
      objects: after.obj_count - before.obj_count,
    };
  }

  it("does not leak nested BigInt values", async () => {
    // Pre-fix this leaked ~7 bytes of BigInt storage per iteration.
    const { usedBytes } = await liveGrowth(i => ({ b: BigInt(i) * 99999999n }), true);
    expect(usedBytes).toBeLessThan(400);
  });

  it("does not accumulate nested json objects", async () => {
    // Pre-fix each iteration retained one JSON.parse object until dispose.
    const { objects } = await liveGrowth(() => ({ w: new Weird() }), jsonIsMarshalable);
    expect(objects).toBeLessThan(20);
  });

  it("frees json/BigInt values stored in a Map or Set", async () => {
    // A top-level Map/Set so the collection handle itself is not retained; this
    // isolates the lifetime of its BigInt/json entries, which must be freed.
    const collMarshalable = (t: unknown) =>
      t instanceof Map || t instanceof Set ? true : jsonIsMarshalable(t);
    const map = await liveGrowth(
      i => new Map<string, unknown>([["a", BigInt(i)], ["b", new Weird()]]),
      collMarshalable,
    );
    expect(map.usedBytes).toBeLessThan(400);
    const set = await liveGrowth(() => new Set<unknown>([new Weird()]), collMarshalable);
    expect(set.usedBytes).toBeLessThan(400);
  });
});
