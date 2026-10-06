import { afterEach, describe, expect, it, vi } from "vitest";

import { compileColumns } from "./compile-columns";
import {
  BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE,
  brunoTableColumnCssVariable,
} from "./column-management";
import {
  BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT,
  BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
  BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
  BrunoTableViewportRuntime,
} from "./virtual-viewport";
import type { BrunoTableVirtualWindow } from "./virtual-viewport";

type TestRtlScrollType = "negative" | "default" | "reverse";

function runNextFrame(frames: FrameRequestCallback[]): void {
  const callback = frames.shift();
  expect(callback).toBeDefined();
  callback!(0);
}

function drainFrames(frames: FrameRequestCallback[], limit = 500): void {
  let count = 0;
  while (frames.length > 0) {
    count += 1;
    expect(count).toBeLessThanOrEqual(limit);
    runNextFrame(frames);
  }
}

function advanceFramesUntil(
  frames: FrameRequestCallback[],
  condition: () => boolean,
  limit = 500,
): void {
  let count = 0;
  while (!condition()) {
    count += 1;
    expect(count).toBeLessThanOrEqual(limit);
    runNextFrame(frames);
  }
}

function createRtlOwnerDocument(
  type: TestRtlScrollType,
  readDirection: () => "ltr" | "rtl" = () => "rtl",
): Document {
  let elementIndex = 0;
  const createElement = vi.fn(() => {
    const element = {
      appendChild: vi.fn(),
      dir: "",
      style: { cssText: "" },
    } as unknown as HTMLElement;
    if (elementIndex === 0) {
      let scrollLeft = type === "reverse" ? 1 : 0;
      Object.defineProperty(element, "scrollLeft", {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = type === "negative" && value > 0 ? 0 : value;
        },
      });
    }
    elementIndex += 1;
    return element;
  });
  return {
    body: { appendChild: vi.fn() },
    createElement,
    defaultView: {
      getComputedStyle: vi.fn(() => ({ direction: readDirection() })),
    },
    documentElement: { appendChild: vi.fn() },
    head: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  } as unknown as Document;
}

function createDeferredReverseRtlHarness(clientWidth = 200): Readonly<{
  callbacks: FrameRequestCallback[];
  commitScrollWidth: (width: number) => void;
  element: HTMLElement;
}> {
  const callbacks: FrameRequestCallback[] = [];
  let committedScrollWidth = clientWidth;
  let nativeScrollLeft = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const element = {
    addEventListener: vi.fn(),
    clientHeight: 480,
    clientWidth,
    ownerDocument: createRtlOwnerDocument("reverse"),
    parentElement: null,
    removeEventListener: vi.fn(),
    get scrollLeft() {
      return nativeScrollLeft;
    },
    set scrollLeft(value: number) {
      const committedMaximum = Math.max(committedScrollWidth - clientWidth, 0);
      nativeScrollLeft = Math.min(Math.max(value, 0), committedMaximum);
    },
    get scrollWidth() {
      return committedScrollWidth;
    },
    scrollTop: 0,
    style: { removeProperty: vi.fn(), setProperty: vi.fn() },
  } as unknown as HTMLElement;
  return Object.freeze({
    callbacks,
    commitScrollWidth: (width: number) => {
      committedScrollWidth = width;
    },
    element,
  });
}

function observeResizeTargets(): (target: Element) => void {
  const callbacks = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #callback: ResizeObserverCallback;
      readonly #targets = new Set<Element>();

      public constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      public observe(target: Element) {
        this.#targets.add(target);
        callbacks.set(target, this.#callback);
      }
      public disconnect() {
        for (const target of this.#targets) {
          if (callbacks.get(target) === this.#callback) callbacks.delete(target);
        }
        this.#targets.clear();
      }
    },
  );
  return (target) => callbacks.get(target)?.([], {} as ResizeObserver);
}

