import { useEffect, type RefObject } from "react";

// The frame is sandboxed without allow-same-origin, so its scroll is only reachable via postMessage.

export interface ScrollReport { y: number; h: number }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** `{lkScroll:{y,h}}` from the frame → report, else null. */
export function readScrollReport(data: unknown): ScrollReport | null {
  if (!isObj(data) || !isObj(data.lkScroll)) return null;
  const { y, h } = data.lkScroll;
  return finite(y) && finite(h) && y >= 0 ? { y, h } : null;
}

export function isScrollReady(data: unknown): boolean {
  return isObj(data) && data.lkScrollReady === true;
}

// Module-level so a remount (tab switch, folder detour) keeps the position.
const positions = new Map<string, number>();

/** Script injected into the preview page's <head> (runs inside the sandboxed iframe). */
export function scrollBootstrap(): string {
  return `(function () {
  var w = window, P = w.parent;
  if (!P || P === w) return;
  var restoring = false, ticking = false, timers = [];
  function root() { return document.documentElement; }
  function send() {
    ticking = false;
    if (restoring) return; // a clamped mid-restore position would overwrite the stored one
    var d = root();
    P.postMessage({ lkScroll: { y: w.scrollY || 0, h: d ? d.scrollHeight : 0 } }, "*");
  }
  w.addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    w.requestAnimationFrame(send);
  }, { passive: true });
  function jump(y) {
    // page CSS sets scroll-behavior:smooth; an animated restore would read as a jump
    var els = [root(), document.body].filter(Boolean), prev = els.map(function (e) {
      return [e.style.getPropertyValue("scroll-behavior"), e.style.getPropertyPriority("scroll-behavior")];
    });
    els.forEach(function (e) { e.style.setProperty("scroll-behavior", "auto", "important"); });
    w.scrollTo(0, y);
    els.forEach(function (e, i) { e.style.setProperty("scroll-behavior", prev[i][0], prev[i][1]); });
  }
  function settle() {
    timers.forEach(clearTimeout);
    timers = [];
    if (!restoring) return;
    restoring = false;
    send();
  }
  // the user taking over cancels the follow-up re-applies
  ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (t) {
    w.addEventListener(t, settle, { passive: true });
  });
  w.addEventListener("message", function (e) {
    if (e.source !== P) return;
    var r = e.data && e.data.lkScrollRestore, y = r && r.y;
    if (typeof y !== "number" || !isFinite(y) || y < 0) return;
    restoring = true;
    jump(y);
    // animations/late images can still change height, so re-apply a few times
    w.requestAnimationFrame(function () { w.requestAnimationFrame(function () { if (restoring) jump(y); }); });
    timers.push(setTimeout(function () { if (restoring) jump(y); }, 150));
    timers.push(setTimeout(function () { if (restoring) jump(y); settle(); }, 600));
  });
  function ready() { P.postMessage({ lkScrollReady: true }, "*"); }
  if (document.readyState === "complete") ready();
  else w.addEventListener("load", ready);
})();`;
}

/** Parent half: remembers the frame's scroll per `key` and restores it after reloads. */
export function useScrollKeep(frame: RefObject<HTMLIFrameElement | null>, key: string): void {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const report = readScrollReport(e.data);
      if (report) {
        positions.set(key, report.y);
        return;
      }
      if (isScrollReady(e.data)) {
        const y = positions.get(key);
        if (y !== undefined && y > 0) win.postMessage({ lkScrollRestore: { y } }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, key]);
}
