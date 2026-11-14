import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import type { Client } from "./client";
import { onThemeChange, xtermTheme } from "./theme";

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const isWord = (ch: string | undefined) => !!ch && !/\s/.test(ch);

// Copy to clipboard. navigator.clipboard only exists over https/localhost, so
// plain-http LAN access falls back to the legacy execCommand path.
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.readOnly = true;
  el.style.position = "fixed";
  el.style.top = "0";
  el.style.left = "0";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.opacity = "0";
  document.body.appendChild(el);
  try {
    // iOS Safari ignores select() on readonly inputs; it needs an explicit Range.
    if (/ipad|iphone|ipod/i.test(navigator.userAgent)) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.setSelectionRange(0, text.length);
    } else {
      el.select();
    }
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(el);
  }
}

// A buffer cell: column plus absolute buffer row (includes scrollback).
type Cell = { col: number; row: number };

const beforeOrEqual = (a: Cell, b: Cell) =>
  a.row < b.row || (a.row === b.row && a.col <= b.col);

// Length in cells of the contiguous run s..e (inclusive), wrapping at `cols`.
const rangeLength = (s: Cell, e: Cell, cols: number) =>
  (e.row - s.row) * cols + (e.col - s.col) + 1;

// One cell forward (dir +1) or back (dir -1), wrapping line boundaries and
// clamping to the buffer.
const stepCell = (cell: Cell, dir: number, cols: number, maxRow: number): Cell => {
  let col = cell.col + dir;
  let row = cell.row;
  if (col < 0) {
    row -= 1;
    col = cols - 1;
  } else if (col >= cols) {
    row += 1;
    col = 0;
  }
  return { col: clamp(col, 0, cols - 1), row: clamp(row, 0, maxRow) };
};