function installViewportObserverHarness(): Readonly<{
  readonly frames: FrameRequestCallback[];
  readonly triggerMutation: (target: Node) => void;
  readonly triggerResize: (target: Element) => void;
}> {
  const frames: FrameRequestCallback[] = [];
  const mutationCallbacks = new Map<Node, Map<MutationObserver, MutationCallback>>();
  const resizeCallbacks = new Map<Element, Map<ResizeObserver, ResizeObserverCallback>>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #callback: ResizeObserverCallback;
      readonly #targets = new Set<Element>();

      public constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      public observe(target: Element) {
        this.#targets.add(target);
        const observers = resizeCallbacks.get(target) ?? new Map();
        observers.set(this as unknown as ResizeObserver, this.#callback);
        resizeCallbacks.set(target, observers);
      }
      public disconnect() {
        for (const target of this.#targets) {
          const observers = resizeCallbacks.get(target);
          observers?.delete(this as unknown as ResizeObserver);
          if (observers?.size === 0) resizeCallbacks.delete(target);
        }
        this.#targets.clear();
      }
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      readonly #callback: MutationCallback;
      readonly #targets = new Set<Node>();

      public constructor(callback: MutationCallback) {
        this.#callback = callback;
      }
      public observe(target: Node) {
        this.#targets.add(target);
        const observers = mutationCallbacks.get(target) ?? new Map();
        observers.set(this as unknown as MutationObserver, this.#callback);
        mutationCallbacks.set(target, observers);
      }
      public disconnect() {
        for (const target of this.#targets) {
          const observers = mutationCallbacks.get(target);
          observers?.delete(this as unknown as MutationObserver);
          if (observers?.size === 0) mutationCallbacks.delete(target);
        }
        this.#targets.clear();
      }
    },
  );
  return Object.freeze({
    frames,
    triggerMutation: (target: Node) => {
      for (const [observer, callback] of mutationCallbacks.get(target) ?? []) {
        callback([], observer);
      }
    },
    triggerResize: (target: Element) => {
      for (const [observer, callback] of resizeCallbacks.get(target) ?? []) {
        callback([], observer);
      }
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrunoTableViewportRuntime", () => {
  it("recovers reveals after a frame observer fails and releases observers on disposal", () => {
    const columns = compileColumns([
      { columnId: "COL_ID_NAME", field: "name", headerName: "Name", valueType: "text" },
    ]);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(1_000, columns);
    viewport.attach(element);
    const failure = new Error("frame observer failed");
    const unsubscribe = viewport.subscribeFrameCommit(() => {
      throw failure;
    });
    const survivor = vi.fn();
    viewport.subscribeFrameCommit(survivor);
    viewport.revealCell(400, "COL_ID_NAME");
    expect(() => runNextFrame(frames)).toThrow(failure);
    expect(survivor).toHaveBeenCalledOnce();
    unsubscribe();
    viewport.revealCell(500, "COL_ID_NAME");
    drainFrames(frames);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(450);
    viewport.dispose();
    survivor.mockClear();
    viewport.attach(element);
    viewport.revealCell(600, "COL_ID_NAME");
    drainFrames(frames);
    expect(survivor).not.toHaveBeenCalled();
    viewport.dispose();
  });

  it("removes resize target registrations when an observer disconnects", () => {
    const triggerResize = observeResizeTargets();
    const callback = vi.fn<ResizeObserverCallback>();
    const observer = new ResizeObserver(callback);
    const target = {} as Element;

    observer.observe(target);
    triggerResize(target);
    expect(callback).toHaveBeenCalledOnce();

    observer.disconnect();
    triggerResize(target);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("publishes detached layout changes once and keeps hot scroll coordinates private", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const viewport = new BrunoTableViewportRuntime();
    const listener = vi.fn();
    viewport.subscribe(listener);

    viewport.setLayout(2, columns);

    expect(listener).toHaveBeenCalledOnce();
    expect(viewport.getSnapshot().virtualWindow).toMatchObject({
      rowStart: 0,
      rowEnd: 2,
      totalHeight: 72,
    });
    expect(viewport.getSnapshot()).not.toHaveProperty("scrollTop");
    expect(viewport.getSnapshot()).not.toHaveProperty("scrollLeft");

    viewport.setLayout(2, columns);
    expect(listener).toHaveBeenCalledOnce();

    viewport.setLayout(2, Object.freeze(Array.from(columns)));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("batches midpoint reveals and keeps segmented same-window scroll out of React", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const setProperty = vi.fn();
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(1_000_000, columns);
    viewport.attach(element);

    viewport.revealCell(400_000, "COL_ID_NAME");
    viewport.revealCell(500_000, "COL_ID_NAME");

    expect(requestFrame).toHaveBeenCalledOnce();
    callbacks[0]!(0);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(499_900);
    const listener = vi.fn();
    viewport.subscribe(listener);

    element.scrollTop += 1;
    scrollListener!(new Event("scroll"));
    callbacks[1]!(0);

    expect(listener).not.toHaveBeenCalled();
  });

  it("applies edit-anchor deltas through authoritative segmented logical coordinates", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(200_000, columns);
    viewport.attach(element);
    viewport.revealCell(120_000, "COL_ID_NAME");
    callbacks.shift()!(0);
    const before = viewport.getSnapshot().virtualWindow.rowStart;

    viewport.adjustVerticalByLogical(36_000);
    callbacks.shift()!(0);

    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(before + 900);
    expect(element.scrollTop).toBeLessThanOrEqual(BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT);
  });

  it("reports segmented logical vertical movement even when recentering preserves its physical anchor", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(200_000, columns);
    viewport.attach(element);
    viewport.revealCell(115_000, "COL_ID_NAME");
    callbacks.shift()!(0);
    viewport.adjustVerticalByLogical(40);
    callbacks.shift()!(0);
    const physicalAnchor = element.scrollTop;
    const before = viewport.getSnapshot().virtualWindow.rowStart;

    expect(viewport.scrollVerticalByLogical(12)).toBe(true);
    callbacks.shift()!(0);
    const afterFirst = viewport.getSnapshot().virtualWindow.rowStart;
    expect(element.scrollTop).toBe(physicalAnchor);

    expect(viewport.scrollVerticalByLogical(12)).toBe(true);
    callbacks.shift()!(0);

    expect(element.scrollTop).toBe(physicalAnchor);
    expect(afterFirst).toBe(before);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(before);

    expect(viewport.scrollVerticalByLogical(Number.MAX_SAFE_INTEGER)).toBe(true);
    callbacks.shift()!(0);
    expect(viewport.scrollVerticalByLogical(12)).toBe(false);
  });

  it.each(["ltr", "rtl"] as const)(
    "resolves cached logical body hits without DOM reads in %s",
    (direction) => {
      const columns = compileColumns(
        Array.from({ length: 8 }, (_, index) => ({
          columnId: `COL_ID_${String(index)}`,
          field: "name",
          headerName: `Column ${String(index)}`,
          valueType: "text" as const,
          width: 100,
        })),
      );
      const callbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let scrollTop = 0;
      let scrollLeft = 0;
      let trackReads = false;
      const element = {
        addEventListener: vi.fn(),
        clientHeight: 480,
        clientWidth: 320,
        ownerDocument: createRtlOwnerDocument("negative", () => direction),
        removeEventListener: vi.fn(),
        get scrollLeft() {
          if (trackReads) throw new Error("unexpected scrollLeft read");
          return scrollLeft;
        },
        set scrollLeft(value: number) {
          scrollLeft = value;
        },
        get scrollTop() {
          if (trackReads) throw new Error("unexpected scrollTop read");
          return scrollTop;
        },
        set scrollTop(value: number) {
          scrollTop = value;
        },
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      } as unknown as HTMLElement;
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(200_000, columns);
      viewport.attach(element);
      viewport.revealCell(115_000, "COL_ID_0");
      callbacks.shift()!(0);
      expect(viewport.scrollByLogical(200)).toBe(true);
      callbacks.shift()!(0);
      const expectedRow = viewport.getSnapshot().virtualWindow.rowStart + 9;
      trackReads = true;

      expect(
        viewport.resolveBodyHit({
          bodyTop: 40,
          centreLeft: 10,
          centreRight: 310,
          clientX: direction === "ltr" ? 60 : 260,
          clientY: 40 + 5 * 36 + 1,
        }),
      ).toEqual({ columnId: "COL_ID_2", rowIndex: expectedRow });
      trackReads = false;
      element.scrollLeft += direction === "ltr" ? 100 : -100;
      expect(
        viewport.resolveBodyHit({
          bodyTop: 40,
          centreLeft: 10,
          centreRight: 310,
          clientX: direction === "ltr" ? 60 : 260,
          clientY: 40 + 5 * 36 + 1,
          phase: "release",
        }),
      ).toEqual({ columnId: "COL_ID_3", rowIndex: expectedRow });
    },
  );

  it("frame-batches pinned-aware scrollbar geometry onto only the overlay subtree", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_START",
        field: "name",
        headerName: "Start",
        pinned: "start",
        valueType: "text",
        width: 120,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CENTER_${index}`,
        field: "name",
        headerName: `Center ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
      {
        columnId: "COL_ID_END",
        field: "name",
        headerName: "End",
        pinned: "end",
        valueType: "text",
        width: 140,
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let scrollListener: EventListener | undefined;
    const geometryOrder: string[] = [];
    const gridSetProperty = vi.fn();
    const bodyLayerSetProperty = vi.fn((_property: string, _value: string) =>
      geometryOrder.push("write-body-transform"),
    );
    const overlaySetProperty = vi.fn((_property: string, _value: string) =>
      geometryOrder.push("write-overlay"),
    );
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 800,
      get offsetHeight() {
        geometryOrder.push("read-offset-height");
        return 495;
      },
      get offsetWidth() {
        geometryOrder.push("read-offset-width");
        return 815;
      },
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: gridSetProperty },
    } as unknown as HTMLElement;
    const overlay = {
      style: { removeProperty: vi.fn(), setProperty: overlaySetProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    viewport.attachRowLayer({
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement);
    viewport.attachBodyLayer({
      style: { removeProperty: vi.fn(), setProperty: bodyLayerSetProperty },
    } as unknown as HTMLElement);
    viewport.attachScrollbarOverlay(overlay);

    const initialProperties = new Map(
      overlaySetProperty.mock.calls.map(
        ([property, value]) => [String(property), String(value)] as const,
      ),
    );
    expect(initialProperties.get("--bruno-table-scrollbar-horizontal-start")).toBe("120px");
    expect(initialProperties.get("--bruno-table-scrollbar-horizontal-end")).toBe("155px");
    expect(initialProperties.get("direction")).toBe("ltr");
    expect(initialProperties.get("--bruno-table-scrollbar-horizontal-bottom")).toBe("15px");
    expect(initialProperties.get("--bruno-table-scrollbar-vertical-top")).toBe("36px");
    expect(initialProperties.get("--bruno-table-scrollbar-vertical-right")).toBe("15px");
    expect(initialProperties.get("--bruno-table-scrollbar-vertical-bottom")).toBe("23px");
    overlaySetProperty.mockClear();
    gridSetProperty.mockClear();
    bodyLayerSetProperty.mockClear();
    geometryOrder.length = 0;

    element.scrollLeft = 300;
    element.scrollTop = 1_200;
    scrollListener!(new Event("scroll"));
    scrollListener!(new Event("scroll"));

    expect(callbacks).toHaveLength(1);
    expect(overlaySetProperty).not.toHaveBeenCalled();
    callbacks[0]!(0);

    const scrolledProperties = new Map(
      overlaySetProperty.mock.calls.map(
        ([property, value]) => [String(property), String(value)] as const,
      ),
    );
    expect(
      Number.parseFloat(scrolledProperties.get("--bruno-table-scrollbar-horizontal-thumb-offset")!),
    ).toBeGreaterThan(0);
    expect(
      Number.parseFloat(scrolledProperties.get("--bruno-table-scrollbar-vertical-thumb-offset")!),
    ).toBeGreaterThan(0);
    expect(bodyLayerSetProperty).not.toHaveBeenCalled();
    const firstWrite = geometryOrder.findIndex((operation) => operation.startsWith("write"));
    const lastRead = geometryOrder.findLastIndex((operation) => operation.startsWith("read"));
    expect(lastRead).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(lastRead);
    expect(
      gridSetProperty.mock.calls.some(([property]) => String(property).includes("scrollbar")),
    ).toBe(false);

    overlaySetProperty.mockClear();
    element.scrollLeft = 660;
    element.scrollTop = 3_156;
    viewport.attach(null);
    viewport.attach(element);
    const maximumProperties = new Map(
      [...initialProperties, ...overlaySetProperty.mock.calls].map(
        ([property, value]) => [String(property), String(value)] as const,
      ),
    );
    expect(
      Number.parseFloat(maximumProperties.get("--bruno-table-scrollbar-horizontal-thumb-offset")!) +
        Number.parseFloat(maximumProperties.get("--bruno-table-scrollbar-horizontal-thumb-width")!),
    ).toBeCloseTo(540, 6);
    expect(
      Number.parseFloat(maximumProperties.get("--bruno-table-scrollbar-vertical-thumb-offset")!) +
        Number.parseFloat(maximumProperties.get("--bruno-table-scrollbar-vertical-thumb-height")!),
    ).toBeCloseTo(436, 6);
  });

  it("unregisters replaced body layers before a later transform frame", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_BODY_LAYER_CLEANUP",
        field: "name",
        headerName: "Body layer cleanup",
        valueType: "text",
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(1_000_000, columns);
    viewport.attach(element);

    const detachedWrite = vi.fn();
    for (let index = 0; index < 100; index += 1) {
      const cleanup = viewport.attachBodyLayer({
        isConnected: true,
        style: { removeProperty: vi.fn(), setProperty: detachedWrite },
      } as unknown as HTMLElement);
      expect(cleanup).toBeTypeOf("function");
      cleanup!();
    }
    detachedWrite.mockClear();
    const mountedWrites = [vi.fn(), vi.fn(), vi.fn()];
    for (const setProperty of mountedWrites) {
      viewport.attachBodyLayer({
        isConnected: true,
        style: { removeProperty: vi.fn(), setProperty },
      } as unknown as HTMLElement);
      setProperty.mockClear();
    }

    viewport.revealCell(200_000, "COL_ID_BODY_LAYER_CLEANUP");
    callbacks.shift()!(0);

    expect(detachedWrite).not.toHaveBeenCalled();
    for (const setProperty of mountedWrites) {
      expect(setProperty).toHaveBeenCalledOnce();
      expect(setProperty).toHaveBeenCalledWith("transform", expect.stringContaining("3d"));
    }
  });

  it("keeps decorative tracks disjoint with overlay-native scrollbars and suspended pinning", () => {
    const suspendedColumns = compileColumns([
      {
        columnId: "COL_ID_START",
        field: "name",
        headerName: "Start",
        pinned: "start",
        valueType: "text",
        width: 600,
      },
      {
        columnId: "COL_ID_CENTER",
        field: "name",
        headerName: "Center",
        valueType: "text",
        width: 120,
      },
      {
        columnId: "COL_ID_END",
        field: "name",
        headerName: "End",
        pinned: "end",
        valueType: "text",
        width: 600,
      },
    ]);
    const overlaySetProperty = vi.fn();
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      offsetHeight: 480,
      offsetWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, suspendedColumns);
    viewport.attach(element);
    viewport.attachScrollbarOverlay({
      style: { removeProperty: vi.fn(), setProperty: overlaySetProperty },
    } as unknown as HTMLElement);

    const properties = new Map(
      overlaySetProperty.mock.calls.map(
        ([property, value]) => [String(property), String(value)] as const,
      ),
    );
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd).toHaveLength(0);
    expect(properties.get("--bruno-table-scrollbar-horizontal-start")).toBe("0px");
    expect(properties.get("--bruno-table-scrollbar-horizontal-end")).toBe("0px");
    expect(properties.get("--bruno-table-scrollbar-vertical-bottom")).toBe("8px");

    overlaySetProperty.mockClear();
    element.scrollTop = 3_156;
    viewport.attach(null);
    viewport.attach(element);
    const suspendedMaximumProperties = new Map(
      [...properties, ...overlaySetProperty.mock.calls].map(
        ([property, value]) => [String(property), String(value)] as const,
      ),
    );
    expect(
      Number.parseFloat(
        suspendedMaximumProperties.get("--bruno-table-scrollbar-vertical-thumb-offset")!,
      ) +
        Number.parseFloat(
          suspendedMaximumProperties.get("--bruno-table-scrollbar-vertical-thumb-height")!,
        ),
    ).toBeCloseTo(436, 6);

    overlaySetProperty.mockClear();
    viewport.setLayout(
      100,
      compileColumns([
        {
          columnId: "COL_ID_UNPINNED_START",
          field: "name",
          headerName: "Unpinned start",
          valueType: "text",
          width: 600,
        },
        {
          columnId: "COL_ID_UNPINNED_CENTER",
          field: "name",
          headerName: "Unpinned center",
          valueType: "text",
          width: 120,
        },
        {
          columnId: "COL_ID_UNPINNED_END",
          field: "name",
          headerName: "Unpinned end",
          valueType: "text",
          width: 600,
        },
      ]),
    );
    const unpinnedProperties = new Map(
      [...suspendedMaximumProperties, ...overlaySetProperty.mock.calls].map(
        ([property, value]) => [String(property), String(value)] as const,
      ),
    );
    expect(unpinnedProperties.get("--bruno-table-scrollbar-horizontal-start")).toBe("0px");
    expect(unpinnedProperties.get("--bruno-table-scrollbar-horizontal-end")).toBe("0px");
    expect(unpinnedProperties.get("--bruno-table-scrollbar-vertical-bottom")).toBe("8px");
    expect(
      Number.parseFloat(unpinnedProperties.get("--bruno-table-scrollbar-vertical-thumb-offset")!) +
        Number.parseFloat(unpinnedProperties.get("--bruno-table-scrollbar-vertical-thumb-height")!),
    ).toBeCloseTo(436, 6);
  });

  it("rebases horizontal coordinates when viewport width suspends and restores pinning", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_START",
        field: "name",
        headerName: "Start",
        pinned: "start",
        valueType: "text",
        width: 100,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CENTER_${String(index)}`,
        field: "name",
        headerName: `Center ${String(index)}`,
        valueType: "text" as const,
        width: 100,
      })),
      {
        columnId: "COL_ID_END",
        field: "name",
        headerName: "End",
        pinned: "end",
        valueType: "text",
        width: 100,
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    let resize: (() => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        public constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this as unknown as ResizeObserver);
        }
        public observe() {}
        public disconnect() {}
      },
    );
    let width = 300;
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      get clientWidth() {
        return width;
      },
      removeEventListener: vi.fn(),
      scrollLeft: 320,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(1);

    width = 260;
    resize!();
    callbacks.shift()!(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);
    expect(element.scrollLeft).toBe(420);

    width = 300;
    resize!();
    callbacks.shift()!(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(1);
    expect(element.scrollLeft).toBe(320);
  });

  it.each(["ltr", "reverse-rtl"] as const)(
    "converts the near-maximum suspended offset before restoring sticky pinning in %s",
    (direction) => {
      const columns = compileColumns([
        {
          columnId: "COL_ID_THRESHOLD_START",
          field: "name",
          headerName: "Threshold start",
          pinned: "start",
          valueType: "text",
          width: 100,
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          columnId: `COL_ID_THRESHOLD_CENTER_${index}`,
          field: "name",
          headerName: `Threshold center ${index}`,
          valueType: "text" as const,
          width: 100,
        })),
        {
          columnId: "COL_ID_THRESHOLD_END",
          field: "name",
          headerName: "Threshold end",
          pinned: "end",
          valueType: "text",
          width: 100,
        },
      ]);
      const callbacks: FrameRequestCallback[] = [];
      let resize: (() => void) | undefined;
      let width = 260;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      vi.stubGlobal(
        "ResizeObserver",
        class {
          public constructor(callback: ResizeObserverCallback) {
            resize = () => callback([], this as unknown as ResizeObserver);
          }
          public observe() {}
          public disconnect() {}
        },
      );
      const element = {
        addEventListener: vi.fn(),
        clientHeight: 480,
        get clientWidth() {
          return width;
        },
        ...(direction === "reverse-rtl"
          ? { ownerDocument: createRtlOwnerDocument("reverse"), parentElement: null }
          : {}),
        removeEventListener: vi.fn(),
        scrollLeft: direction === "reverse-rtl" ? 0 : 940,
        scrollTop: 0,
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      } as unknown as HTMLElement;
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(2, columns);
      viewport.attach(element);
      expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);

      width = 300;
      viewport.setLayout(3, columns);
      expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(1);
      expect(element.scrollLeft).toBe(direction === "reverse-rtl" ? 60 : 840);

      resize!();
      callbacks.shift()!(0);
      expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(1);
      expect(element.scrollLeft).toBe(direction === "reverse-rtl" ? 60 : 840);
    },
  );

  it.each(["negative", "default", "reverse"] as const)(
    "normalizes exact RTL reveal writes for the %s native scroll model",
    (rtlType) => {
      const columns = compileColumns(
        Array.from({ length: 10 }, (_, index) => ({
          columnId: `COL_ID_RTL_${index}`,
          field: "name",
          headerName: `RTL ${index}`,
          valueType: "text" as const,
          width: 100,
        })),
      );
      const callbacks: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const maximum = 800;
      const gridSetProperty = vi.fn();
      const hostSetProperty = vi.fn();
      const hostRemoveProperty = vi.fn();
      const element = {
        addEventListener: vi.fn(),
        clientHeight: 480,
        clientWidth: 200,
        ownerDocument: createRtlOwnerDocument(rtlType),
        parentElement: null,
        removeEventListener: vi.fn(),
        scrollLeft: rtlType === "reverse" ? maximum : 0,
        scrollTop: 0,
        style: { removeProperty: vi.fn(), setProperty: gridSetProperty },
      } as unknown as HTMLElement;
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(2, columns);
      viewport.attach(element);
      viewport.attachPinnedEditorHost({
        style: { removeProperty: hostRemoveProperty, setProperty: hostSetProperty },
      } as unknown as HTMLElement);

      viewport.revealCell(0, "COL_ID_RTL_9", "header");
      callbacks.shift()!(0);
      expect(element.scrollLeft).toBe(
        rtlType === "negative" ? -maximum : rtlType === "reverse" ? 0 : maximum,
      );
      expect(hostSetProperty).toHaveBeenCalledWith(
        BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
        `${maximum}px`,
      );
      expect(hostSetProperty).toHaveBeenCalledWith(
        BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
        "200px",
      );
      expect(gridSetProperty).not.toHaveBeenCalledWith(
        BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
        expect.any(String),
      );
      expect(gridSetProperty).not.toHaveBeenCalledWith(
        BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
        expect.any(String),
      );
      expect(viewport.getSnapshot().virtualWindow.center.at(-1)?.columnId).toBe("COL_ID_RTL_9");

      viewport.revealCell(0, "COL_ID_RTL_0", "header");
      callbacks.shift()!(0);
      if (rtlType === "reverse") expect(element.scrollLeft).toBe(maximum);
      else expect(Math.abs(element.scrollLeft)).toBe(0);
      expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe("COL_ID_RTL_0");
    },
  );

  it("frame-batches direction reconciliation and preserves newer native user input", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DIRECTION_${index}`,
        field: "name",
        headerName: `Direction ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    let direction: "ltr" | "rtl" = "ltr";
    let clientWidthReads = 0;
    let directionFrameWidth = 200;
    let mutation: MutationCallback | undefined;
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "MutationObserver",
      class {
        public constructor(callback: MutationCallback) {
          mutation = callback;
        }
        public observe() {}
        public disconnect() {}
      },
    );
    const ownerDocument = createRtlOwnerDocument("negative", () => direction);
    const readComputedStyle = ownerDocument.defaultView!.getComputedStyle as ReturnType<
      typeof vi.fn
    >;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      get clientWidth() {
        clientWidthReads += 1;
        return directionFrameWidth;
      },
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 320,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    expect(readComputedStyle).toHaveBeenCalledTimes(2);

    direction = "rtl";
    mutation!([], {} as MutationObserver);
    directionFrameWidth = 240;
    element.scrollLeft = 0;
    scrollListener!(new Event("scroll"));
    expect(readComputedStyle).toHaveBeenCalledTimes(2);
    expect(element.scrollLeft).toBe(0);
    callbacks.shift()!(0);
    expect(readComputedStyle).toHaveBeenCalledTimes(3);
    expect(element.scrollLeft).toBe(-320);

    direction = "ltr";
    mutation!([], {} as MutationObserver);
    element.scrollLeft = 0;
    scrollListener!(new Event("scroll"));
    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    callbacks.shift()!(0);
    expect(element.scrollLeft).toBe(480);
    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBeGreaterThan(1);

    element.scrollLeft = 600;
    scrollListener!(new Event("scroll"));
    direction = "rtl";
    mutation!([], {} as MutationObserver);
    callbacks.shift()!(0);
    expect(element.scrollLeft).toBe(-600);

    readComputedStyle.mockClear();
    clientWidthReads = 0;
    for (const nativeScrollLeft of [-640, -680, -720]) {
      element.scrollLeft = nativeScrollLeft;
      scrollListener!(new Event("scroll"));
    }
    expect(readComputedStyle).not.toHaveBeenCalled();
    expect(clientWidthReads).toBe(0);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!(0);
    expect(readComputedStyle).not.toHaveBeenCalled();
    expect(clientWidthReads).toBeGreaterThan(0);
    expect(element.scrollLeft).toBe(-720);
  });

  it("keeps computed direction reads out of clean ordinary scroll frames", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CLEAN_DIRECTION_${index}`,
        field: "name",
        headerName: `Clean direction ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const observers = installViewportObserverHarness();
    let scrollListener: EventListener | undefined;
    const ownerDocument = createRtlOwnerDocument("negative", () => "ltr");
    const readComputedStyle = ownerDocument.defaultView!.getComputedStyle as ReturnType<
      typeof vi.fn
    >;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 200,
      offsetHeight: 500,
      offsetWidth: 220,
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    readComputedStyle.mockClear();

    element.scrollLeft = 160;
    element.scrollTop = 64;
    scrollListener!(new Event("scroll"));
    observers.frames.shift()!(0);

    expect(readComputedStyle).not.toHaveBeenCalled();

    observers.triggerMutation(element);
    observers.frames.shift()!(0);
    expect(readComputedStyle).toHaveBeenCalledOnce();

    readComputedStyle.mockClear();
    element.scrollLeft = 320;
    element.scrollTop = 128;
    scrollListener!(new Event("scroll"));
    observers.frames.shift()!(0);
    expect(readComputedStyle).not.toHaveBeenCalled();
  });

  it("keeps computed direction reads out of observed RTL scroll frames", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CLEAN_RTL_DIRECTION_${index}`,
        field: "name",
        headerName: `Clean RTL direction ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const observers = installViewportObserverHarness();
    let scrollListener: EventListener | undefined;
    const ownerDocument = createRtlOwnerDocument("negative", () => "rtl");
    const readComputedStyle = ownerDocument.defaultView!.getComputedStyle as ReturnType<
      typeof vi.fn
    >;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 200,
      offsetHeight: 500,
      offsetWidth: 220,
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    readComputedStyle.mockClear();

    element.scrollLeft = -600;
    element.scrollTop = 64;
    scrollListener!(new Event("scroll"));
    observers.frames.shift()!(0);

    expect(readComputedStyle).not.toHaveBeenCalled();
    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBeGreaterThan(0);
  });

  it("reuses observed dimensions for scroll and refreshes them once after resize", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CAPTURED_DIMENSION_${index}`,
        field: "name",
        headerName: `Captured dimension ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const observers = installViewportObserverHarness();
    const reads = { clientHeight: 0, clientWidth: 0, offsetHeight: 0, offsetWidth: 0 };
    let scrollListener: EventListener | undefined;
    let nativeScrollLeft = 0;
    let publicationStarted = false;
    let postPublicationScrollLeftReads = 0;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      get clientHeight() {
        reads.clientHeight += 1;
        return 480;
      },
      get clientWidth() {
        reads.clientWidth += 1;
        return 200;
      },
      get offsetHeight() {
        reads.offsetHeight += 1;
        return 500;
      },
      get offsetWidth() {
        reads.offsetWidth += 1;
        return 220;
      },
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      get scrollLeft() {
        if (publicationStarted) postPublicationScrollLeftReads += 1;
        return nativeScrollLeft;
      },
      set scrollLeft(value: number) {
        nativeScrollLeft = value;
      },
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    viewport.attachScrollbarOverlay({
      style: {
        setProperty: vi.fn(() => {
          publicationStarted = true;
        }),
      },
    } as unknown as HTMLElement);
    publicationStarted = false;
    reads.clientHeight = 0;
    reads.clientWidth = 0;
    reads.offsetHeight = 0;
    reads.offsetWidth = 0;

    element.scrollLeft = 160;
    element.scrollTop = 64;
    scrollListener!(new Event("scroll"));
    observers.frames.shift()!(0);

    expect(reads).toEqual({ clientHeight: 0, clientWidth: 0, offsetHeight: 0, offsetWidth: 0 });
    expect(postPublicationScrollLeftReads).toBe(0);

    observers.triggerResize(element);
    observers.frames.shift()!(0);
    expect(reads).toEqual({ clientHeight: 1, clientWidth: 1, offsetHeight: 1, offsetWidth: 1 });

    reads.clientHeight = 0;
    reads.clientWidth = 0;
    reads.offsetHeight = 0;
    reads.offsetWidth = 0;
    postPublicationScrollLeftReads = 0;
    expect(viewport.scrollByLogical(20)).toBe(true);
    expect(reads).toEqual({ clientHeight: 0, clientWidth: 0, offsetHeight: 0, offsetWidth: 0 });
    expect(postPublicationScrollLeftReads).toBe(0);
    observers.frames.shift()!(0);
    expect(reads).toEqual({ clientHeight: 0, clientWidth: 0, offsetHeight: 0, offsetWidth: 0 });
    expect(postPublicationScrollLeftReads).toBe(0);
  });

  it("updates only scrollbar thumb offsets during steady scroll", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_STEADY_SCROLLBAR_${index}`,
        field: "name",
        headerName: `Steady scrollbar ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const observers = installViewportObserverHarness();
    let scrollListener: EventListener | undefined;
    let clientWidth = 200;
    const overlaySetProperty = vi.fn();
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      get clientWidth() {
        return clientWidth;
      },
      offsetHeight: 500,
      offsetWidth: 220,
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    viewport.attachScrollbarOverlay({
      style: { removeProperty: vi.fn(), setProperty: overlaySetProperty },
    } as unknown as HTMLElement);
    overlaySetProperty.mockClear();

    element.scrollLeft = 160;
    element.scrollTop = 64;
    scrollListener!(new Event("scroll"));
    observers.frames.shift()!(0);

    expect(overlaySetProperty.mock.calls).toEqual([
      ["--bruno-table-scrollbar-horizontal-thumb-offset", expect.any(String)],
      ["--bruno-table-scrollbar-vertical-thumb-offset", expect.any(String)],
    ]);

    overlaySetProperty.mockClear();
    clientWidth = 240;
    observers.triggerResize(element);
    observers.frames.shift()!(0);

    expect(overlaySetProperty).toHaveBeenCalledWith(
      "--bruno-table-scrollbar-horizontal-thumb-width",
      expect.any(String),
    );
    expect(overlaySetProperty).toHaveBeenCalledWith(
      "--bruno-table-scrollbar-vertical-thumb-height",
      expect.any(String),
    );
  });

  it("refreshes computed direction during resize-driven environment reconciliation", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_RESIZE_DIRECTION_${index}`,
        field: "name",
        headerName: `Resize direction ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    let direction: "ltr" | "rtl" = "ltr";
    let resize: (() => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        public constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this as unknown as ResizeObserver);
        }
        public observe() {}
        public disconnect() {}
      },
    );
    const ownerDocument = createRtlOwnerDocument("negative", () => direction);
    const readComputedStyle = ownerDocument.defaultView!.getComputedStyle as ReturnType<
      typeof vi.fn
    >;
    const overlaySetProperty = vi.fn();
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 200,
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 600,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    viewport.attachScrollbarOverlay({
      style: { removeProperty: vi.fn(), setProperty: overlaySetProperty },
    } as unknown as HTMLElement);
    const initialCenterStart = viewport.getSnapshot().virtualWindow.centerStartIndex;
    expect(readComputedStyle).toHaveBeenCalledTimes(2);

    overlaySetProperty.mockClear();
    direction = "rtl";
    resize!();
    expect(readComputedStyle).toHaveBeenCalledTimes(2);
    callbacks.shift()!(0);

    expect(readComputedStyle).toHaveBeenCalledTimes(3);
    expect(element.scrollLeft).toBe(-600);
    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBe(initialCenterStart);
    expect(overlaySetProperty).toHaveBeenCalledWith("direction", "rtl");
  });

  it("keeps a post-resize reverse-RTL round trip authoritative", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_RESIZE_ROUND_TRIP_${index}`,
        field: "name",
        headerName: `Resize round trip ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const observers = installViewportObserverHarness();
    let clientWidthReads = 0;
    let scrollListener: EventListener | undefined;
    let width = 200;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      get clientWidth() {
        clientWidthReads += 1;
        return width;
      },
      ownerDocument: createRtlOwnerDocument("reverse"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 500,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    width = 300;
    clientWidthReads = 0;
    observers.triggerResize(element);
    element.scrollLeft = 450;
    scrollListener!(new Event("scroll"));
    element.scrollLeft = 500;
    scrollListener!(new Event("scroll"));
    width = 400;
    observers.triggerResize(element);

    expect(clientWidthReads).toBe(0);
    expect(observers.frames).toHaveLength(1);
    observers.frames.shift()!(0);
    expect(element.scrollLeft).toBe(500);
  });

  it("keeps a post-direction reverse-RTL round trip authoritative", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DIRECTION_ROUND_TRIP_${index}`,
        field: "name",
        headerName: `Direction round trip ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const observers = installViewportObserverHarness();
    let clientWidthReads = 0;
    let direction: "ltr" | "rtl" = "ltr";
    let width = 200;
    let scrollListener: EventListener | undefined;
    const ownerDocument = createRtlOwnerDocument("reverse", () => direction);
    const readComputedStyle = ownerDocument.defaultView!.getComputedStyle as ReturnType<
      typeof vi.fn
    >;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      get clientWidth() {
        clientWidthReads += 1;
        return width;
      },
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 500,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    direction = "rtl";
    observers.triggerMutation(element);
    width = 240;
    element.scrollLeft = 0;
    scrollListener!(new Event("scroll"));
    readComputedStyle.mockClear();
    clientWidthReads = 0;
    element.scrollLeft = 450;
    scrollListener!(new Event("scroll"));
    element.scrollLeft = 500;
    scrollListener!(new Event("scroll"));
    observers.triggerMutation(element);

    expect(readComputedStyle).not.toHaveBeenCalled();
    expect(clientWidthReads).toBe(0);
    expect(observers.frames).toHaveLength(1);
    observers.frames.shift()!(0);
    expect(readComputedStyle).toHaveBeenCalledOnce();
    expect(element.scrollLeft).toBe(500);
  });

  it("publishes a structural pinned-resize preview at the suspension threshold and restores it", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_PREVIEW_START",
        field: "name",
        headerName: "Preview start",
        valueType: "text" as const,
        width: 160,
        pinned: "start" as const,
      },
      {
        columnId: "COL_ID_PREVIEW_CENTER",
        field: "name",
        headerName: "Preview center",
        valueType: "text" as const,
        width: 160,
      },
      {
        columnId: "COL_ID_PREVIEW_END",
        field: "name",
        headerName: "Preview end",
        valueType: "text" as const,
        width: 140,
        pinned: "end" as const,
      },
    ]);
    const removeProperty = vi.fn();
    const setProperty = vi.fn();
    const hostSetProperty = vi.fn();
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 500,
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty, setProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    const publications = vi.fn();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    viewport.attachPinnedEditorHost({
      style: { removeProperty: vi.fn(), setProperty: hostSetProperty },
    } as unknown as HTMLElement);
    hostSetProperty.mockClear();
    viewport.subscribe(publications);
    const publicationsBeforePreview = publications.mock.calls.length;
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(1);

    viewport.previewColumnWidth("COL_ID_PREVIEW_START", 300);
    expect(hostSetProperty).toHaveBeenCalledWith(
      BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
      "0px",
    );
    expect(hostSetProperty).toHaveBeenLastCalledWith(
      BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
      "500px",
    );
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd).toHaveLength(0);
    expect(publications.mock.calls.length).toBeGreaterThan(publicationsBeforePreview);
    expect(setProperty).toHaveBeenCalledWith(
      brunoTableColumnCssVariable("width", "COL_ID_PREVIEW_START"),
      "300px",
    );

    const publicationsAfterSuspension = publications.mock.calls.length;
    viewport.previewColumnWidth("COL_ID_PREVIEW_START", 160);
    expect(publications.mock.calls.length).toBeGreaterThan(publicationsAfterSuspension);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart[0]?.columnId).toBe(
      "COL_ID_PREVIEW_START",
    );
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd[0]?.columnId).toBe("COL_ID_PREVIEW_END");

    hostSetProperty.mockClear();
    viewport.clearColumnWidthPreview();
    expect(hostSetProperty).toHaveBeenCalledWith(
      BRUNO_TABLE_VIEWPORT_LOGICAL_SCROLL_LEFT_CSS_VARIABLE,
      "0px",
    );
    expect(hostSetProperty).toHaveBeenLastCalledWith(
      BRUNO_TABLE_VIEWPORT_INLINE_SIZE_CSS_VARIABLE,
      "500px",
    );
    expect(viewport.getSnapshot().virtualWindow.pinnedStart[0]?.columnId).toBe(
      "COL_ID_PREVIEW_START",
    );
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd[0]?.columnId).toBe("COL_ID_PREVIEW_END");
    expect(removeProperty).toHaveBeenCalled();
  });

  it("keeps the leading utility gutter in pinned-start resize preview offsets", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_PREVIEW_GUTTER_START",
        field: "name",
        headerName: "Preview gutter start",
        valueType: "text",
        pinned: "start",
        width: 120,
      },
      {
        columnId: "COL_ID_PREVIEW_GUTTER_CENTER",
        field: "name",
        headerName: "Preview gutter center",
        valueType: "text",
        width: 120,
      },
    ]);
    const setProperty = vi.fn();
    const viewport = new BrunoTableViewportRuntime(36, 40);
    viewport.setLayout(2, columns);
    viewport.attach({
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 500,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty },
    } as unknown as HTMLElement);

    viewport.previewColumnWidth("COL_ID_PREVIEW_GUTTER_START", 160);

    expect(setProperty).toHaveBeenCalledWith(
      brunoTableColumnCssVariable("pinned-start-offset", "COL_ID_PREVIEW_GUTTER_START"),
      "40px",
    );
  });

  it("publishes one bounded structural preview when shrinking a wide centre exposes columns", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_WIDE_PREVIEW",
        field: "name",
        headerName: "Wide preview",
        valueType: "text" as const,
        width: 800,
      },
      ...Array.from({ length: 12 }, (_unused, index) => ({
        columnId: `COL_ID_EXPOSED_${String(index)}`,
        field: "name" as const,
        headerName: `Exposed ${String(index)}`,
        valueType: "text" as const,
        width: 100,
      })),
    ]);
    const setProperty = vi.fn();
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    const publications = vi.fn();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    viewport.subscribe(publications);

    expect(
      viewport.getSnapshot().virtualWindow.center.map(({ columnId }) => columnId),
    ).not.toContain("COL_ID_EXPOSED_4");

    viewport.previewColumnWidth("COL_ID_WIDE_PREVIEW", 100);

    const previewWindow = viewport.getSnapshot().virtualWindow;
    expect(previewWindow.center.map(({ columnId }) => columnId)).toContain("COL_ID_EXPOSED_3");
    expect(publications).toHaveBeenCalledTimes(1);
    expect(setProperty).toHaveBeenCalledWith(
      brunoTableColumnCssVariable("width", "COL_ID_WIDE_PREVIEW"),
      "100px",
    );
    expect(setProperty).toHaveBeenCalledWith(
      BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE,
      `${String(previewWindow.rightPadding)}px`,
    );

    const publicationCounts: number[] = [];
    for (const width of [90, 80, 70, 60]) {
      const publicationCountBeforePreview = publications.mock.calls.length;
      viewport.previewColumnWidth("COL_ID_WIDE_PREVIEW", width);
      publicationCounts.push(publications.mock.calls.length - publicationCountBeforePreview);
    }
    expect(publicationCounts).toEqual([0, 0, 1, 0]);
    expect(publicationCounts.every((count) => count <= 1)).toBe(true);
  });

  it("keeps preview padding aligned with the retained mounted slice when widening a centre column", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_WIDEN_PREVIEW",
        field: "name",
        headerName: "Widen preview",
        valueType: "text" as const,
        width: 100,
      },
      ...Array.from({ length: 12 }, (_unused, index) => ({
        columnId: `COL_ID_WIDENED_${String(index)}`,
        field: "name" as const,
        headerName: `Widened ${String(index)}`,
        valueType: "text" as const,
        width: 100,
      })),
    ]);
    const setProperty = vi.fn();
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    const publications = vi.fn();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    viewport.subscribe(publications);

    const mountedWindow = viewport.getSnapshot().virtualWindow;
    expect(mountedWindow.center.length).toBeGreaterThan(3);
    expect(mountedWindow.center[0]?.columnId).toBe("COL_ID_WIDEN_PREVIEW");

    viewport.previewColumnWidth("COL_ID_WIDEN_PREVIEW", 800);

    expect(publications).not.toHaveBeenCalled();
    const rightPaddingWrites = setProperty.mock.calls
      .filter(([property]) => property === BRUNO_TABLE_LIVE_RIGHT_PADDING_CSS_VARIABLE)
      .map(([, value]) => value);
    expect(rightPaddingWrites.at(-1)).toBe("800px");
  });

  it("does not force layout while applying a column-width preview", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_LAYOUT_FREE_PREVIEW",
        field: "name",
        headerName: "Layout-free preview",
        valueType: "text" as const,
        width: 100,
      },
    ]);
    let scrollWidthReads = 0;
    let scrollLeftWrites = 0;
    let scrollLeft = 0;
    let styleWritten = false;
    let postWriteGeometryReads = 0;
    const readGeometry = (value: number): number => {
      if (styleWritten) postWriteGeometryReads += 1;
      return value;
    };
    const element = {
      addEventListener: vi.fn(),
      get clientHeight() {
        return readGeometry(480);
      },
      get clientWidth() {
        return readGeometry(500);
      },
      get offsetHeight() {
        return readGeometry(500);
      },
      get offsetWidth() {
        return readGeometry(500);
      },
      get scrollWidth() {
        scrollWidthReads += 1;
        if (styleWritten) postWriteGeometryReads += 1;
        return 500;
      },
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      get scrollLeft() {
        if (styleWritten) postWriteGeometryReads += 1;
        return scrollLeft;
      },
      set scrollLeft(value: number) {
        scrollLeft = value;
        scrollLeftWrites += 1;
      },
      get scrollTop() {
        return readGeometry(0);
      },
      set scrollTop(_value: number) {},
      style: {
        removeProperty: vi.fn(),
        setProperty: vi.fn(() => {
          styleWritten = true;
        }),
      },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    const readsBeforePreview = scrollWidthReads;
    const writesBeforePreview = scrollLeftWrites;
    styleWritten = false;
    postWriteGeometryReads = 0;

    viewport.previewColumnWidth("COL_ID_LAYOUT_FREE_PREVIEW", 160);

    expect(scrollWidthReads).toBe(readsBeforePreview);
    expect(scrollLeftWrites).toBe(writesBeforePreview);
    expect(postWriteGeometryReads).toBe(0);
  });

  it.each(["reverse", "default"] as const)(
    "preserves logical position with a layout-free %s RTL preview write",
    (rtlType) => {
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn(() => 1),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const columns = compileColumns(
        Array.from({ length: 6 }, (_, index) => ({
          columnId: `COL_ID_RTL_PREVIEW_${String(index)}`,
          field: "name",
          headerName: `RTL preview ${String(index)}`,
          valueType: "text" as const,
          width: 160,
        })),
      );
      let scrollLeftWrites = 0;
      let scrollLeft = 0;
      let styleWritten = false;
      let postWriteGeometryReads = 0;
      const readGeometry = (value: number): number => {
        if (styleWritten) postWriteGeometryReads += 1;
        return value;
      };
      const setProperty = vi.fn(() => {
        styleWritten = true;
      });
      const element = {
        addEventListener: vi.fn(),
        get clientHeight() {
          return readGeometry(480);
        },
        get clientWidth() {
          return readGeometry(200);
        },
        get offsetHeight() {
          return readGeometry(500);
        },
        get offsetWidth() {
          return readGeometry(200);
        },
        get scrollWidth() {
          return readGeometry(960);
        },
        ownerDocument: createRtlOwnerDocument(rtlType),
        parentElement: null,
        removeEventListener: vi.fn(),
        get scrollLeft() {
          if (styleWritten) postWriteGeometryReads += 1;
          return scrollLeft;
        },
        set scrollLeft(value: number) {
          scrollLeft = value;
          scrollLeftWrites += 1;
        },
        get scrollTop() {
          return readGeometry(0);
        },
        set scrollTop(_value: number) {},
        style: {
          removeProperty: vi.fn(),
          setProperty,
        },
      } as unknown as HTMLElement;
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(2, columns);
      viewport.attach(element);
      expect(viewport.getSnapshot().virtualWindow.totalWidth).toBe(960);
      const initialMaximum = viewport.getSnapshot().virtualWindow.totalWidth - element.clientWidth;
      expect(viewport.scrollByLogical(rtlType === "reverse" ? -40 : 40)).toBe(true);
      const initialLogicalScrollLeft =
        rtlType === "reverse" ? initialMaximum - scrollLeft : scrollLeft;
      const writesBeforePreview = scrollLeftWrites;
      styleWritten = false;
      postWriteGeometryReads = 0;

      viewport.previewColumnWidth("COL_ID_RTL_PREVIEW_0", 220);

      const previewMaximum = initialMaximum + 60;
      const previewLogicalScrollLeft =
        rtlType === "reverse" ? previewMaximum - scrollLeft : scrollLeft;
      expect(setProperty).toHaveBeenCalledWith(
        brunoTableColumnCssVariable("width", "COL_ID_RTL_PREVIEW_0"),
        "220px",
      );
      expect(scrollLeftWrites).toBe(writesBeforePreview + 1);
      expect(previewLogicalScrollLeft).toBe(initialLogicalScrollLeft);
      expect(postWriteGeometryReads).toBe(0);
    },
  );

  it("clears an active width preview before replacing the viewport element", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_ATTACH_PREVIEW",
        field: "name",
        headerName: "Attach preview",
        valueType: "text" as const,
        width: 160,
      },
    ]);
    const oldRemoveProperty = vi.fn();
    const oldElement = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 500,
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: oldRemoveProperty, setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const newElement = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 500,
      ownerDocument: createRtlOwnerDocument("negative", () => "ltr"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(oldElement);
    viewport.previewColumnWidth("COL_ID_ATTACH_PREVIEW", 300);
    viewport.attach(newElement);

    expect(oldRemoveProperty).toHaveBeenCalledWith(
      brunoTableColumnCssVariable("width", "COL_ID_ATTACH_PREVIEW"),
    );
    expect(viewport.getSnapshot().virtualWindow.center[0]?.semantics.width).toBe(160);
  });

  it("refreshes computed direction before reveal after a CSS-only change", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CSS_DIRECTION_${index}`,
        field: "name",
        headerName: `CSS direction ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    let direction: "ltr" | "rtl" = "ltr";
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ownerDocument = createRtlOwnerDocument("negative", () => direction);
    const readComputedStyle = ownerDocument.defaultView!.getComputedStyle as ReturnType<
      typeof vi.fn
    >;
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 200,
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 320,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    expect(readComputedStyle).toHaveBeenCalledTimes(2);

    // Models CSSStyleSheet.insertRule(), which changes computed style without a DOM mutation.
    direction = "rtl";
    viewport.revealCell(0, "COL_ID_CSS_DIRECTION_7", "header");
    callbacks.shift()!(0);

    expect(readComputedStyle).toHaveBeenCalledTimes(3);
    expect(element.scrollLeft).toBe(-600);
    expect(
      viewport
        .getSnapshot()
        .virtualWindow.center.some(({ columnId }) => columnId === "COL_ID_CSS_DIRECTION_7"),
    ).toBe(true);

    viewport.revealCell(0, "COL_ID_CSS_DIRECTION_8", "header");
    callbacks.shift()!(0);
    expect(readComputedStyle).toHaveBeenCalledTimes(4);
  });

  it("decodes the first native input after a CSS-only direction change", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CSS_INPUT_${index}`,
        field: "name",
        headerName: `CSS input ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    let direction: "ltr" | "rtl" = "ltr";
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ownerDocument = createRtlOwnerDocument("negative", () => direction);
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 200,
      ownerDocument,
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 320,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    // Models a CSSStyleSheet.insertRule() direction change followed immediately by user input.
    direction = "rtl";
    element.scrollLeft = -600;
    scrollListener!(new Event("scroll"));
    callbacks.shift()!(0);

    expect(element.scrollLeft).toBe(-600);
    expect(viewport.getSnapshot().virtualWindow.center.map(({ columnId }) => columnId)).toContain(
      "COL_ID_CSS_INPUT_7",
    );
  });

  it("observes inherited direction changes on every ancestor", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_DIRECTION_OBSERVER",
        field: "name",
        headerName: "Direction observer",
        valueType: "text",
        width: 100,
      },
    ]);
    const observations: Array<{
      readonly target: Node;
      readonly options: MutationObserverInit;
    }> = [];
    vi.stubGlobal(
      "MutationObserver",
      class {
        public constructor(_callback: MutationCallback) {}
        public observe(target: Node, options: MutationObserverInit) {
          observations.push({ target, options });
        }
        public disconnect() {}
      },
    );
    const ownerDocument = createRtlOwnerDocument("negative", () => "ltr");
    const documentElement = ownerDocument.documentElement as HTMLElement & {
      parentElement: HTMLElement | null;
    };
    const body = ownerDocument.body as HTMLElement & { parentElement: HTMLElement | null };
    const explicitDirectionOwner = {
      hasAttribute: (name: string) => name === "dir",
      parentElement: body,
    } as unknown as HTMLElement;
    const intermediateOwner = {
      hasAttribute: () => false,
      parentElement: explicitDirectionOwner,
    } as unknown as HTMLElement;
    const directParent = {
      hasAttribute: () => false,
      parentElement: intermediateOwner,
    } as unknown as HTMLElement;
    body.parentElement = documentElement;
    documentElement.parentElement = null;
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 200,
      hasAttribute: () => false,
      ownerDocument,
      parentElement: directParent,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    expect(
      observations.find(({ target }) => target === directParent)?.options.attributeFilter,
    ).toEqual(["class", "dir", "style"]);
    expect(
      observations.find(({ target }) => target === intermediateOwner)?.options.attributeFilter,
    ).toEqual(["class", "dir", "style"]);
    expect(
      observations.find(({ target }) => target === explicitDirectionOwner)?.options.attributeFilter,
    ).toEqual(["class", "dir", "style"]);
    expect(observations.find(({ target }) => target === body)?.options.attributeFilter).toEqual([
      "class",
      "dir",
      "style",
    ]);
    expect(
      observations.find(({ target }) => target === documentElement)?.options.attributeFilter,
    ).toEqual(["class", "dir", "style"]);
    expect(observations.find(({ target }) => target === ownerDocument.head)?.options).toEqual({
      attributes: true,
      attributeFilter: ["disabled", "href", "media"],
      childList: true,
      characterData: true,
      subtree: true,
    });
  });

  it.each(["ltr", "reverse-rtl"] as const)(
    "preserves input sampled before a pin-suspending resize in %s",
    (direction) => {
      const columns = compileColumns([
        {
          columnId: "COL_ID_INPUT_RESIZE_START",
          field: "name",
          headerName: "Input resize start",
          pinned: "start",
          valueType: "text",
          width: 100,
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          columnId: `COL_ID_INPUT_RESIZE_CENTER_${index}`,
          field: "name",
          headerName: `Input resize center ${index}`,
          valueType: "text" as const,
          width: 100,
        })),
        {
          columnId: "COL_ID_INPUT_RESIZE_END",
          field: "name",
          headerName: "Input resize end",
          pinned: "end",
          valueType: "text",
          width: 100,
        },
      ]);
      const callbacks: FrameRequestCallback[] = [];
      let resize: (() => void) | undefined;
      let scrollListener: EventListener | undefined;
      let width = 300;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      vi.stubGlobal(
        "ResizeObserver",
        class {
          public constructor(callback: ResizeObserverCallback) {
            resize = () => callback([], this as unknown as ResizeObserver);
          }
          public observe() {}
          public disconnect() {}
        },
      );
      const element = {
        addEventListener: vi.fn((name: string, listener: EventListener) => {
          if (name === "scroll") scrollListener = listener;
        }),
        clientHeight: 480,
        get clientWidth() {
          return width;
        },
        ...(direction === "reverse-rtl"
          ? { ownerDocument: createRtlOwnerDocument("reverse"), parentElement: null }
          : {}),
        removeEventListener: vi.fn(),
        scrollLeft: direction === "reverse-rtl" ? 900 : 0,
        scrollTop: 0,
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      } as unknown as HTMLElement;
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(2, columns);
      viewport.attach(element);

      element.scrollLeft = direction === "reverse-rtl" ? 500 : 400;
      scrollListener!(new Event("scroll"));
      width = 260;
      resize!();
      callbacks.shift()!(0);

      expect(element.scrollLeft).toBe(direction === "reverse-rtl" ? 440 : 500);
      expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);
    },
  );

  it("preserves the logical offset when a reverse-RTL resize changes the maximum", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_REVERSE_RESIZE_${index}`,
        field: "name",
        headerName: `Reverse resize ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    let resize: (() => void) | undefined;
    let width = 200;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        public constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this as unknown as ResizeObserver);
        }
        public observe() {}
        public disconnect() {}
      },
    );
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      get clientWidth() {
        return width;
      },
      ownerDocument: createRtlOwnerDocument("reverse"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 500,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    width = 300;
    resize!();
    callbacks.shift()!(0);
    expect(element.scrollLeft).toBe(400);
  });

  it("keeps one reverse-RTL geometry generation across a simultaneous resize and layout change", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_COMBINED_${index}`,
        field: "name",
        headerName: `Combined ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const widerColumns = compileColumns(
      columns.map((column, index) => ({
        columnId: column.columnId,
        field: "name",
        headerName: column.headerName,
        valueType: "text" as const,
        width: index === columns.length - 1 ? 200 : 100,
      })),
    );
    let width = 200;
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      get clientWidth() {
        return width;
      },
      ownerDocument: createRtlOwnerDocument("reverse"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 500,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    width = 300;
    viewport.setLayout(2, widerColumns);

    expect(element.scrollLeft).toBe(500);
    expect(viewport.getSnapshot().virtualWindow.center.map((column) => column.columnId)).toContain(
      "COL_ID_COMBINED_3",
    );
  });

  it("defers a reverse-RTL widening write until the content extent commits", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_DEFERRED_REVERSE_0",
        field: "name",
        headerName: "Deferred reverse 0",
        valueType: "text",
        width: 100,
      },
    ]);
    const widerColumns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DEFERRED_REVERSE_${index}`,
        field: "name",
        headerName: `Deferred reverse ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const widestColumns = compileColumns(
      Array.from({ length: 12 }, (_, index) => ({
        columnId: `COL_ID_DEFERRED_REVERSE_${index}`,
        field: "name",
        headerName: `Deferred reverse ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    const clientWidth = 200;
    let committedScrollWidth = 200;
    let nativeScrollLeft = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth,
      ownerDocument: createRtlOwnerDocument("reverse"),
      parentElement: null,
      removeEventListener: vi.fn(),
      get scrollLeft() {
        return nativeScrollLeft;
      },
      set scrollLeft(value: number) {
        const committedMaximum = Math.max(committedScrollWidth - clientWidth, 0);
        nativeScrollLeft = Math.min(Math.max(value, 0), committedMaximum);
      },
      get scrollWidth() {
        return committedScrollWidth;
      },
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, initialColumns);
    viewport.attach(element);

    viewport.setLayout(2, widerColumns);
    viewport.setLayout(2, widestColumns);
    viewport.resetVertical();

    expect(element.scrollLeft).toBe(0);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe(
      "COL_ID_DEFERRED_REVERSE_0",
    );
    expect(callbacks).toHaveLength(1);

    callbacks.shift()!(0);

    expect(element.scrollLeft).toBe(0);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe(
      "COL_ID_DEFERRED_REVERSE_0",
    );
    expect(callbacks).toHaveLength(1);

    committedScrollWidth = 1_200;
    callbacks.shift()!(0);

    expect(element.scrollLeft).toBe(1_000);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe(
      "COL_ID_DEFERRED_REVERSE_0",
    );
  });

  it("bounds reverse-RTL reconciliation when the content extent never commits", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_BOUNDED_REVERSE_0",
        field: "name",
        headerName: "Bounded reverse 0",
        valueType: "text",
        width: 100,
      },
    ]);
    const widerColumns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_BOUNDED_REVERSE_${index}`,
        field: "name",
        headerName: `Bounded reverse ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const triggerResize = observeResizeTargets();
    const { callbacks, commitScrollWidth, element } = createDeferredReverseRtlHarness();
    const rowLayer = {
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, initialColumns);
    viewport.attach(element);
    viewport.attachRowLayer(rowLayer);

    viewport.setLayout(2, widerColumns);
    for (let frame = 0; frame < 16 && callbacks.length > 0; frame += 1) {
      callbacks.shift()!(frame);
    }

    expect(callbacks).toHaveLength(0);
    expect(element.scrollLeft).toBe(0);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe(
      "COL_ID_BOUNDED_REVERSE_0",
    );

    commitScrollWidth(1_000);
    triggerResize(rowLayer);
    callbacks.shift()!(17);

    expect(element.scrollLeft).toBe(800);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe(
      "COL_ID_BOUNDED_REVERSE_0",
    );
  });

  it("retries a reveal after deferred reverse-RTL layout reconciliation", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_DEFERRED_REVEAL_0",
        field: "name",
        headerName: "Deferred reveal 0",
        valueType: "text",
        width: 100,
      },
    ]);
    const widerColumns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DEFERRED_REVEAL_${index}`,
        field: "name",
        headerName: `Deferred reveal ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const triggerResize = observeResizeTargets();
    const { callbacks, commitScrollWidth, element } = createDeferredReverseRtlHarness();
    const rowLayer = {
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, initialColumns);
    viewport.attach(element);
    viewport.attachRowLayer(rowLayer);

    viewport.setLayout(2, widerColumns);
    viewport.revealCell(0, "COL_ID_DEFERRED_REVEAL_5", "header");
    for (let frame = 0; frame < 16 && callbacks.length > 0; frame += 1) {
      callbacks.shift()!(frame);
    }

    expect(callbacks).toHaveLength(0);
    expect(
      viewport.getSnapshot().virtualWindow.center.map(({ columnId }) => columnId),
    ).not.toContain("COL_ID_DEFERRED_REVEAL_5");

    commitScrollWidth(1_000);
    triggerResize(rowLayer);
    callbacks.shift()!(17);

    expect(viewport.getSnapshot().virtualWindow.center.map(({ columnId }) => columnId)).toContain(
      "COL_ID_DEFERRED_REVEAL_5",
    );
    expect(element.scrollLeft).toBe(400);
  });

  it("resolves a dirty reverse-RTL direction before classifying a widening write", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_DIRTY_REVERSE_0",
        field: "name",
        headerName: "Dirty reverse 0",
        valueType: "text",
        width: 100,
      },
    ]);
    const widerColumns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DIRTY_REVERSE_${index}`,
        field: "name",
        headerName: `Dirty reverse ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    const clientWidth = 200;
    let committedScrollWidth = 200;
    let direction: "ltr" | "rtl" = "ltr";
    let mutation: MutationCallback | undefined;
    let nativeScrollLeft = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "MutationObserver",
      class {
        public constructor(callback: MutationCallback) {
          mutation = callback;
        }
        public observe() {}
        public disconnect() {}
      },
    );
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth,
      ownerDocument: createRtlOwnerDocument("reverse", () => direction),
      parentElement: null,
      removeEventListener: vi.fn(),
      get scrollLeft() {
        return nativeScrollLeft;
      },
      set scrollLeft(value: number) {
        const committedMaximum = Math.max(committedScrollWidth - clientWidth, 0);
        nativeScrollLeft = Math.min(Math.max(value, 0), committedMaximum);
      },
      get scrollWidth() {
        return committedScrollWidth;
      },
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, initialColumns);
    viewport.attach(element);

    direction = "rtl";
    mutation!([], {} as MutationObserver);
    viewport.setLayout(2, widerColumns);

    expect(element.scrollLeft).toBe(0);
    expect(callbacks).toHaveLength(1);

    committedScrollWidth = 1_000;
    callbacks.shift()!(0);

    expect(element.scrollLeft).toBe(800);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe("COL_ID_DIRTY_REVERSE_0");
  });

  it("keeps post-layout reverse-RTL native input authoritative", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_DEFERRED_INPUT_0",
        field: "name",
        headerName: "Deferred input 0",
        valueType: "text",
        width: 100,
      },
    ]);
    const widerColumns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DEFERRED_INPUT_${index}`,
        field: "name",
        headerName: `Deferred input ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
    );
    const callbacks: FrameRequestCallback[] = [];
    const clientWidth = 200;
    let committedScrollWidth = 200;
    let mutation: MutationCallback | undefined;
    let nativeScrollLeft = 0;
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "MutationObserver",
      class {
        public constructor(callback: MutationCallback) {
          mutation = callback;
        }
        public observe() {}
        public disconnect() {}
      },
    );
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth,
      ownerDocument: createRtlOwnerDocument("reverse"),
      parentElement: null,
      removeEventListener: vi.fn(),
      get scrollLeft() {
        return nativeScrollLeft;
      },
      set scrollLeft(value: number) {
        const committedMaximum = Math.max(committedScrollWidth - clientWidth, 0);
        nativeScrollLeft = Math.min(Math.max(value, 0), committedMaximum);
      },
      get scrollWidth() {
        return committedScrollWidth;
      },
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, initialColumns);
    viewport.attach(element);
    viewport.setLayout(2, widerColumns);

    committedScrollWidth = 1_000;
    element.scrollLeft = 600;
    scrollListener!(new Event("scroll"));
    mutation!([], {} as MutationObserver);
    element.scrollLeft = 500;
    mutation!([], {} as MutationObserver);
    viewport.resetVertical();

    expect(element.scrollLeft).toBe(500);
    callbacks.shift()!(0);

    expect(element.scrollLeft).toBe(500);
    expect(viewport.getSnapshot().virtualWindow.center.map(({ columnId }) => columnId)).toContain(
      "COL_ID_DEFERRED_INPUT_3",
    );
  });

  it("projects a deferred reverse-RTL coordinate when resize suspends pinning", () => {
    const initialColumns = compileColumns([
      {
        columnId: "COL_ID_DEFERRED_PIN_START",
        field: "name",
        headerName: "Deferred pin start",
        pinned: "start",
        valueType: "text",
        width: 100,
      },
      {
        columnId: "COL_ID_DEFERRED_PIN_CENTER_0",
        field: "name",
        headerName: "Deferred pin center 0",
        valueType: "text",
        width: 100,
      },
      {
        columnId: "COL_ID_DEFERRED_PIN_END",
        field: "name",
        headerName: "Deferred pin end",
        pinned: "end",
        valueType: "text",
        width: 100,
      },
    ]);
    const widerColumns = compileColumns([
      {
        columnId: "COL_ID_DEFERRED_PIN_START",
        field: "name",
        headerName: "Deferred pin start",
        pinned: "start",
        valueType: "text",
        width: 100,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_DEFERRED_PIN_CENTER_${index}`,
        field: "name",
        headerName: `Deferred pin center ${index}`,
        valueType: "text" as const,
        width: 100,
      })),
      {
        columnId: "COL_ID_DEFERRED_PIN_END",
        field: "name",
        headerName: "Deferred pin end",
        pinned: "end",
        valueType: "text",
        width: 100,
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    let committedScrollWidth = 400;
    let nativeScrollLeft = 0;
    let resize: (() => void) | undefined;
    let width = 400;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        public constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this as unknown as ResizeObserver);
        }
        public observe() {}
        public disconnect() {}
      },
    );
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      get clientWidth() {
        return width;
      },
      ownerDocument: createRtlOwnerDocument("reverse"),
      parentElement: null,
      removeEventListener: vi.fn(),
      get scrollLeft() {
        return nativeScrollLeft;
      },
      set scrollLeft(value: number) {
        const committedMaximum = Math.max(committedScrollWidth - width, 0);
        nativeScrollLeft = Math.min(Math.max(value, 0), committedMaximum);
      },
      get scrollWidth() {
        return committedScrollWidth;
      },
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, initialColumns);
    viewport.attach(element);

    viewport.setLayout(2, widerColumns);
    width = 260;
    resize!();
    viewport.resetVertical();

    expect(element.scrollLeft).toBe(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd).toHaveLength(0);

    committedScrollWidth = 1_200;
    callbacks.shift()!(0);

    expect(element.scrollLeft).toBe(840);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd).toHaveLength(0);
  });

  it.each(["ltr", "reverse-rtl"] as const)(
    "keeps latest native input authoritative across a simultaneous resize and layout change in %s",
    (direction) => {
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn(() => 1),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const columns = compileColumns(
        Array.from({ length: 10 }, (_, index) => ({
          columnId: `COL_ID_INPUT_${index}`,
          field: "name",
          headerName: `Input ${index}`,
          valueType: "text" as const,
          width: 100,
        })),
      );
      const widerColumns = compileColumns(
        columns.map((column, index) => ({
          columnId: column.columnId,
          field: "name",
          headerName: column.headerName,
          valueType: "text" as const,
          width: index === columns.length - 1 ? 200 : 100,
        })),
      );
      let width = 200;
      let scrollListener: EventListener | undefined;
      const element = {
        addEventListener: vi.fn((name: string, listener: EventListener) => {
          if (name === "scroll") scrollListener = listener;
        }),
        clientHeight: 480,
        get clientWidth() {
          return width;
        },
        ...(direction === "reverse-rtl"
          ? { ownerDocument: createRtlOwnerDocument("reverse"), parentElement: null }
          : {}),
        removeEventListener: vi.fn(),
        scrollLeft: direction === "reverse-rtl" ? 480 : 320,
        scrollTop: 0,
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      } as unknown as HTMLElement;
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(2, columns);
      viewport.attach(element);

      width = 300;
      element.scrollLeft = direction === "reverse-rtl" ? 220 : 480;
      scrollListener!(new Event("scroll"));
      viewport.setLayout(2, widerColumns);

      expect(element.scrollLeft).toBe(direction === "reverse-rtl" ? 320 : 480);
      expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBeGreaterThan(1);
    },
  );

  it("keeps the native horizontal coordinate when the pinning structure changes", () => {
    const pinnedColumns = compileColumns([
      {
        columnId: "COL_ID_START",
        field: "name",
        headerName: "Start",
        pinned: "start",
        valueType: "text",
        width: 100,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_CENTER_${String(index)}`,
        field: "name",
        headerName: `Center ${String(index)}`,
        valueType: "text" as const,
        width: 100,
      })),
    ]);
    const unpinnedColumns = compileColumns(
      pinnedColumns.map((column) => ({
        columnId: column.columnId,
        field: "name",
        headerName: column.headerName,
        valueType: "text" as const,
        width: column.semantics.width,
      })),
    );
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 100,
      removeEventListener: vi.fn(),
      scrollLeft: 420,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, pinnedColumns);
    viewport.attach(element);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(0);

    viewport.setLayout(100, unpinnedColumns);

    expect(element.scrollLeft).toBe(420);
  });

  it("rebases a queued identity-owned reveal when a same-shape row space is published", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);

    viewport.revealCell(75, "COL_ID_NAME", "body", "row-75");
    viewport.setLayout(100, columns, (rowId) => (rowId === "row-75" ? 50 : undefined));
    callback!(0);

    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(30);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeLessThan(40);
  });

  it("preserves a queued index-only reveal across a layout publication", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);

    viewport.revealCell(75, "COL_ID_NAME");
    viewport.setLayout(101, columns);
    callback!(0);

    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(50);
  });

  it("keeps a thousand-column horizontal window bounded", () => {
    const columns = compileColumns(
      Array.from({ length: 1_000 }, (_, index) => ({
        columnId: `COL_ID_STRESS_${String(index).padStart(4, "0")}`,
        field: "name",
        headerName: `Stress ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    let callback: FrameRequestCallback | undefined;
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);

    const initial = viewport.getSnapshot().virtualWindow;
    expect(initial.centerCount).toBe(1_000);
    expect(initial.center.length).toBeLessThanOrEqual(12);
    expect(initial.totalWidth).toBe(120_000);

    element.scrollLeft = 60_000;
    scrollListener!(new Event("scroll"));
    callback!(0);
    const middle = viewport.getSnapshot().virtualWindow;
    expect(middle.centerStartIndex).toBeGreaterThan(490);
    expect(middle.centerStartIndex).toBeLessThan(510);
    expect(middle.center.length).toBeLessThanOrEqual(12);
  });

  it("publishes one adjacent centre window atomically to headers and every mounted row", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_INCREMENTAL_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Incremental ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    const previous = viewport.getSnapshot().virtualWindow;
    const renderListener = vi.fn();
    const columnWindowListener = vi.fn(() => {
      expect(viewport.getColumnWindowSnapshot().center).toBe(
        viewport.getSnapshot().virtualWindow.center,
      );
    });
    const viewportListener = vi.fn();
    const rowRangeListener = vi.fn(() => {
      const authoritativeWindow = viewport.getSnapshot().virtualWindow;
      expect(viewport.getRowRangeSnapshot()).toMatchObject({
        rowEnd: authoritativeWindow.rowEnd,
        rowStart: authoritativeWindow.rowStart,
      });
    });
    viewport.subscribeRender(renderListener);
    viewport.subscribeColumnWindow(columnWindowListener);
    viewport.subscribe(viewportListener);
    viewport.subscribeRowRange(rowRangeListener);
    const rowNotifications = Array.from(
      { length: previous.rowEnd - previous.rowStart },
      (_, offset) => {
        const listener = vi.fn();
        viewport.subscribeBodyRowColumnWindow(previous.rowStart + offset, listener);
        return listener;
      },
    );
    element.scrollLeft += 120;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    const firstBatch = viewport.getSnapshot().virtualWindow;
    expect(firstBatch.centerStartIndex).toBe(previous.centerStartIndex + 1);
    expect(firstBatch.center.length).toBe(previous.center.length);
    expect(viewportListener).toHaveBeenCalledOnce();
    expect(columnWindowListener).not.toHaveBeenCalled();
    expect(renderListener).not.toHaveBeenCalled();
    expect(rowRangeListener).not.toHaveBeenCalled();
    expect(viewport.getColumnWindowSnapshot().center).toBe(previous.center);
    expect(
      Array.from({ length: previous.rowEnd - previous.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(previous.rowStart + offset),
      ).every((window) => window.center === viewport.getColumnWindowSnapshot().center),
    ).toBe(true);
    expect(rowNotifications.every((listener) => listener.mock.calls.length === 0)).toBe(true);

    runNextFrame(frames);
    const firstPreparedRow = viewport.getBodyRowColumnWindowSnapshot(previous.rowStart);
    expect(firstPreparedRow.center).toBe(previous.center);
    expect(firstPreparedRow.preparedCenter).toBeDefined();
    expect(firstPreparedRow.preparedSourceCenterStartIndex).toBe(previous.centerStartIndex);
    expect(firstPreparedRow.preparedSourceCenterEndIndex).toBe(
      previous.centerStartIndex + previous.center.length,
    );
    expect(rowNotifications[0]).toHaveBeenCalledOnce();
    expect(columnWindowListener).not.toHaveBeenCalled();

    advanceFramesUntil(frames, () => columnWindowListener.mock.calls.length === 1);
    expect(viewport.getColumnWindowSnapshot().center).toBe(firstBatch.center);
    const promotedPreparedRow = viewport.getBodyRowColumnWindowSnapshot(previous.rowStart);
    expect(promotedPreparedRow.preparedSourceCenterStartIndex).toBe(previous.centerStartIndex);
    expect(promotedPreparedRow.preparedSourceCenterEndIndex).toBe(
      previous.centerStartIndex + previous.center.length,
    );
    expect(
      Array.from({ length: previous.rowEnd - previous.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(previous.rowStart + offset),
      ).every((window) => window.center === firstBatch.center),
    ).toBe(true);

    drainFrames(frames);
    expect(
      Array.from({ length: previous.rowEnd - previous.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(previous.rowStart + offset),
      ).every((window) => window === viewport.getColumnWindowSnapshot()),
    ).toBe(true);
    expect(rowNotifications.every((listener) => listener.mock.calls.length === 2)).toBe(true);
    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBe(
      previous.centerStartIndex + 1,
    );
  });

  it("prepares programmatic horizontal scrolling in bounded row batches before promotion", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_PROGRAMMATIC_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Programmatic ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    const removeProperty = vi.fn();
    const setProperty = vi.fn();
    const rootSetProperty = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: rootSetProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);
    viewport.attachBodyLayer({ style: { removeProperty, setProperty } } as unknown as HTMLElement);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    const previous = viewport.getSnapshot().virtualWindow;
    const rowNotifications = Array.from(
      { length: previous.rowEnd - previous.rowStart },
      (_, offset) => {
        const listener = vi.fn();
        viewport.subscribeBodyRowColumnWindow(previous.rowStart + offset, listener);
        return listener;
      },
    );
    const columnWindowListener = vi.fn();
    viewport.subscribeColumnWindow(columnWindowListener);

    expect(viewport.scrollByLogical(120)).toBe(true);
    runNextFrame(frames);

    const target = viewport.getSnapshot().virtualWindow;
    expect(target.centerStartIndex).toBe(previous.centerStartIndex + 1);
    expect(viewport.getColumnWindowSnapshot().center).toBe(previous.center);
    expect(rowNotifications[0]).toHaveBeenCalledOnce();
    expect(rowNotifications[1]).toHaveBeenCalledOnce();
    expect(rowNotifications[2]).toHaveBeenCalledOnce();
    expect(rowNotifications[3]).toHaveBeenCalledOnce();
    expect(rowNotifications[4]).not.toHaveBeenCalled();
    expect(viewport.getBodyRowColumnWindowSnapshot(previous.rowStart).preparedCenter).toBeDefined();

    advanceFramesUntil(frames, () => columnWindowListener.mock.calls.length === 1);
    expect(viewport.getColumnWindowSnapshot().center).toBe(target.center);
    expect(setProperty).toHaveBeenCalledWith(
      "--bruno-table-prepared-entering-display",
      "table-cell",
    );
    expect(setProperty).toHaveBeenCalledWith("--bruno-table-prepared-retiring-display", "none");
    expect(
      rootSetProperty.mock.calls.some(([property]) =>
        String(property).startsWith("--bruno-table-prepared-"),
      ),
    ).toBe(false);
    const lateSetProperty = vi.fn();
    const lateRemoveProperty = vi.fn();
    const detachLate = viewport.attachBodyLayer({
      style: { setProperty: lateSetProperty, removeProperty: lateRemoveProperty },
    } as unknown as HTMLElement);
    expect(lateSetProperty).toHaveBeenCalledWith(
      "--bruno-table-prepared-entering-display",
      "table-cell",
    );
    detachLate?.();
    expect(lateRemoveProperty).toHaveBeenCalledWith("--bruno-table-prepared-left-padding");
    expect(setProperty).toHaveBeenCalledWith(
      "--bruno-table-prepared-left-padding",
      `${String(target.leftPadding)}px`,
    );
    expect(setProperty).toHaveBeenCalledWith(
      "--bruno-table-prepared-right-padding",
      `${String(target.rightPadding)}px`,
    );

    drainFrames(frames);
    expect(
      Array.from({ length: target.rowEnd - target.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(target.rowStart + offset),
      ).every((window) => window === viewport.getColumnWindowSnapshot()),
    ).toBe(true);
    expect(removeProperty).toHaveBeenCalledWith("--bruno-table-prepared-left-padding");
    expect(removeProperty).toHaveBeenCalledWith("--bruno-table-prepared-right-padding");
  });

  it("prepares rows mounted by a vertical scroll before promoting a horizontal window", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_VERTICAL_RACE_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Vertical race ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 360,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(200, columns);
    viewport.attach(element);
    drainFrames(frames);

    const preparation = () =>
      (
        viewport as unknown as {
          bodyColumnPreparation?: {
            readonly phase: "cleanup" | "prepare" | "promote";
            readonly preparedRows: ReadonlySet<number>;
          };
        }
      ).bodyColumnPreparation;
    const columnWindowListener = vi.fn();
    viewport.subscribeColumnWindow(columnWindowListener);
    expect(viewport.scrollByLogical(120)).toBe(true);
    runNextFrame(frames);
    advanceFramesUntil(frames, () => preparation()?.phase === "promote");
    const originalRange = viewport.getRowRangeSnapshot();

    element.scrollTop = 800;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);

    const movedRange = viewport.getRowRangeSnapshot();
    expect(movedRange.rowStart).toBeGreaterThan(originalRange.rowStart);
    expect(columnWindowListener).not.toHaveBeenCalled();
    runNextFrame(frames);
    expect(preparation()?.phase).not.toBe("cleanup");
    expect(
      [...(preparation()?.preparedRows ?? [])].every(
        (rowIndex) => rowIndex >= movedRange.rowStart && rowIndex < movedRange.rowEnd,
      ),
    ).toBe(true);

    drainFrames(frames);
    expect(columnWindowListener).toHaveBeenCalledOnce();
    expect(
      Array.from({ length: movedRange.rowEnd - movedRange.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(movedRange.rowStart + offset),
      ).every((window) => window === viewport.getColumnWindowSnapshot()),
    ).toBe(true);
  });

  it("finishes a promoted preparation coherently before an adjacent target supersedes it", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_SUPERSEDE_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Supersede ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    const removeProperty = vi.fn();
    const setProperty = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 360,
      scrollTop: 0,
      style: { removeProperty, setProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);
    drainFrames(frames);

    expect(viewport.scrollByLogical(120)).toBe(true);
    runNextFrame(frames);
    const firstTarget = viewport.getSnapshot().virtualWindow;
    const columnWindowListener = vi.fn();
    viewport.subscribeColumnWindow(columnWindowListener);
    advanceFramesUntil(frames, () => columnWindowListener.mock.calls.length === 1);
    expect(viewport.getColumnWindowSnapshot().center).toBe(firstTarget.center);
    setProperty.mockClear();
    removeProperty.mockClear();

    expect(viewport.scrollByLogical(120)).toBe(true);
    runNextFrame(frames);

    expect(setProperty).not.toHaveBeenCalled();
    expect(removeProperty).not.toHaveBeenCalled();
    expect(viewport.getColumnWindowSnapshot().center).toBe(firstTarget.center);

    drainFrames(frames);
    expect(viewport.getColumnWindowSnapshot().center).toBe(
      viewport.getSnapshot().virtualWindow.center,
    );
  });

  it("settles a matching pending target when its committed window loses visible coverage", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_COVERAGE_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Coverage ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 360,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);
    drainFrames(frames);

    expect(viewport.scrollByLogical(120)).toBe(true);
    runNextFrame(frames);
    const pendingTarget = viewport.getSnapshot().virtualWindow;
    expect(viewport.getColumnWindowSnapshot().center).not.toBe(pendingTarget.center);

    const reconcileBodyColumnWindow = (
      viewport as unknown as {
        reconcileBodyColumnWindow: (
          window: BrunoTableVirtualWindow,
          allowPreparation: boolean,
          currentWindowCoversViewport: boolean,
        ) => boolean;
      }
    ).reconcileBodyColumnWindow.bind(viewport);
    expect(reconcileBodyColumnWindow(pendingTarget, false, false)).toBe(true);

    expect(viewport.getColumnWindowSnapshot().center).toBe(
      viewport.getSnapshot().virtualWindow.center,
    );
    expect(
      viewport.getBodyRowColumnWindowSnapshot(pendingTarget.rowStart).preparedCenter,
    ).toBeUndefined();
  });

  it("keeps a replacement row-window subscriber after an old unsubscribe repeats", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_IDEMPOTENT_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Idempotent ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);
    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    const rowIndex = viewport.getSnapshot().virtualWindow.rowStart;
    const unsubscribeOld = viewport.subscribeBodyRowColumnWindow(rowIndex, vi.fn());
    unsubscribeOld();
    const replacementListener = vi.fn();
    viewport.subscribeBodyRowColumnWindow(rowIndex, replacementListener);

    unsubscribeOld();
    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    advanceFramesUntil(frames, () => replacementListener.mock.calls.length === 1);

    expect(replacementListener).toHaveBeenCalledOnce();
  });

  it("publishes a joint row-range and centre-window update from one coherent snapshot", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_JOINT_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Joint ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(80, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    element.scrollTop = 1_440;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    const previous = viewport.getSnapshot().virtualWindow;
    const viewportListener = vi.fn();
    const rowRangeListener = vi.fn();
    const columnWindowListener = vi.fn();
    const rowNotifications = Array.from(
      { length: previous.rowEnd - previous.rowStart },
      (_, offset) => {
        const listener = vi.fn();
        viewport.subscribeBodyRowColumnWindow(previous.rowStart + offset, listener);
        return listener;
      },
    );
    viewport.subscribe(viewportListener);
    viewport.subscribeRowRange(rowRangeListener);
    viewport.subscribeColumnWindow(columnWindowListener);

    element.scrollLeft = 480;
    element.scrollTop = 1_504;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);

    const next = viewport.getSnapshot().virtualWindow;
    expect(next.centerStartIndex).toBe(previous.centerStartIndex + 1);
    expect(next.rowStart).toBe(previous.rowStart + 1);
    expect(viewportListener).toHaveBeenCalledOnce();
    expect(rowRangeListener).toHaveBeenCalledOnce();
    expect(columnWindowListener).not.toHaveBeenCalled();
    expect(viewport.getColumnWindowSnapshot().center).toBe(previous.center);
    expect(
      Array.from({ length: next.rowEnd - next.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(next.rowStart + offset),
      ).every((window) => window.center === previous.center),
    ).toBe(true);

    advanceFramesUntil(frames, () => columnWindowListener.mock.calls.length === 1);
    expect(viewport.getColumnWindowSnapshot().center).toBe(next.center);
    expect(
      Array.from({ length: next.rowEnd - next.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(next.rowStart + offset),
      ).every((window) => window.center === next.center),
    ).toBe(true);
    drainFrames(frames);
    expect(
      Array.from({ length: next.rowEnd - next.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(next.rowStart + offset),
      ).every((window) => window === viewport.getColumnWindowSnapshot()),
    ).toBe(true);
    expect(rowNotifications.some((listener) => listener.mock.calls.length > 0)).toBe(true);
  });

  it("atomically supersedes adjacent centre windows", () => {
    const columns = compileColumns(
      Array.from({ length: 40 }, (_, index) => ({
        columnId: `COL_ID_ADJACENT_SUPERSEDE_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Adjacent supersede ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    const initial = viewport.getSnapshot().virtualWindow;
    const initialHeaderWindow = viewport.getHeaderColumnWindowSnapshot();
    const headerColumnWindowListener = vi.fn();
    viewport.subscribeHeaderColumnWindow(headerColumnWindowListener);
    const columnWindowListener = vi.fn();
    viewport.subscribeColumnWindow(columnWindowListener);
    const rowNotifications = Array.from(
      { length: initial.rowEnd - initial.rowStart },
      (_, offset) => {
        const listener = vi.fn();
        viewport.subscribeBodyRowColumnWindow(initial.rowStart + offset, listener);
        return listener;
      },
    );

    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    expect(columnWindowListener).not.toHaveBeenCalled();

    element.scrollLeft = 600;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    expect(columnWindowListener).not.toHaveBeenCalled();
    advanceFramesUntil(frames, () => columnWindowListener.mock.calls.length === 1);
    expect(viewport.getColumnWindowSnapshot().centerStartIndex).toBe(initial.centerStartIndex + 1);
    expect(viewport.getHeaderColumnWindowSnapshot()).toBe(initialHeaderWindow);
    expect(headerColumnWindowListener).not.toHaveBeenCalled();
    drainFrames(frames);
    expect(columnWindowListener).toHaveBeenCalledTimes(2);
    expect(rowNotifications.every((listener) => listener.mock.calls.length === 4)).toBe(true);
    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBe(
      initial.centerStartIndex + 2,
    );
    expect(
      Array.from({ length: initial.rowEnd - initial.rowStart }, (_, offset) =>
        viewport.getBodyRowColumnWindowSnapshot(initial.rowStart + offset),
      ).every((window) => window === viewport.getColumnWindowSnapshot()),
    ).toBe(true);
  });

  it("keeps every mounted row covering visible columns during continuous adjacent scrolling", () => {
    const columns = compileColumns(
      Array.from({ length: 40 }, (_, index) => ({
        columnId: `COL_ID_CONTINUOUS_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Continuous ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    const outward = Array.from({ length: 17 }, (_, index) => index + 3);
    for (const column of [...outward, ...outward.toReversed().slice(1)]) {
      element.scrollLeft = column * 120;
      scrollListener!(new Event("scroll"));
      runNextFrame(frames);
      drainFrames(frames);
      const window = viewport.getSnapshot().virtualWindow;
      for (let row = window.rowStart; row < window.rowEnd; row += 1) {
        const body = viewport.getBodyRowColumnWindowSnapshot(row);
        expect(body).toBe(viewport.getColumnWindowSnapshot());
        expect(body.centerStartIndex).toBeLessThanOrEqual(column);
        expect(body.centerStartIndex + body.center.length).toBeGreaterThanOrEqual(column + 2);
      }
    }
    viewport.dispose();
  });

  it("atomically replaces the shared centre window after a large jump", () => {
    const columns = compileColumns(
      Array.from({ length: 40 }, (_, index) => ({
        columnId: `COL_ID_SUPERSEDE_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Supersede ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    runNextFrame(frames);
    const pendingRow = viewport.getSnapshot().virtualWindow.rowStart;
    const pendingWindow = viewport.getBodyRowColumnWindowSnapshot(pendingRow);
    const pendingListener = vi.fn();
    viewport.subscribeBodyRowColumnWindow(pendingRow, pendingListener);

    element.scrollLeft = 2_400;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    expect(viewport.getBodyRowColumnWindowSnapshot(pendingRow)).not.toBe(pendingWindow);
    expect(pendingListener).toHaveBeenCalledOnce();
    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBeGreaterThan(10);
    expect(frames).toHaveLength(0);
  });

  it("disposes a pending viewport publication without notifying retired row subscribers", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_DISPOSE_TRANSITION_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Dispose transition ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    frames.shift()!(0);
    const rowIndex = viewport.getSnapshot().virtualWindow.rowStart;
    const rowListener = vi.fn();
    viewport.subscribeBodyRowColumnWindow(rowIndex, rowListener);
    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    expect(frames).toHaveLength(1);

    viewport.dispose();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    frames.shift()!(0);
    expect(rowListener).not.toHaveBeenCalled();
    expect(viewport.getBodyRowColumnWindowSnapshot(rowIndex)).toBe(
      viewport.getColumnWindowSnapshot(),
    );
  });

  it("atomically replaces the shared centre window before revealing a distant column", () => {
    const columns = compileColumns(
      Array.from({ length: 40 }, (_, index) => ({
        columnId: `COL_ID_TRANSITION_REVEAL_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Transition reveal ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    drainFrames(frames);
    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    runNextFrame(frames);
    runNextFrame(frames);
    const pendingRow = viewport.getSnapshot().virtualWindow.rowStart;
    const pendingWindow = viewport.getBodyRowColumnWindowSnapshot(pendingRow);
    const pendingListener = vi.fn();
    viewport.subscribeBodyRowColumnWindow(pendingRow, pendingListener);

    viewport.revealCell(0, "COL_ID_TRANSITION_REVEAL_30", "header");
    runNextFrame(frames);
    const revealed = viewport.getSnapshot().virtualWindow;
    expect(viewport.getBodyRowColumnWindowSnapshot(pendingRow)).not.toBe(pendingWindow);
    expect(pendingListener).toHaveBeenCalledOnce();
    expect(
      revealed.center.some((column) => column.columnId === "COL_ID_TRANSITION_REVEAL_30"),
    ).toBe(true);
  });

  it("publishes one adjacent shared window in negative RTL coordinates", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_INCREMENTAL_RTL_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Incremental RTL ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      ownerDocument: createRtlOwnerDocument("negative"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 2_400,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(40, columns);
    viewport.attach(element);

    element.scrollLeft = -360;
    scrollListener!(new Event("scroll"));
    frames.shift()!(0);
    const previous = viewport.getSnapshot().virtualWindow;
    element.scrollLeft = -480;
    scrollListener!(new Event("scroll"));
    frames.shift()!(0);

    expect(viewport.getSnapshot().virtualWindow.centerStartIndex).toBe(
      previous.centerStartIndex + 1,
    );
    expect(viewport.getBodyRowColumnWindowSnapshot(previous.rowStart)).toBe(
      viewport.getColumnWindowSnapshot(),
    );
  });

  it("preserves the shared centre window through a vertical-only publication", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_INCREMENTAL_VERTICAL_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Incremental vertical ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const frames: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(200, columns);
    viewport.attach(element);

    element.scrollLeft = 360;
    scrollListener!(new Event("scroll"));
    frames.shift()!(0);
    element.scrollLeft = 480;
    scrollListener!(new Event("scroll"));
    frames.shift()!(0);
    const beforeVertical = viewport.getSnapshot().virtualWindow;
    const previousBodyWindow = viewport.getBodyRowColumnWindowSnapshot(beforeVertical.rowStart);
    const renderListener = vi.fn();
    const columnWindowListener = vi.fn();
    const rowRangeListener = vi.fn();
    viewport.subscribeRender(renderListener);
    viewport.subscribeColumnWindow(columnWindowListener);
    viewport.subscribeRowRange(rowRangeListener);

    element.scrollTop = 360;
    scrollListener!(new Event("scroll"));
    frames.shift()!(0);
    const afterVertical = viewport.getSnapshot().virtualWindow;
    expect(afterVertical.rowStart).toBeGreaterThan(beforeVertical.rowStart);
    expect(renderListener).not.toHaveBeenCalled();
    expect(columnWindowListener).not.toHaveBeenCalled();
    expect(rowRangeListener).toHaveBeenCalledOnce();
    expect(viewport.getBodyRowColumnWindowSnapshot(afterVertical.rowStart)).toBe(
      previousBodyWindow,
    );
    expect(viewport.getBodyRowColumnWindowSnapshot(afterVertical.rowEnd - 1)).toBe(
      viewport.getColumnWindowSnapshot(),
    );
  });

  it("publishes off-screen column-count changes that preserve visible geometry", () => {
    const columns = compileColumns(
      Array.from({ length: 10 }, (_, index) => ({
        columnId: `COL_ID_REPLACE_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Replace ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    const replacementTail = compileColumns([
      {
        columnId: "COL_ID_REPLACEMENT_TAIL",
        field: "name",
        headerName: "Replacement tail",
        valueType: "text",
        width: 240,
      },
    ]);
    const replacementColumns = Object.freeze([...columns.slice(0, 8), ...replacementTail]);
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    const initial = viewport.getSnapshot().virtualWindow;
    expect(initial).toMatchObject({ centerCount: 10, totalWidth: 1_200 });
    const listener = vi.fn();
    viewport.subscribe(listener);

    viewport.setLayout(2, replacementColumns);

    expect(listener).toHaveBeenCalledOnce();
    expect(viewport.getSnapshot().virtualWindow).toMatchObject({
      centerStartIndex: 0,
      centerCount: 9,
      totalWidth: 1_200,
    });
    expect(viewport.getSnapshot().virtualWindow.center).toEqual(initial.center);
  });

  it("virtualizes and reveals across a suspended many-column pinned layout", () => {
    const columns = compileColumns([
      ...Array.from({ length: 30 }, (_, index) => ({
        columnId: `COL_ID_START_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Start ${index}`,
        valueType: "text" as const,
        pinned: "start" as const,
        width: 120,
      })),
      {
        columnId: "COL_ID_CENTER",
        field: "name",
        headerName: "Center",
        valueType: "text",
        width: 120,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        columnId: `COL_ID_END_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `End ${index}`,
        valueType: "text" as const,
        pinned: "end" as const,
        width: 120,
      })),
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);

    expect(viewport.getSnapshot().virtualWindow).toMatchObject({
      pinnedStart: [],
      pinnedEnd: [],
      centerCount: 61,
      totalWidth: 7_320,
    });
    expect(viewport.getSnapshot().virtualWindow.center.length).toBeLessThan(10);

    viewport.attach(element);

    expect(viewport.getSnapshot().virtualWindow).toMatchObject({
      pinnedStart: [],
      pinnedEnd: [],
      centerCount: 61,
      totalWidth: 7_320,
    });
    expect(viewport.getSnapshot().virtualWindow.center.length).toBeLessThan(10);

    viewport.revealCell(0, "COL_ID_END_29", "header");
    callback!(0);
    expect(element.scrollLeft).toBe(7_080);
    expect(viewport.getSnapshot().virtualWindow.center.length).toBeLessThan(10);
    expect(viewport.getSnapshot().virtualWindow.center.at(-1)?.columnId).toBe("COL_ID_END_29");

    viewport.revealCell(0, "COL_ID_START_00", "header");
    callback!(0);
    expect(element.scrollLeft).toBe(0);
    expect(viewport.getSnapshot().virtualWindow.center[0]?.columnId).toBe("COL_ID_START_00");
  });

  it("suspends at 79px and restores pinning at the exact 80px centre threshold", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_START",
        field: "name",
        headerName: "Start",
        valueType: "text",
        pinned: "start",
        width: 180,
      },
      {
        columnId: "COL_ID_CENTER",
        field: "name",
        headerName: "Center",
        valueType: "text",
        width: 120,
      },
      {
        columnId: "COL_ID_END",
        field: "name",
        headerName: "End",
        valueType: "text",
        pinned: "end",
        width: 180,
      },
    ]);
    const snapshotAtWidth = (clientWidth: number) => {
      const viewport = new BrunoTableViewportRuntime();
      viewport.setLayout(2, columns);
      viewport.attach({
        addEventListener: vi.fn(),
        clientHeight: 480,
        clientWidth,
        removeEventListener: vi.fn(),
        scrollLeft: 0,
        scrollTop: 0,
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
      } as unknown as HTMLElement);
      return viewport.getSnapshot().virtualWindow;
    };

    expect(snapshotAtWidth(439)).toMatchObject({
      pinnedStart: [],
      pinnedEnd: [],
      centerCount: 3,
    });
    expect(snapshotAtWidth(440)).toMatchObject({
      centerCount: 1,
    });
    expect(snapshotAtWidth(440).pinnedStart).toHaveLength(1);
    expect(snapshotAtWidth(440).pinnedEnd).toHaveLength(1);
  });

  it("subtracts a leading utility gutter before pinning and exact reveal geometry", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_START_UTILITY",
        field: "name",
        headerName: "Start utility",
        valueType: "text",
        pinned: "start",
        width: 180,
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        columnId: `COL_ID_CENTER_UTILITY_${String(index)}`,
        field: "name",
        headerName: `Center utility ${String(index)}`,
        valueType: "text" as const,
        width: 120,
      })),
      {
        columnId: "COL_ID_END_UTILITY",
        field: "name",
        headerName: "End utility",
        valueType: "text",
        pinned: "end",
        width: 180,
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 480,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime(36, 40);
    viewport.setLayout(2, columns);
    viewport.attach(element);
    const scrollbarProperties = new Map<string, string>();
    viewport.attachScrollbarOverlay({
      style: {
        setProperty: (property: string, value: string) => {
          scrollbarProperties.set(property, value);
        },
      },
    } as unknown as HTMLElement);

    expect(viewport.getSnapshot()).toMatchObject({ width: 440 });
    expect(viewport.getSnapshot().virtualWindow).toMatchObject({
      pinningSuspended: false,
      centerCount: 6,
    });
    expect(scrollbarProperties.get("--bruno-table-scrollbar-horizontal-start")).toBe("220px");

    viewport.revealCell(0, "COL_ID_CENTER_UTILITY_5", "header");
    callback!(0);
    expect(element.scrollLeft).toBe(600);
    expect(viewport.getSnapshot().virtualWindow.center.at(-1)?.columnId).toBe(
      "COL_ID_CENTER_UTILITY_5",
    );

    const rtlElement = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 480,
      ownerDocument: createRtlOwnerDocument("negative"),
      parentElement: null,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const rtlViewport = new BrunoTableViewportRuntime(36, 40);
    rtlViewport.setLayout(2, columns);
    rtlViewport.attach(rtlElement);
    rtlViewport.revealCell(0, "COL_ID_CENTER_UTILITY_5", "header");
    callback!(0);
    expect(rtlElement.scrollLeft).toBe(-600);
    expect(rtlViewport.getSnapshot().virtualWindow.center.at(-1)?.columnId).toBe(
      "COL_ID_CENTER_UTILITY_5",
    );
  });

  it("reconciles a live leading utility gutter once and restores the pinned layout", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_LIVE_UTILITY_START",
        field: "name",
        headerName: "Live utility start",
        valueType: "text",
        pinned: "start",
        width: 170,
      },
      {
        columnId: "COL_ID_LIVE_UTILITY_CENTER",
        field: "name",
        headerName: "Live utility center",
        valueType: "text",
        width: 500,
      },
      {
        columnId: "COL_ID_LIVE_UTILITY_END",
        field: "name",
        headerName: "Live utility end",
        valueType: "text",
        pinned: "end",
        width: 170,
      },
    ]);
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 440,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);
    viewport.attach(element);
    const listener = vi.fn();
    viewport.subscribe(listener);

    expect(viewport.getSnapshot()).toMatchObject({
      width: 440,
      virtualWindow: { pinningSuspended: false },
    });
    expect(viewport.setLeadingUtilityWidth(0)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    expect(viewport.setLeadingUtilityWidth(40)).toBe(true);
    expect(viewport.getSnapshot()).toMatchObject({
      width: 400,
      virtualWindow: { pinningSuspended: true },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(viewport.setLeadingUtilityWidth(40)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(viewport.setLeadingUtilityWidth(0)).toBe(true);
    expect(viewport.getSnapshot()).toMatchObject({
      width: 440,
      virtualWindow: { pinningSuspended: false },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("bounds, reveals, and restores an oversized centreless pinned layout", () => {
    const columns = compileColumns([
      ...Array.from({ length: 30 }, (_, index) => ({
        columnId: `COL_ID_ALL_START_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `All start ${index}`,
        valueType: "text" as const,
        pinned: "start" as const,
        width: 120,
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        columnId: `COL_ID_ALL_END_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `All end ${index}`,
        valueType: "text" as const,
        pinned: "end" as const,
        width: 120,
      })),
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let clientWidth = 240;
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      get clientWidth() {
        return clientWidth;
      },
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(2, columns);

    expect(viewport.getSnapshot().virtualWindow).toMatchObject({
      pinnedStart: [],
      pinnedEnd: [],
      centerCount: 60,
      totalWidth: 7_200,
    });
    expect(viewport.getSnapshot().virtualWindow.center.length).toBeLessThan(10);

    viewport.attach(element);
    viewport.revealCell(0, "COL_ID_ALL_END_29", "header");
    callback!(0);
    expect(element.scrollLeft).toBe(6_960);
    expect(viewport.getSnapshot().virtualWindow.center.at(-1)?.columnId).toBe("COL_ID_ALL_END_29");

    clientWidth = 8_000;
    viewport.attach(null);
    viewport.attach(element);
    expect(viewport.getSnapshot().virtualWindow.pinnedStart).toHaveLength(30);
    expect(viewport.getSnapshot().virtualWindow.pinnedEnd).toHaveLength(30);
    expect(viewport.getSnapshot().virtualWindow.centerCount).toBe(0);
  });

  it("reaches the million-row suffix within browser-safe geometry", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const setProperty = vi.fn();
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const bodyLayer = {
      style: { removeProperty: vi.fn(), setProperty },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(1_000_000, columns);
    viewport.attach(element);
    viewport.attachBodyLayer(bodyLayer);

    viewport.revealCell(999_999, "COL_ID_NAME");
    callback!(0);

    expect(element.scrollTop).toBeLessThanOrEqual(BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT);
    const window = viewport.getSnapshot().virtualWindow;
    expect(window).toMatchObject({
      rowEnd: 1_000_000,
      segmentedRows: true,
      totalHeight: BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT,
    });
    const layerTransformCall = setProperty.mock.calls.findLast(
      ([property]) => property === "transform",
    );
    const layerOffset = Number.parseFloat(
      /translate3d\(0, ([^,]+), 0\)/.exec(String(layerTransformCall?.[1]))?.[1] ?? "NaN",
    );
    expect(layerOffset + (window.rowEnd - window.rowStart - 1) * 36).toBeLessThanOrEqual(
      BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT,
    );
  });

  it("maps absolute native scrollbar jumps across a million logical rows", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(1_000_000, columns);
    viewport.attach(element);

    element.scrollTop = BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT / 2;
    scrollListener!(new Event("scroll"));
    callback!(0);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeGreaterThan(499_000);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBeLessThan(501_000);

    element.scrollTop = BRUNO_TABLE_MAX_PHYSICAL_ROW_HEIGHT;
    scrollListener!(new Event("scroll"));
    callback!(0);
    expect(viewport.getSnapshot().virtualWindow.rowEnd).toBe(1_000_000);

    element.scrollTop = 0;
    scrollListener!(new Event("scroll"));
    callback!(0);
    expect(viewport.getSnapshot().virtualWindow.rowStart).toBe(0);
  });

  it("keeps vertical scroll fixed when revealing a sticky header destination", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 720,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);

    viewport.revealCell(0, "COL_ID_NAME", "header");
    callback!(0);

    expect(element.scrollTop).toBe(720);
  });

  it("does not create a native scroll event when the revealed body row is already visible", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let scrollTop = 0;
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      if (options.top !== undefined) scrollTop = options.top;
    });
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTo,
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = value;
      },
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    scrollTo.mockClear();

    viewport.revealCell(1, "COL_ID_NAME", "body", "row-1");
    callback!(0);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(0);
  });

  it("reduces only off-axis row overscan for a horizontal reveal", () => {
    const columns = compileColumns(
      Array.from({ length: 20 }, (_, index) => ({
        columnId: `COL_ID_HORIZONTAL_REVEAL_${String(index).padStart(2, "0")}`,
        field: "name",
        headerName: `Horizontal reveal ${index}`,
        valueType: "text" as const,
        width: 120,
      })),
    );
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 240,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 720,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);

    viewport.revealCell(21, "COL_ID_HORIZONTAL_REVEAL_00", "body", "row-21");
    callback!(0);
    const initial = viewport.getSnapshot().virtualWindow;

    viewport.revealCell(21, "COL_ID_HORIZONTAL_REVEAL_10", "body", "row-21");
    callback!(0);
    const horizontal = viewport.getSnapshot().virtualWindow;

    expect(horizontal.rowEnd - horizontal.rowStart).toBeLessThan(initial.rowEnd - initial.rowStart);
    expect(horizontal.rowStart).toBeLessThanOrEqual(21);
    expect(horizontal.rowEnd).toBeGreaterThan(21);

    viewport.revealCell(0, "COL_ID_HORIZONTAL_REVEAL_11", "header");
    callback!(0);
    const header = viewport.getSnapshot().virtualWindow;

    expect(header.rowEnd - header.rowStart).toBeGreaterThan(
      horizontal.rowEnd - horizontal.rowStart,
    );

    viewport.revealCell(80, "COL_ID_HORIZONTAL_REVEAL_10", "body", "row-80");
    callback!(0);
    const vertical = viewport.getSnapshot().virtualWindow;

    expect(vertical.rowEnd - vertical.rowStart).toBeGreaterThan(
      horizontal.rowEnd - horizontal.rowStart,
    );
    expect(vertical.rowStart).toBeLessThanOrEqual(80);
    expect(vertical.rowEnd).toBeGreaterThan(80);
  });

  it("ignores the redundant native event from an exact programmatic reveal", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const callbacks: FrameRequestCallback[] = [];
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callbacks.push(next);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let scrollTop = 0;
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTo: ({ top }: ScrollToOptions) => {
        if (top !== undefined) scrollTop = top;
      },
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = value;
      },
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);

    viewport.revealCell(50, "COL_ID_NAME", "body", "row-50");
    callbacks.shift()!(0);
    expect(element.scrollTop).toBeGreaterThan(0);
    expect(callbacks).toHaveLength(0);

    scrollListener!(new Event("scroll"));

    expect(callbacks).toHaveLength(0);
  });

  it("keeps unchanged logical windows out of React notifications while scrolling", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    let callback: FrameRequestCallback | undefined;
    let scrollListener: EventListener | undefined;
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const element = {
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        if (name === "scroll") scrollListener = listener;
      }),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 0,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);
    const listener = vi.fn();
    viewport.subscribe(listener);

    element.scrollTop = 1;
    scrollListener!(new Event("scroll"));
    callback!(0);

    expect(listener).not.toHaveBeenCalled();
  });

  it("clamps a deep scroll before publishing a shrunken live layout", () => {
    const columns = compileColumns([
      {
        columnId: "COL_ID_NAME",
        field: "name",
        headerName: "Name",
        valueType: "text",
      },
    ]);
    const element = {
      addEventListener: vi.fn(),
      clientHeight: 480,
      clientWidth: 800,
      removeEventListener: vi.fn(),
      scrollLeft: 0,
      scrollTop: 3_000,
      style: { removeProperty: vi.fn(), setProperty: vi.fn() },
    } as unknown as HTMLElement;
    const viewport = new BrunoTableViewportRuntime();
    viewport.setLayout(100, columns);
    viewport.attach(element);

    viewport.setLayout(2, columns);

    expect(element.scrollTop).toBe(0);
    expect(viewport.getSnapshot().virtualWindow).toMatchObject({ rowStart: 0, rowEnd: 2 });
  });
});
