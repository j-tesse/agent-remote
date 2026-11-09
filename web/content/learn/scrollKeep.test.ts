import { describe, expect, it, vi } from "vitest";
import { isScrollReady, readScrollReport, scrollBootstrap } from "./scrollKeep";

describe("message parsing", () => {
  it("accepts well-formed reports only", () => {
    expect(readScrollReport({ lkScroll: { y: 120, h: 900 } })).toEqual({ y: 120, h: 900 });
    for (const bad of [null, 1, {}, { lkScroll: null }, { lkScroll: { y: "1", h: 2 } },
      { lkScroll: { y: NaN, h: 2 } }, { lkScroll: { y: 1, h: Infinity } }, { lkScroll: { y: -5, h: 2 } }])
      expect(readScrollReport(bad)).toBeNull();
  });
  it("ready must be literally true", () => {
    expect(isScrollReady({ lkScrollReady: true })).toBe(true);
    expect(isScrollReady({ lkScrollReady: 1 })).toBe(false);
    expect(isScrollReady(null)).toBe(false);
  });
});

function fakeFrame(readyState = "loading") {
  vi.useFakeTimers();
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const posted: unknown[] = [];
  const style = () => {
    const props: Record<string, [string, string]> = {};
    return {
      props,
      getPropertyValue: (k: string) => props[k]?.[0] ?? "",
      getPropertyPriority: (k: string) => props[k]?.[1] ?? "",
      setProperty: (k: string, v: string, p = "") => { props[k] = [v, p]; },
    };
  };
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const behaviorAtScroll: string[] = [];
  const doc = {
    readyState,
    documentElement: { scrollHeight: 2000, style: style() },
    body: null,
  };
  const win = {
    parent, scrollY: 0,
    addEventListener: (t: string, f: (e: unknown) => void) => { (listeners[t] ??= []).push(f); },
    requestAnimationFrame: (f: () => void) => setTimeout(f, 16),
    scrollTo: (_x: number, y: number) => {
      behaviorAtScroll.push(doc.documentElement.style.getPropertyValue("scroll-behavior"));
      win.scrollY = y;
    },
  };
  new Function("window", "document", scrollBootstrap())(win, doc);
  const fire = (t: string, e: unknown = {}) => listeners[t]?.forEach((f) => f(e));
  return { win, doc, posted, fire, parent, behaviorAtScroll };
}

describe("scrollBootstrap", () => {
  it("announces ready on load and restores without smooth scrolling", () => {
    const f = fakeFrame();
    expect(f.posted).toEqual([]);
    f.fire("load");
    expect(f.posted).toEqual([{ lkScrollReady: true }]);
    f.fire("message", { source: f.parent, data: { lkScrollRestore: { y: 500 } } });
    expect(f.win.scrollY).toBe(500);
    expect(f.behaviorAtScroll[0]).toBe("auto");
    expect(f.doc.documentElement.style.getPropertyValue("scroll-behavior")).toBe("");
    f.win.scrollY = 100; // layout shift clamped it
    vi.advanceTimersByTime(700);
    expect(f.win.scrollY).toBe(500);
    expect(f.posted.at(-1)).toEqual({ lkScroll: { y: 500, h: 2000 } });
    vi.useRealTimers();
  });

  it("ignores restores from anyone but the parent, and malformed ones", () => {
    const f = fakeFrame("complete");
    expect(f.posted).toEqual([{ lkScrollReady: true }]);
    f.fire("message", { source: {}, data: { lkScrollRestore: { y: 500 } } });
    f.fire("message", { source: f.parent, data: { lkScrollRestore: { y: "500" } } });
    expect(f.win.scrollY).toBe(0);
    vi.useRealTimers();
  });

  it("throttles scroll reports and suppresses them mid-restore", () => {
    const f = fakeFrame("complete");
    f.posted.length = 0;
    f.win.scrollY = 42;
    f.fire("scroll"); f.fire("scroll"); f.fire("scroll");
    vi.advanceTimersByTime(20);
    expect(f.posted).toEqual([{ lkScroll: { y: 42, h: 2000 } }]);
    f.fire("message", { source: f.parent, data: { lkScrollRestore: { y: 300 } } });
    f.fire("scroll");
    vi.advanceTimersByTime(20);
    expect(f.posted).toHaveLength(1);
    f.fire("wheel"); // user takes over → settles and reports
    expect(f.posted.at(-1)).toEqual({ lkScroll: { y: 300, h: 2000 } });
    vi.useRealTimers();
  });
});