// Fires on press, then auto-repeats (accelerating) while held — for nudging a
// selection edge across many cells without many taps.
function RepeatButton({
  onStep,
  ariaLabel,
  children,
}: {
  onStep: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  const timer = useRef<number | undefined>(undefined);
  const stop = () => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  const start = (e: ReactPointerEvent) => {
    e.preventDefault(); // don't blur the terminal / start a gesture
    onStep();
    let delay = 320;
    const tick = () => {
      onStep();
      delay = Math.max(60, delay - 40);
      timer.current = window.setTimeout(tick, delay);
    };
    timer.current = window.setTimeout(tick, delay);
  };
  useEffect(() => stop, []);
  return (
    <button
      className="edge-button"
      aria-label={ariaLabel}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      {children}
    </button>
  );
}

// One xterm per session, kept mounted so scrollback survives tab switches;
// inactive terminals are hidden with CSS, not unmounted.
export function TerminalView({
  client,
  sessionId,
  active,
  exited,
  blocked = false,
  selectMode,
  onEnterSelect,
  onExitSelect,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
  // Process gone: stdin is closed, so keep the terminal unfocusable/untypeable.
  exited: boolean;
  blocked?: boolean;
  // Touch text-selection. Off: drags scroll. On: drags select. A long-press
  // selects the word under the finger and flips the workspace into select mode.
  selectMode: boolean;
  onEnterSelect: () => void;
  onExitSelect: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Live selection edges (inclusive, absolute rows) so the toolbar can nudge
  // and re-apply them; synced wherever we call term.select().
  const selectionRef = useRef<{ start: Cell; end: Cell } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Mirror latest props into refs so the terminal effect's long-lived touch
  // handlers see current values without re-running.
  const selectModeRef = useRef(selectMode);
  const onEnterRef = useRef(onEnterSelect);
  useEffect(() => {
    onEnterRef.current = onEnterSelect;
  });
  useEffect(() => {
    selectModeRef.current = selectMode;
    // xterm's hidden textarea pops the mobile keyboard. In select mode we don't
    // type: suppress its virtual keyboard and blur it; restore on exit.
    const textarea = termRef.current?.textarea;
    if (selectMode) {
      if (textarea) {
        textarea.inputMode = "none";
        textarea.blur();
      }
    } else {
      if (textarea) textarea.inputMode = "";
      termRef.current?.clearSelection();
      selectionRef.current = null;
      setHasSelection(false);
    }
  }, [selectMode]);

  // Apply a selection (any order), normalize to start<=end, and record it.
  const applySelection = (a: Cell, b: Cell) => {
    const term = termRef.current;
    if (!term) return;
    const [s, e] = beforeOrEqual(a, b) ? [a, b] : [b, a];
    term.select(s.col, s.row, rangeLength(s, e, term.cols));
    selectionRef.current = { start: s, end: e };
    setHasSelection(true);
  };

  // Nudge one edge by a cell, never crossing the other edge (min 1 cell), and
  // scroll the moved edge into view if it left the viewport.
  const moveEdge = (edge: "start" | "end", dir: 1 | -1) => {
    const term = termRef.current;
    const sel = selectionRef.current;
    if (!term || !sel) return;
    const maxRow = term.buffer.active.length - 1;
    let moved = stepCell(
      edge === "start" ? sel.start : sel.end,
      dir,
      term.cols,
      maxRow,
    );
    if (edge === "start") {
      if (!beforeOrEqual(moved, sel.end)) moved = sel.end;
      applySelection(moved, sel.end);
    } else {
      if (!beforeOrEqual(sel.start, moved)) moved = sel.start;
      applySelection(sel.start, moved);
    }
    const top = term.buffer.active.viewportY;
    const bottom = top + term.rows - 1;
    if (moved.row < top) term.scrollLines(moved.row - top);
    else if (moved.row > bottom) term.scrollLines(moved.row - bottom);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Slightly smaller on mobile so terminal text matches the surrounding UI.
    const mobile = window.matchMedia("(max-width: 640px)");
    const fontSize = () => (mobile.matches ? 12 : 13);

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: fontSize(),
      cursorBlink: true,
      allowProposedApi: true, // required by the unicode11 addon
      theme: xtermTheme(),
    });
    termRef.current = term;

    // xterm takes colors as a JS object, so it can't follow the CSS vars the
    // rest of the app themes with — push new ones in on change.
    const offTheme = onThemeChange((t) => {
      term.options.theme = xtermTheme(t);
    });

    // unicode11 fixes wide-char widths (box-drawing/emoji) the default tables
    // size wrong, which otherwise corrupts TUI layout.
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // GPU rendering (perf win over the DOM renderer). Prefer WebGL; fall back to
    // canvas if unavailable or its context is lost (mobile GPUs drop it).
    let renderer: WebglAddon | CanvasAddon;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        renderer = new CanvasAddon();
        term.loadAddon(renderer);
      });
      term.loadAddon(webgl);
      renderer = webgl;
    } catch {
      renderer = new CanvasAddon();
      term.loadAddon(renderer);
    }

    const { initial, unsubscribe } = client.subscribeOutput(
      sessionId,
      (data) => term.write(data),
      () => term.reset(),
    );
    if (initial) term.write(initial);

    term.onData((data) => client.input(sessionId, data));
    term.onSelectionChange(() => setHasSelection(term.hasSelection()));

    const syncSize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      client.resize(sessionId, term.cols, term.rows);
    };
    syncSize();

    // Refit when the container resizes, including when it becomes visible.
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);

    // --- Touch: scroll, long-press-to-select, and drag-to-select ------------
    // xterm's selection is wired to mouse events touch never synthesizes, so we
    // drive its public select() API from raw touch coords ourselves.
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    const screenEl = () => container.querySelector<HTMLElement>(".xterm-screen");

    // Pixel → buffer cell. Cell pixel size isn't public, so read it off the
    // render service (the one private hook in this file).
    const cellAt = (clientX: number, clientY: number): Cell | null => {
      const scr = screenEl();
      const dims = (term as unknown as { _core?: any })._core?._renderService
        ?.dimensions?.css?.cell;
      if (!scr || !dims?.width || !dims?.height) return null;
      const rect = scr.getBoundingClientRect();
      const col = clamp(
        Math.floor((clientX - rect.left) / dims.width),
        0,
        term.cols - 1,
      );
      const screenRow = clamp(
        Math.floor((clientY - rect.top) / dims.height),
        0,
        term.rows - 1,
      );
      return { col, row: term.buffer.active.viewportY + screenRow };
    };

    const selectWordAt = ({ col, row }: Cell): boolean => {
      const line = term.buffer.active.getLine(row);
      if (!line) return false;
      const text = line.translateToString(false);
      if (!isWord(text[col])) return false;
      let start = col;
      let end = col;
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length - 1 && isWord(text[end + 1])) end++;
      applySelection({ col: start, row }, { col: end, row });
      return true;
    };

    // Contiguous run from anchor to current cell, in reading order.
    const selectRange = (a: Cell, b: Cell) => applySelection(a, b);

    let lastTouchY = 0;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let anchor: Cell | null = null;
    let longPressTimer: number | undefined;
    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = undefined;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      lastTouchY = t.clientY;
      startX = t.clientX;
      startY = t.clientY;
      moved = false;
      anchor = selectModeRef.current ? cellAt(t.clientX, t.clientY) : null;
      clearTimer();
      longPressTimer = window.setTimeout(() => {
        const cell = cellAt(startX, startY);
        if (cell && selectWordAt(cell)) {
          anchor = cell;
          // Flip optimistically so a continued drag extends the selection
          // before React re-renders with the new mode.
          selectModeRef.current = true;
          onEnterRef.current();
        }
      }, 450);
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!moved && Math.hypot(t.clientX - startX, t.clientY - startY) > 10) {
        moved = true;
        clearTimer(); // a drag isn't a long-press
      }
      if (selectModeRef.current) {
        // stopPropagation (capture phase) blocks xterm's own touch-scroll
        // listener on the inner .xterm-screen.
        e.preventDefault();
        e.stopPropagation();
        const cur = cellAt(t.clientX, t.clientY);
        if (anchor && cur) selectRange(anchor, cur);
        return;
      }
      // Normal mode: drive viewport scroll directly for 1:1 swipe scrolling.
      if (viewport) {
        viewport.scrollTop += lastTouchY - t.clientY;
        lastTouchY = t.clientY;
        e.preventDefault();
      }
    };

    const onTouchEnd = () => clearTimer();

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    // Capture phase so select mode can stopPropagation before xterm's own
    // touch-scroll listener runs.
    container.addEventListener("touchmove", onTouchMove, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchend", onTouchEnd, { passive: true });

    // Re-apply the font size when crossing the mobile breakpoint (e.g. rotate).
    const onBreakpoint = () => {
      term.options.fontSize = fontSize();
      syncSize();
    };
    mobile.addEventListener("change", onBreakpoint);

    return () => {
      clearTimer();
      observer.disconnect();
      mobile.removeEventListener("change", onBreakpoint);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove, { capture: true });
      container.removeEventListener("touchend", onTouchEnd);
      unsubscribe();
      offTheme();
      // Disposing the GPU renderer/terminal can throw on some drivers; swallow
      // it so cleanup can't tear down the whole React tree. Renderer before term.
      try {
        renderer.dispose();
      } catch {
        /* renderer already gone / context lost */
      }
      try {
        term.dispose();
      } catch {
        /* terminal teardown raced its own disposal */
      }
      termRef.current = null;
    };
  }, [client, sessionId]);

  // Type immediately on open/switch. After the creation effect so termRef is set.
  // `blocked`: a dialog (sudo prompt) owns the keyboard; refocus once it's gone.
  useEffect(() => {
    if (blocked) termRef.current?.blur();
    else if (active && !selectMode && !exited) termRef.current?.focus();
  }, [active, selectMode, exited, blocked]);

  // On exit, take focus away and keep it away: disabling xterm's hidden textarea
  // makes clicks/taps unable to refocus it (and can't raise the mobile keyboard).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = exited;
    const textarea = term.textarea;
    if (!textarea) return;
    textarea.disabled = exited;
    if (exited) textarea.blur();
  }, [exited]);

  const copySelection = async () => {
    const text = termRef.current?.getSelection();
    if (!text) {
      onExitSelect();
      return;
    }
    if (await copyText(text)) {
      onExitSelect();
    } else {
      // Surface the failure; keep the selection so the user can retry.
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 1800);
    }
  };

  return (
    <>
      <div
        ref={containerRef}
        className="terminal"
        style={{ display: active ? "block" : "none" }}
      />
      {active && selectMode && hasSelection && (
        <div
          className="select-toolbar"
          // Don't let toolbar taps blur the terminal or reach its touch layer.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="edge-group">
            <span className="edge-label">Start</span>
            <RepeatButton
              ariaLabel="Move selection start backward"
              onStep={() => moveEdge("start", -1)}
            >
              ◀
            </RepeatButton>
            <RepeatButton
              ariaLabel="Move selection start forward"
              onStep={() => moveEdge("start", 1)}
            >
              ▶
            </RepeatButton>
          </div>
          <div className="edge-group">
            <span className="edge-label">End</span>
            <RepeatButton
              ariaLabel="Move selection end backward"
              onStep={() => moveEdge("end", -1)}
            >
              ◀
            </RepeatButton>
            <RepeatButton
              ariaLabel="Move selection end forward"
              onStep={() => moveEdge("end", 1)}
            >
              ▶
            </RepeatButton>
          </div>
          <button
            className={`copy-button ${copyFailed ? "failed" : ""}`}
            onClick={copySelection}
          >
            {copyFailed ? "Can't copy" : "Copy"}
          </button>
        </div>
      )}
    </>
  );
}
