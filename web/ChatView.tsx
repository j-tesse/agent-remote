import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AgentRun,
  AssistantDecision,
  AssistantTrace,
  ChatEffort,
  ChatModel,
  ChatImageRef,
  ChatMessage,
  ChatPart,
  ChatState,
  ChatUiRequest,
  ChatUsage,
  RewindPreview,
} from "../shared/protocol";
import {
  agentPrompt,
  copyText,
  diffFoldLabel,
  groupParts,
  renderMarkdown,
  thinkingSummary,
  toolGlyph,
  toolView,
} from "../shared/render";
import type { DiffLine, ToolBody } from "../shared/render";
import type { Client } from "./client";
import { linkRuns } from "./linkify";
import { formatReset, relativeTime } from "./time";
import { windowElapsedPct } from "./usage";

// Chat-bubble view for chat sessions (ui: "chat"). Harness-agnostic: renders the
// client's normalized ChatState, sends ChatActions back. Lazy-loaded so marked
// stays out of the initial bundle. Rendering primitives live in shared/render.ts
// so the server-side render-log captures exactly what's shown here.

function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  // React re-sets innerHTML only when html changes, which wipes the buttons too.
  useLayoutEffect(() => {
    if (ref.current) addCodeCopyButtons(ref.current);
  }, [html]);
  return (
    <div
      ref={ref}
      className="chat-md"
      onClick={onCodeCopyClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ToolBodyView({ body }: { body: ToolBody }) {
  switch (body.kind) {
    case "none":
      return null;
    case "json":
      return <pre className="chat-tool-args">{body.text}</pre>;
    case "code":
      return (
        <div className="chat-tool-body">
          {body.label && <div className="chat-tool-path">{body.label}</div>}
          <pre className="chat-tool-code">{body.text}</pre>
        </div>
      );
    case "diff":
      return (
        <div className="chat-tool-body">
          {/* Path + "+N −M" header, the way a PR lists each changed file. */}
          <div className="chat-tool-path chat-diff-head">
            <span className="chat-diff-path">{body.path ?? "edit"}</span>
            <span className="chat-diff-stats">
              <span className="diff-add">+{body.added}</span>
              <span className="diff-del">−{body.removed}</span>
            </span>
          </div>
          <pre className="chat-tool-diff">
            {body.rows.map((row, i) =>
              row.kind === "fold" ? (
                <span key={i} className="diff-fold">
                  {diffFoldLabel(row.count)}
                </span>
              ) : (
                <DiffRow key={i} line={row.line} />
              ),
            )}
          </pre>
        </div>
      );
  }
}

/** Sub-agent transcripts, flat and keyed by the tool call that spawned them, plus
 * the lazy loader for resumed sessions. A context rather than props: ToolPart →
 * Bubble → ToolPart nests arbitrarily deep for an agent inside an agent. */
const AgentsContext = createContext<{
  agents: Record<string, AgentRun>;
  onLoad: (toolId: string) => void;
}>({ agents: {}, onLoad: () => {} });

/** As the element grows, scroll its scroll container so its bottom edge stays
 * where it was — but only if that edge was in view (never yank a reader who
 * scrolled away), by at most the growth, and never past the element's top.
 * Needed because a peer panel grows on *another* session's events, which the
 * outer transcript's stick-to-bottom never sees. */
function useKeepBottomInView(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let prev: number | null = null;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const grew = prev === null ? 0 : h - prev;
      prev = h;
      if (grew <= 0) return;
      const box = el.parentElement?.closest<HTMLElement>(".chat-agent, .chat-scroll");
      if (!box) return;
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      // Measured from live geometry, so native scroll anchoring that already
      // compensated leaves nothing (overflow ≤ 0) to double up on.
      if (r.bottom - grew > b.bottom + 2) return;
      const by = Math.min(grew, r.bottom - b.bottom, r.top - b.top);
      if (by > 0) box.scrollTop += by;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

/** A nested chat session rendered inline: the same bubbles as the main
 * transcript, in a box capped at half the viewport with its own scroll. Takes a
 * plain ChatState, so it serves both a sub-agent run (`AgentRun.state`, folded
 * from agent-event envelopes) and a *peer session* the client already holds
 * (auto-PR's `/pr` tab — see usePeerChat). Read-only: bubbles only, no composer,
 * no cards, no controls. */
function AgentPanel({
  state,
  live,
  prompt,
  empty,
}: {
  state: ChatState;
  live: boolean;
  /** An opening message the transcript itself doesn't carry — a sub-agent's
   * task (see render.ts's agentPrompt). Empty when the session has its own. */
  prompt: string;
  /** Placeholder for a transcript with nothing in it yet. */
  empty?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const count = state.messages.length;
  // Streaming parts too, or a live panel wouldn't follow within a turn.
  const streamed = state.streaming?.parts.length ?? -1;
  // Follow a running session, independently of the outer transcript.
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [count, streamed, live]);
  useKeepBottomInView(ref);
  // For a sub-agent this is only reached while loading — an otherwise-empty run
  // falls back to the ordinary tool view in ToolPart.
  if (count === 0 && !state.streaming)
    return (
      <div className="chat-agent empty" ref={ref}>
        {empty ?? "Loading transcript…"}
      </div>
    );
  return (
    <div className="chat-agent" ref={ref}>
      {prompt && (
        <div className="chat-turn user">
          <div className="chat-bubble user">
            <Markdown text={prompt} />
          </div>
        </div>
      )}
      {state.messages.map((m) => (
        <Bubble key={m.id} message={m} />
      ))}
      {state.streaming && <Bubble message={state.streaming} streaming />}
    </div>
  );
}

/** Live transcript of *another* session, or null when there's nothing to show.
 * No mirroring is needed: the client already holds every chat session's state
 * (one snapshot on connect, then live events), so an AI-mode note can render the
 * session it spawned inline exactly as a sub-agent run renders. */
function usePeerChat(client: Client, sessionId?: string): ChatState | null {
  const [state, setState] = useState<ChatState | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setState(null);
      return;
    }
    const { initial, unsubscribe } = client.subscribeChat(sessionId, setState);
    setState(initial);
    return unsubscribe;
  }, [client, sessionId]);
  return state;
}

function ToolPart({
  part,
  open,
  standalone,
}: {
  part: Extract<ChatPart, { type: "tool" }>;
  open?: boolean;
  /** Its own bubble in the transcript, vs. nested inside a permission card. */
  standalone?: boolean;
}) {
  const glyph = toolGlyph(part.status);
  const view = toolView(part);
  const { agents, onLoad } = useContext(AgentsContext);
  const run = agents[part.toolId];
  // An empty run keeps the ordinary tool view — see renderPart.
  const nested = run && (run.loading || run.state.messages.length > 0);
  return (
    <details
      className={`chat-tool${standalone ? " standalone" : ""}`}
      data-status={part.status}
      open={open}
      onToggle={(e) => {
        // A resumed session's runs arrive as empty stubs; fetch on first expand.
        if (!run || !e.currentTarget.open) return;
        if (run.state.messages.length === 0 && !run.loading) onLoad(part.toolId);
      }}
    >
      <summary>
        <span className="chat-tool-glyph">{glyph}</span>
        <span className="chat-tool-name">{part.name}</span>
        {view.primary && <span className="chat-tool-preview">{view.primary}</span>}
        {view.secondary && <span className="chat-tool-desc">{view.secondary}</span>}
        {/* The +N −M tally on the collapsed row too — "what did this edit do" is
        usually all you want before opening it. */}
        {view.stat && (
          <span className="chat-tool-stats">
            <span className="diff-add">+{view.stat.added}</span>
            <span className="diff-del">−{view.stat.removed}</span>
          </span>
        )}
      </summary>
      {/* A sub-agent's transcript replaces the args dump and the <pre> report —
          the report is already its last bubble (see the reducer's agent-done). */}
      {nested ? (
        <AgentPanel
          state={run.state}
          live={part.status !== "done" && part.status !== "error"}
          prompt={agentPrompt(part)}
        />
      ) : (
        <>
          <ToolBodyView body={view.body} />
          {part.output && <pre className="chat-tool-output">{part.output}</pre>}
        </>
      )}
    </details>
  );
}

/** Clipboard write that also works over plain http (LAN access), where
 * navigator.clipboard is undefined outside a secure context. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// Strings, not JSX: the code-block buttons are injected into marked's HTML.
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>';

type CopyState = "idle" | "ok" | "fail";
const copyLabel = (state: CopyState, what: string) =>
  state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : `Copy ${what}`;
const COPY_RESET_MS = 1200;

/** Floating hover-only copy button in a bubble's corner (see copyText). */
function CopyButton({ parts }: { parts: ChatPart[] }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const text = copyText(parts);
  if (!text) return null;
  const label = copyLabel(state, "message");
  return (
    <button
      type="button"
      className="chat-copy"
      data-state={state}
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await writeClipboard(text);
        setState(ok ? "ok" : "fail");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), COPY_RESET_MS);
      }}
      dangerouslySetInnerHTML={{ __html: state === "ok" ? CHECK_ICON : COPY_ICON }}
    />
  );
}

/** Wrap each <pre> in a `.chat-code` box carrying a copy button. Imperative: the
 * HTML is marked's (dangerouslySetInnerHTML), so React never reconciles inside it,
 * and keeping it out of renderMarkdown keeps UI chrome out of the render log. */
function addCodeCopyButtons(root: HTMLElement) {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (pre.parentElement?.classList.contains("chat-code")) continue;
    const box = document.createElement("div");
    box.className = "chat-code";
    pre.replaceWith(box);
    box.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-copy";
    setCopyState(btn, "idle");
    box.appendChild(btn);
  }
}

function setCopyState(btn: HTMLElement, state: CopyState) {
  btn.dataset.state = state;
  const label = copyLabel(state, "code");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = state === "ok" ? CHECK_ICON : COPY_ICON;
}

/** Delegated click for the injected code-block buttons. */
async function onCodeCopyClick(e: React.MouseEvent<HTMLElement>) {
  const btn = (e.target as HTMLElement).closest<HTMLElement>(".chat-code > .chat-copy");
  if (!btn) return;
  e.stopPropagation();
  // textContent of <code> = the raw snippet, without the ``` fence.
  const pre = btn.parentElement?.querySelector("pre");
  const ok = await writeClipboard((pre?.textContent ?? "").replace(/\n$/, ""));
  setCopyState(btn, ok ? "ok" : "fail");
  setTimeout(() => btn.isConnected && setCopyState(btn, "idle"), COPY_RESET_MS);
}

function Bubble({
  message,
  streaming,
  onRewind,
}: {
  message: ChatMessage;
  streaming?: boolean;
  /** Present on user bubbles the session can rewind to (see ChatState.capabilities). */
  onRewind?: () => void;
}) {
  // A turn neither party authored (background-task notification, peer message):
  // a muted line in transcript order, never a bubble attributed to the user.
  if (message.role === "system")
    return (
      <div className="chat-system">
        {message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
      </div>
    );
  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    const images = message.parts.filter((p) => p.type === "image");
    return (
      <div className="chat-turn user">
        {onRewind && (
          <button
            className="chat-rewind"
            aria-label="Rewind to this prompt"
            title="Rewind to this prompt"
            onClick={onRewind}
          >
            ↺
          </button>
        )}
        <div className="chat-bubble user">
          <CopyButton parts={message.parts} />
          {text && <Markdown text={text} />}
          {images.length > 0 && (
            <div className="chat-bubble-images">
              {images.map((p, i) =>
                p.type === "image" ? (
                  <a
                    key={i}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="chat-image-link"
                  >
                    <img
                      className="chat-image"
                      src={p.url}
                      alt={p.name ?? "image"}
                      loading="lazy"
                    />
                  </a>
                ) : null,
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  // One bubble per run of prose, one standalone bubble per tool call — a turn
  // is almost always all one or all the other (see groupParts).
  return (
    <div className={`chat-turn assistant${streaming ? " streaming" : ""}`}>
      {groupParts(message.parts).map((group, gi, all) =>
        group.kind === "tool" ? (
          <ToolPart key={group.key} part={group.part} standalone />
        ) : (
          <div key={group.key} className="chat-bubble assistant">
            {!streaming && <CopyButton parts={group.parts} />}
            {group.parts.map((part, i) => (
              <ProsePart
                key={i}
                part={part}
                // Only the part actually being written climbs its count — every
                // earlier thought is finished prose and must read as such.
                live={
                  streaming && gi === all.length - 1 && i === group.parts.length - 1
                }
              />
            ))}
          </div>
        ),
      )}
      {streaming && message.parts.length === 0 && (
        <div className="chat-bubble assistant">
          <span className="chat-cursor" />
        </div>
      )}
    </div>
  );
}

/** One diff row: a `+`/`−`/space gutter in its own span (so selecting the text
 * doesn't drag the sign into the copy), then the line with its changed words
 * marked. Mirrors shared/render.ts's `renderDiffLine`, whose HTML the render log
 * captures — same classes, same structure. */
function DiffRow({ line }: { line: DiffLine }) {
  const cls =
    line.sign === "+"
      ? "diff-add"
      : line.sign === "-"
        ? "diff-del"
        : "diff-ctx";
  return (
    <span className={cls}>
      <span className="diff-mark">{line.sign}</span>
      {line.words
        ? line.words.map((w, i) =>
            w.changed ? (
              <span key={i} className="diff-word">
                {w.text}
              </span>
            ) : (
              <Fragment key={i}>{w.text}</Fragment>
            ),
          )
        : line.text}
    </span>
  );
}

function ProsePart({ part, live = false }: { part: ChatPart; live?: boolean }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} />;
    case "thinking": {
      // No reasoning text (claude never streams it) → a plain live "Thinking…"
      // label; the reducer strips this part once the next part starts. With text
      // (pi) → the collapsible transcript, whose summary says how much reading
      // you're opting out of (`live` while the model is still reasoning, so the
      // count climbs as it types).
      if (part.text.trim() === "")
        return <div className="chat-thinking-label">Thinking…</div>;
      const s = thinkingSummary(part.text, live);
      return (
        <details className="chat-thinking">
          <summary>
            {s.label}
            {s.amount && (
              <span className="chat-thinking-count">{s.amount}</span>
            )}
          </summary>
          <div>{part.text}</div>
        </details>
      );
    }
    default:
      return null;
  }
}

// Material `smart_toy` (robot head) — the AI-assistant (LLM UI-mode) glyph;
// matches the header toggle in App.tsx.
const ROBOT_ICON =
  "M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-1-4c-.83 0-1.5-.67-1.5-1.5S14.17 10 15 10s1.5.67 1.5 1.5S15.83 13 15 13z";

// Octicons `git-merge` (16px grid) — the auto-PR pipeline's own glyph, so its
// progress notes are distinguishable at a glance from card deliberations.
const MERGE_ICON = {
  box: "0 0 16 16",
  d: "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.5 4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
};

// Note lines carry machine-written urls (the PR they opened, a remote in an
// error), so anchor them. `stopPropagation` because the line around them is the
// expand toggle — a tap on the link must only follow it.
function Linked({ text }: { text: string }) {
  return (
    <>
      {linkRuns(text).map((run, i) =>
        run.url ? (
          <a
            key={i}
            href={run.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
          >
            {run.text}
          </a>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

// Colored verdict word — the LLM's answer, so it heads deliberations only.
const TRACE_VERDICT: Record<AssistantTrace["outcome"], string> = {
  allow: "Allow",
  deny: "Deny",
  answer: "Answer",
  abstain: "Abstain",
  error: "No response",
  note: "Note",
};

// AI-mode bubble: a deliberation (what prompt the backend assistant sent the LLM
// about a card, and the model's thoughts/reply) or a plain note from a backend
// capability. Collapsed, it's a single line; tapping toggles the details.
// A deliberation leads with the colored verdict word (its summary would just
// restate it) — a note has no verdict, so its `summary` IS the line and the
// reason trails it. Getting that backwards printed "Auto PR origin" for what
// should read "Pushed joran/x to origin".
function AssistantTraceBubble({
  trace,
  client,
  inlineSession,
  onOpenSession,
  onRunAutoPr,
}: {
  trace: AssistantTrace;
  client: Client;
  // The session whose transcript this note shows inline (auto-PR's `/pr` tab).
  // Only one note per session gets it — see inlineTraceSession in ChatView.
  inlineSession?: string;
  // Jump to the session this note is about, when it's still around (auto-PR's
  // `/pr` tab). Absent = it was closed and removed, so no link is offered.
  onOpenSession?: () => void;
  // "Run anyways" on a router-declined auto-PR note.
  onRunAutoPr?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // One click per note; the backend's single-flight catches any other double run.
  const [ran, setRan] = useState(false);
  const peer = usePeerChat(client, inlineSession);
  // Expand once when the spawned session actually starts working, so the run is
  // watched as it happens. Keyed on `busy`, not on having messages: a reload of
  // an old transcript would otherwise pop open every historical PR note.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !peer?.busy) return;
    autoOpened.current = true;
    setOpen(true);
  }, [peer?.busy]);
  const icon =
    trace.kind === "auto-pr"
      ? MERGE_ICON
      : { box: "0 0 24 24", d: ROBOT_ICON };
  // An LLM spoke → show its verdict; otherwise the note narrates itself.
  const deliberated = !!(trace.prompt || trace.response);
  const hasDetails = !!(
    trace.prompt ||
    trace.thoughts ||
    trace.response ||
    trace.detail ||
    peer
  );
  const toggle = hasDetails
    ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": open,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        },
      }
    : {};
  return (
    <div
      className={`chat-assistant-trace${peer ? " with-session" : ""}`}
      data-outcome={trace.outcome}
    >
      <div className="chat-assistant-trace-head" {...toggle}>
        <svg
          className="chat-assistant-trace-icon"
          viewBox={icon.box}
          aria-hidden="true"
        >
          <path d={icon.d} fill="currentColor" />
        </svg>
        <span
          className={`chat-assistant-trace-verdict${deliberated ? "" : " summary"}`}
        >
          {deliberated ? (
            TRACE_VERDICT[trace.outcome]
          ) : (
            <Linked text={trace.summary} />
          )}
        </span>
        {trace.reason && (
          <span className="chat-assistant-trace-reason">
            <Linked text={trace.reason} />
          </span>
        )}
        {onOpenSession && (
          <button
            type="button"
            className="chat-assistant-trace-link"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSession();
            }}
          >
            open session ↗
          </button>
        )}
        {onRunAutoPr && (
          <button
            type="button"
            className="chat-assistant-trace-link"
            disabled={ran}
            onClick={(e) => {
              e.stopPropagation();
              setRan(true);
              onRunAutoPr();
            }}
          >
            {ran ? "running…" : "Run anyways"}
          </button>
        )}
        {/* Notes are expandable now too (a failed step's full stderr), so the
            line has to advertise it — tapping was previously discoverable only
            on deliberations. */}
        {hasDetails && (
          <span className="chat-assistant-trace-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </div>
      {open && (
        <div className="chat-assistant-trace-details">
          {/* The spawned session's own conversation, read straight off the
              client's state for it — the same panel a sub-agent run renders. */}
          {peer && (
            <AgentPanel
              state={peer}
              live={peer.busy}
              prompt=""
              empty="Starting session…"
            />
          )}
          {trace.detail && (
            <div className="chat-assistant-trace-section">
              <div className="chat-assistant-trace-label">Details</div>
              <pre>
                <Linked text={trace.detail} />
              </pre>
            </div>
          )}
          {trace.prompt && (
            <div className="chat-assistant-trace-section">
              <div className="chat-assistant-trace-label">Prompt</div>
              <pre>{trace.prompt}</pre>
            </div>
          )}
          {trace.thoughts && (
            <div className="chat-assistant-trace-section">
              <div className="chat-assistant-trace-label">Thoughts</div>
              <pre>{trace.thoughts}</pre>
            </div>
          )}
          {trace.response && (
            <div className="chat-assistant-trace-section">
              <div className="chat-assistant-trace-label">Response</div>
              <pre>{trace.response}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A pending image attachment in the composer: uploaded independently of the
// prompt, tracked so its thumbnail can show progress/errors. Only `ready`
// attachments (with a resolved server ref) are sent with the prompt.
interface Attachment {
  localId: string;
  name: string;
  /** Object URL for the local preview thumbnail. */
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  ref?: ChatImageRef;
  error?: string;
}

// Synthetic option offered on every `questions` prompt: pick it to answer with
// the free-text field alone (which then becomes required).
const OTHER = "Other";

// AI-assistant mode is decided on the BACKEND now (server/assistant.ts): the
// server evaluates the card and broadcasts its verdict as `decision`, which the
// card renders exactly as before — a countdown ring on the target button. The
// BACKEND applies the verdict when the ring completes (so it happens even with
// no browser open). Any interaction here cancels that pending verdict via
// `onCancelAuto` (→ the server drops it), letting the user take over manually.
function UiRequestCard({
  request,
  onRespond,
  decision,
  onCancelAuto,
}: {
  request: ChatUiRequest;
  onRespond: (response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
    answers?: Record<string, string>;
    note?: string;
  }) => void;
  // The backend's pending verdict for this card, or undefined. Display-only:
  // the server applies it — the card just shows the countdown / deny hint.
  decision?: AssistantDecision;
  // Tell the backend to withdraw its pending verdict (user is intervening).
  onCancelAuto: () => void;
}) {
  const [value, setValue] = useState("");
  // Rejection reason (Deny/No/Cancel), fed back to the model as the deny message.
  const [note, setNote] = useState("");
  // Free-text answers per question; appended to the chosen option, required (and
  // stands alone) when "Other" is picked.
  const [others, setOthers] = useState<Record<string, string>>({});
  const isPermission =
    request.kind === "select" || request.kind === "confirm";
  // A plan proposal (ExitPlanMode): accept (exit plan mode + auto-accept edits)
  // or keep planning with optional refinement instructions.
  const isPlan = request.kind === "plan";
  // Selected option labels per question (`questions` kind); multi-select holds many.
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const questions = request.questions ?? [];

  // --- Backend auto-action countdown (display + cancel) ------------------
  // The server owns the timer and applies the verdict; here we just render the
  // ring and, on any deliberate interaction, cancel the pending verdict so the
  // user's manual response wins. Once cancelled locally it stays cancelled.
  const [cancelled, setCancelled] = useState(false);
  const denySuggested = decision?.action === "deny";
  const autoActive = !!decision && decision.action !== "deny" && !cancelled;

  const cancelAuto = () => {
    if (cancelled) return;
    setCancelled(true);
    onCancelAuto();
  };
  // Cancel on interaction with any control inside the card (but not e.g.
  // selecting text in a diff), matching "clicks a button / focuses the field".
  const onCardInteract = (e: React.SyntheticEvent) => {
    if (!autoActive) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input, textarea, select")) cancelAuto();
  };

  // Adopt the LLM's terse deny reason when it arrives (async, after mount).
  useEffect(() => {
    if (decision?.action === "deny" && decision.reason)
      setNote((n) => n || decision.reason!);
  }, [decision]);

  // Reflect an auto-answer's choices in the UI so the user sees what's about to
  // be submitted while the countdown runs.
  useEffect(() => {
    if (decision?.action !== "answer" || !decision.answers) return;
    const next: Record<string, string[]> = {};
    for (const q of questions) {
      const a = decision.answers[q.question];
      if (a != null)
        next[q.question] = q.multiSelect ? a.split(",").map((s) => s.trim()) : [a];
    }
    setPicks(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision]);

  // Ring timing for whichever button the countdown will "press".
  const autoDelayStyle = autoActive
    ? ({ ["--auto-duration" as string]: `${decision!.delayMs}ms` } as React.CSSProperties)
    : undefined;

  // Answer = chosen label(s) + appended free text. The synthetic "Other" label
  // is dropped — its free text stands in for it.
  const answerFor = (question: string) => {
    const parts = (picks[question] ?? []).filter((l) => l !== OTHER);
    const text = (others[question] ?? "").trim();
    if (text) parts.push(text);
    return parts.join(", ");
  };
  // Answerable once it has an answer; "Other" makes the free text mandatory.
  const answerValid = (question: string) => {
    const picked = picks[question] ?? [];
    if (picked.includes(OTHER) && !(others[question] ?? "").trim()) return false;
    return answerFor(question).length > 0;
  };
  const allAnswered =
    questions.length > 0 && questions.every((q) => answerValid(q.question));
  const toggle = (question: string, label: string, multi: boolean) =>
    setPicks((p) => {
      const cur = p[question] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...p, [question]: next };
    });
  return (
    <div
      className="chat-request"
      // Any deliberate interaction with a control cancels a pending auto-action.
      onPointerDownCapture={onCardInteract}
      onFocusCapture={onCardInteract}
    >
      <div className="chat-request-title">{request.title}</div>
      {/* A plan renders as markdown (it's Claude's proposal); other cards show a
          plain message line. */}
      {isPlan
        ? request.message && (
            <div
              className="chat-plan"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(request.message),
              }}
            />
          )
        : request.message && (
            <div className="chat-request-message">{request.message}</div>
          )}
      {/* Permission cards render the tool through the same rich toolView the
          transcript uses (diff/code/path), expanded, instead of raw arg JSON. */}
      {request.tool && (
        <ToolPart
          part={{
            type: "tool",
            toolId: request.id,
            name: request.tool.name,
            args: request.tool.args,
            output: "",
            status: "pending",
          }}
          open
        />
      )}
      {request.kind === "questions" &&
        questions.map((q) => (
          <div key={q.question} className="chat-question">
            {q.header && <div className="chat-question-header">{q.header}</div>}
            <div className="chat-question-text">{q.question}</div>
            <div className="chat-question-options">
              {q.options.map((opt) => {
                const selected = (picks[q.question] ?? []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    className={`chat-question-option${selected ? " selected" : ""}`}
                    onClick={() =>
                      toggle(q.question, opt.label, q.multiSelect === true)
                    }
                  >
                    <span className="chat-question-label">{opt.label}</span>
                    {opt.description && (
                      <span className="chat-question-desc">
                        {opt.description}
                      </span>
                    )}
                  </button>
                );
              })}
              {/* "Other": the text field below supplies its answer (then required). */}
              <button
                key="__other__"
                className={`chat-question-option${
                  (picks[q.question] ?? []).includes(OTHER) ? " selected" : ""
                }`}
                onClick={() => toggle(q.question, OTHER, q.multiSelect === true)}
              >
                <span className="chat-question-label">Other</span>
              </button>
            </div>
            <input
              className="chat-question-other"
              value={others[q.question] ?? ""}
              placeholder={
                (picks[q.question] ?? []).includes(OTHER)
                  ? "Type your answer (required)"
                  : "Add detail (optional) — appended to your choice"
              }
              onChange={(e) =>
                setOthers((o) => ({ ...o, [q.question]: e.target.value }))
              }
            />
          </div>
        ))}
      {/* Reasoning box: for permission cards it's the deny message; for a plan
          it's optional refinement instructions sent with "Keep planning". */}
      {(isPermission || isPlan) && (
        <textarea
          className="chat-request-note"
          value={note}
          placeholder={
            isPlan
              ? "Instructions to refine the plan (optional) — sent with Keep planning"
              : "Reason (required to reject) — sent to the model as the deny message"
          }
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="chat-request-actions">
        {request.kind === "questions" && (
          <button
            className={
              autoActive && decision?.action === "answer" ? "auto-press" : ""
            }
            style={decision?.action === "answer" ? autoDelayStyle : undefined}
            disabled={!allAnswered}
            onClick={() =>
              onRespond({
                answers: Object.fromEntries(
                  questions.map((q) => [q.question, answerFor(q.question)]),
                ),
              })
            }
          >
            Submit
          </button>
        )}
        {request.kind === "confirm" && (
          <>
            <button
              className={
                autoActive && decision?.action === "confirm" ? "auto-press" : ""
              }
              style={decision?.action === "confirm" ? autoDelayStyle : undefined}
              onClick={() => onRespond({ confirmed: true })}
            >
              Yes
            </button>
            {/* Rejection requires a reason (sent as the deny message). */}
            <button
              className={denySuggested ? "deny-suggested" : ""}
              disabled={!note.trim()}
              onClick={() => onRespond({ confirmed: false, note })}
            >
              No
            </button>
          </>
        )}
        {request.kind === "select" &&
          (request.options ?? []).map((opt) => {
            const isAutoAccept =
              autoActive &&
              decision?.action === "accept" &&
              opt.value === decision.value;
            const rejects = opt.intent === "reject";
            return (
              <button
                key={opt.value}
                className={[
                  isAutoAccept
                    ? "auto-press"
                    : denySuggested && (rejects || opt.intent === "cancel")
                      ? "deny-suggested"
                      : "",
                  opt.detail ? "chat-option-detailed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={isAutoAccept ? autoDelayStyle : undefined}
                // Rejecting requires a typed reason (sent as the deny message).
                disabled={rejects && !note.trim()}
                onClick={() =>
                  onRespond(
                    rejects
                      ? { value: opt.value, note }
                      : { value: opt.value },
                  )
                }
              >
                <span className="chat-option-label">{opt.label}</span>
                {/* e.g. the exact rule an "Always allow" installs, + its scope. */}
                {opt.detail && (
                  <span className="chat-option-detail">{opt.detail}</span>
                )}
              </button>
            );
          })}
        {request.kind === "input" && (
          <>
            <input
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRespond({ value });
              }}
            />
            <button onClick={() => onRespond({ value })}>Send</button>
          </>
        )}
        {isPlan && (
          <>
            {/* Accept: exits plan mode and auto-accepts subsequent edits. */}
            <button
              className="chat-plan-accept"
              onClick={() =>
                onRespond({
                  value: request.options?.[0]?.value ?? "Accept plan",
                })
              }
            >
              Accept plan &amp; auto-accept edits
            </button>
            {/* Keep planning: sends any typed instructions back to refine. */}
            <button
              onClick={() =>
                onRespond({
                  value: request.options?.[1]?.value ?? "Keep planning",
                  note,
                })
              }
            >
              Keep planning
            </button>
          </>
        )}
        <button
          className="chat-request-cancel"
          onClick={() => onRespond({ cancelled: true, note })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Small bar-chart glyph for the usage button (matches the "charts as an icon"
// ask). Inherits color via currentColor.
function UsageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="9" width="3" height="6" rx="0.5" fill="currentColor" />
      <rect x="6.5" y="5" width="3" height="10" rx="0.5" fill="currentColor" />
      <rect x="12" y="2" width="3" height="13" rx="0.5" fill="currentColor" />
    </svg>
  );
}

// Gauge glyph for the effort button; the needle sweeps left → right with the
// level's position in the harness's (least → most) list. -1 = unknown/default.
function EffortIcon({ level }: { level: number }) {
  const deg = level < 0 ? 0 : -80 + 160 * level;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 12a6 6 0 0 1 12 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <line
        x1="8"
        y1="12"
        x2="8"
        y2="6.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        transform={`rotate(${deg} 8 12)`}
      />
      <circle cx="8" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}

// Header glyphs: an icon stands in for the old "Model"/"Mode"/"Provider" labels.
function ModelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="6.25" y="6.25" width="3.5" height="3.5" rx="0.5" fill="currentColor" />
      <path
        d="M6 1v2.5M10 1v2.5M6 12.5V15M10 12.5V15M1 6h2.5M1 10h2.5M12.5 6H15M12.5 10H15"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ModeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.5 2.5 3.5v4c0 3.3 2.3 5.9 5.5 7 3.2-1.1 5.5-3.7 5.5-7v-4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="m5.6 8 1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProviderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="12" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.8" cy="4.75" r="0.9" fill="currentColor" />
      <circle cx="4.8" cy="11.25" r="0.9" fill="currentColor" />
    </svg>
  );
}

// Shared header picker. Custom menu, not <select>: same look on every platform,
// and the chip sizes to the current value, not the widest option.
// `detail`: small second line (e.g. the raw model id under its display name).
type MenuItem = { id: string; label: string; detail?: string; description?: string };
type MenuSection = { heading?: string; items: MenuItem[] };

function HeaderMenu({
  label,
  icon,
  shown,
  current,
  sections,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  shown: string;
  current: string | null;
  sections: MenuSection[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  // Flip right if it would overflow the viewport; focus the live item.
  useLayoutEffect(() => {
    if (!open) {
      setAlignRight(false);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    if (!alignRight && menu.getBoundingClientRect().right > window.innerWidth - 8)
      setAlignRight(true);
    const items = menu.querySelectorAll<HTMLElement>("[role=menuitemradio]");
    (menu.querySelector<HTMLElement>("[aria-checked=true]") ?? items[0])?.focus();
  }, [open, alignRight]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, n))]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") setOpen(false);
  };
  const title = `${label}: ${shown}`;
  return (
    <div className="chat-menu-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`chat-menu-btn${open ? " open" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
        <span className="chat-menu-value">{shown}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          className={`chat-menu${alignRight ? " align-right" : ""}`}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
        >
          <div className="chat-menu-title">{label}</div>
          {sections.map((s, si) => (
            <Fragment key={s.heading ?? si}>
              {s.heading && <div className="chat-menu-heading">{s.heading}</div>}
              {s.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={it.id === current}
                  className={`chat-menu-item${it.id === current ? " selected" : ""}`}
                  title={it.description}
                  onClick={() => {
                    close(true);
                    if (it.id !== current) onPick(it.id);
                  }}
                >
                  <span className="chat-menu-check">{it.id === current ? "✓" : ""}</span>
                  <span className="chat-menu-label">
                    {it.label}
                    {it.detail && (
                      <span className="chat-menu-detail">{it.detail}</span>
                    )}
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// Reasoning-effort picker; the gauge's needle tracks the current level.
function EffortMenu({
  efforts,
  current,
  onPick,
}: {
  efforts: ChatEffort[];
  current: string | null;
  onPick: (id: string) => void;
}) {
  const selected = efforts.find((e) => e.id === current);
  // Needle position over the real levels only (a "default" row isn't one).
  const levels = efforts.filter((e) => e.id !== "default");
  const idx = selected ? levels.indexOf(selected) : -1;
  const level = idx < 0 ? -1 : levels.length > 1 ? idx / (levels.length - 1) : 1;
  return (
    <HeaderMenu
      label="Reasoning effort"
      icon={<EffortIcon level={level} />}
      shown={selected?.label ?? "unknown"}
      current={current}
      sections={[{ items: efforts }]}
      onPick={onPick}
    />
  );
}

// Utilization → severity class (drives the bar color: calm → warn → hot).
function usageLevel(pct: number): string {
  if (pct >= 90) return "hot";
  if (pct >= 70) return "warn";
  return "ok";
}

// Hover text for the pace marker — the tick is a 2px mark, so the comparison it
// encodes has to be sayable for anyone who can't eyeball it (or is on touch).
function paceTitle(used: number | null, elapsed: number): string {
  const where = `${Math.round(elapsed)}% of this window has elapsed`;
  if (used === null) return where;
  const drift = used - elapsed;
  const verdict =
    drift > 10 ? "over pace" : drift < -10 ? "under pace" : "on pace";
  return `${where} — ${verdict}`;
}

// The usage/limits popover: a progress bar per rate-limit window plus session
// cost. Reads the harness-agnostic ChatUsage snapshot; degrades gracefully when
// the snapshot is absent (loading) or plan limits don't apply (API-key/local).
function UsagePanel({
  usage,
  onRefresh,
  onClose,
}: {
  usage: ChatUsage | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  // The snapshot is static but elapsed time isn't — re-render while open so the
  // pace marker (and "resets in …") don't go stale under a long-open panel.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="chat-usage-panel" role="dialog" aria-label="Usage and limits">
      <div className="chat-usage-head">
        <span className="chat-usage-title">
          Usage &amp; limits
          {usage?.subscriptionType && (
            <span className="chat-usage-plan">{usage.subscriptionType}</span>
          )}
        </span>
        <span className="chat-usage-actions">
          <button type="button" onClick={onRefresh} title="Refresh">
            ↻
          </button>
          <button type="button" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </span>
      </div>
      {usage === null ? (
        <div className="chat-usage-empty">Loading…</div>
      ) : !usage.available ? (
        <div className="chat-usage-empty">
          Plan limits aren’t reported for this session.
        </div>
      ) : usage.windows.length === 0 ? (
        <div className="chat-usage-empty">No limit windows reported.</div>
      ) : (
        <div className="chat-usage-bars">
          {usage.windows.map((w) => {
            const pct = w.utilization;
            const reset = formatReset(w.resetsAt, now);
            const elapsed = windowElapsedPct(w, now);
            return (
              <div className="chat-usage-row" key={w.key}>
                <div className="chat-usage-labels">
                  <span className="chat-usage-name">{w.label}</span>
                  <span className="chat-usage-pct">
                    {pct === null ? "—" : `${Math.round(pct)}%`}
                  </span>
                </div>
                <div className="chat-usage-track">
                  <div
                    className={`chat-usage-fill ${pct === null ? "ok" : usageLevel(pct)}`}
                    style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
                  />
                  {elapsed !== null && (
                    <div
                      className="chat-usage-pace"
                      style={{ left: `${elapsed}%` }}
                      title={paceTitle(pct, elapsed)}
                    />
                  )}
                </div>
                {reset && <div className="chat-usage-reset">{reset}</div>}
              </div>
            );
          })}
          {usage.windows.some((w) => windowElapsedPct(w, now) !== null) && (
            <div className="chat-usage-legend">
              The tick marks how far through each window you are.
            </div>
          )}
        </div>
      )}
      {usage && usage.sessionCostUsd > 0 && (
        <div className="chat-usage-cost">
          Session cost: ${usage.sessionCostUsd.toFixed(2)}
        </div>
      )}
    </div>
  );
}

/** Plain text of a message, for the rewind picker/confirm and the composer prefill. */
function promptText(message: ChatMessage): string {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Modal shell shared by the rewind picker and its confirmation — same markup
 * as App.tsx's resume dialog so the two look and behave identically. */
function RewindDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="resume-overlay" onClick={onClose}>
      <div
        className="resume-dialog rewind-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="resume-dialog-head">
          <span>{title}</span>
          <button className="resume-dialog-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="resume-dialog-body">{children}</div>
      </div>
    </div>
  );
}

/** Confirm rewinding to `message`, optionally restoring files. The file summary
 * comes from a backend dry run (`preview`) so the checkbox says what it'd do. */
function RewindConfirm({
  message,
  preview,
  canRestoreFiles,
  onCancel,
  onConfirm,
}: {
  message: ChatMessage;
  preview: RewindPreview | null;
  canRestoreFiles: boolean;
  onCancel: () => void;
  onConfirm: (restoreFiles: boolean) => void;
}) {
  const [restoreFiles, setRestoreFiles] = useState(false);
  // Only trust a preview that's about this message (a stale one may still be in
  // state while the new dry run is in flight).
  const mine = preview?.messageId === message.id ? preview : null;
  const changed = mine?.filesChanged?.length ?? 0;
  const summary = !mine
    ? "Checking…"
    : !mine.canRewind
      ? (mine.error ?? "Not available for this prompt")
      : changed === 0
        ? "No file changes to undo"
        : `${changed} file${changed === 1 ? "" : "s"} · +${mine.insertions ?? 0} −${mine.deletions ?? 0}`;

  return (
    <RewindDialog title="Rewind conversation" onClose={onCancel}>
      <div className="rewind-prompt">{promptText(message) || "(image-only prompt)"}</div>
      <div className="rewind-explain">
        This prompt and everything after it are removed from the conversation and
        from Claude's context, and the agent is interrupted. The prompt goes back
        into the composer, and the conversation so far stays resumable.
      </div>
      {canRestoreFiles && (
        <label className="assistant-check rewind-check">
          <input
            type="checkbox"
            checked={restoreFiles}
            disabled={!mine?.canRewind}
            onChange={(e) => setRestoreFiles(e.target.checked)}
          />
          <span>
            Also restore files changed since then
            <span className="rewind-preview-summary">{summary}</span>
          </span>
        </label>
      )}
      <div className="assistant-dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="assistant-enable" onClick={() => onConfirm(restoreFiles)}>
          Rewind
        </button>
      </div>
    </RewindDialog>
  );
}

export function ChatView({
  client,
  sessionId,
  active,
  exited,
  canResume,
  onResume,
  keyboardOpen,
  knownSessions,
  heldSessions,
  onOpenSession,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
  exited: boolean;
  // Every session id currently listed, and the jump-to-tab action. An AI-mode
  // note can name another session (auto-PR's `/pr` tab); the set is what decides
  // whether that link is still live, since a closed session has no tab.
  knownSessions: ReadonlySet<string>;
  // Listed + hidden (closed-but-nested) ids: gates the inline panel, which
  // outlives the tab until this (parent) session is removed.
  heldSessions: ReadonlySet<string>;
  onOpenSession: (id: string) => void;
  // Whether the folder has closed sessions to resume, and the opener for the
  // resume picker. `/resume` is a client-only entry in the slash-command menu
  // (not a harness command), so it lives alongside the real commands here.
  canResume: boolean;
  onResume: () => void;
  // True while the mobile on-screen keyboard is up (desktop stays false). Gates
  // the chat key-bar of keys the soft keyboard lacks but composing prompts needs.
  keyboardOpen: boolean;
}) {
  const [state, setState] = useState<ChatState>(() => {
    // Synchronous initial read; the effect below subscribes for updates.
    const { initial, unsubscribe } = client.subscribeChat(sessionId, () => {});
    unsubscribe();
    return initial;
  });
  const [draft, setDraft] = useState("");
  // The unsent draft lives server-side (see ChatState.draft) so a reload or a
  // trip through another folder doesn't lose it. `syncedDraft` is what the
  // server last heard from us, so its echo never fights the caret.
  const syncedDraft = useRef("");
  // Has the server echoed our latest push back? Its state is stale until then.
  const acked = useRef(true);
  const resizePending = useRef(false);
  // Pending image attachments for the next prompt. Each uploads independently;
  // only `ready` ones are sent.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Usage indicator: which sessions expose `/usage`, and whether the panel is open.
  const [usageOpen, setUsageOpen] = useState(false);
  // Rewind: the picker (`/rewind`) and the confirmation for one prompt. Both are
  // per-session, so unlike `/resume` nothing is lifted into App.
  const [rewindPickerOpen, setRewindPickerOpen] = useState(false);
  const [rewindTarget, setRewindTarget] = useState<ChatMessage | null>(null);
  // Model switcher: which group (pi: provider) the second box is listing. Only
  // a filter — switching it lists other models but selects none, so browsing
  // away never fires a `set-model` the user didn't ask for.
  const [browseGroup, setBrowseGroup] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Upload each picked/pasted/dropped image file, tracking per-item status so
  // thumbnails can show progress and errors without blocking the composer.
  const addFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      for (const file of images) {
        const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const previewUrl = URL.createObjectURL(file);
        setAttachments((a) => [
          ...a,
          { localId, name: file.name, previewUrl, status: "uploading" },
        ]);
        client.uploadImage(file).then(
          (ref) =>
            setAttachments((a) =>
              a.map((it) =>
                it.localId === localId ? { ...it, status: "ready", ref } : it,
              ),
            ),
          (err: unknown) =>
            setAttachments((a) =>
              a.map((it) =>
                it.localId === localId
                  ? { ...it, status: "error", error: (err as Error).message }
                  : it,
              ),
            ),
        );
      }
    },
    [client],
  );

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((a) => {
      const it = a.find((x) => x.localId === localId);
      if (it) URL.revokeObjectURL(it.previewUrl);
      return a.filter((x) => x.localId !== localId);
    });
  }, []);
  // Sticky autoscroll: follow new output only while the user is at the bottom.
  const nearBottomRef = useRef(true);

  useEffect(() => {
    // Deltas arrive faster than React should render; coalesce to one per frame.
    let latest: ChatState | null = null;
    let frame: number | null = null;
    const { initial, unsubscribe } = client.subscribeChat(sessionId, (s) => {
      latest = s;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (latest) setState(latest);
      });
    });
    setState(initial);
    return () => {
      unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [client, sessionId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [state, active]);

  // Type immediately on open/switch.
  useEffect(() => {
    if (active && !exited) textareaRef.current?.focus();
  }, [active, exited]);

  const pushDraft = useCallback(
    (text: string) => {
      if (syncedDraft.current === text) return;
      syncedDraft.current = text;
      acked.current = false;
      client.chatAction(sessionId, { type: "set-draft", text });
    },
    [client, sessionId],
  );

  // Keystrokes are debounced; the unmount flush catches a tab closed mid-word.
  useEffect(() => {
    if (draft === syncedDraft.current) return;
    const t = setTimeout(() => pushDraft(draft), 300);
    return () => clearTimeout(t);
  }, [draft, pushDraft]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => () => pushDraft(draftRef.current), [pushDraft]);

  // Adopt a draft we didn't write: the snapshot restored after a reload (what
  // this is all for), or another tab/device typing.
  useEffect(() => {
    if (state.draft === syncedDraft.current) {
      acked.current = true;
      return;
    }
    // Until the server echoes our latest push its value is stale — adopting it
    // would resurrect a keystroke (or a whole just-sent prompt) from in flight.
    if (!acked.current) return;
    // Never shift text under an active caret; an empty composer has nothing to
    // lose, and that's exactly the reload case (focus lands there on mount).
    if (draft !== "" && document.activeElement === textareaRef.current) return;
    syncedDraft.current = state.draft;
    setDraft(state.draft);
    resizePending.current = true;
  }, [state.draft, draft]);

  // --- Continuity Mode's armed prompt (display + cancel) -------------------
  // The backend composed the next prompt and owns the timer that sends it (so
  // it fires with no browser open); here we show the text and sweep a ring
  // around Send. Any intervention withdraws it. Latched by id, so a withdrawn
  // prompt stays withdrawn while a fresh one still arms.
  const [cancelledPrompt, setCancelledPrompt] = useState<string | null>(null);
  const armedPrompt =
    state.autoPrompt && state.autoPrompt.id !== cancelledPrompt
      ? state.autoPrompt
      : null;

  const cancelAutoPrompt = useCallback(() => {
    const armed = state.autoPrompt;
    if (!armed || armed.id === cancelledPrompt) return;
    setCancelledPrompt(armed.id);
    client.chatAction(sessionId, { type: "cancel-auto-prompt", id: armed.id });
  }, [client, sessionId, state.autoPrompt, cancelledPrompt]);

  // Adopt the composed text outright — unlike the draft echo above this is
  // explicit backend intent, not another client's keystrokes, so it overrides
  // the caret/ack guards. Keyed on the prompt id, so it runs once per arming.
  const adoptedPrompt = useRef<string | null>(null);
  useEffect(() => {
    const armed = state.autoPrompt;
    if (!armed || adoptedPrompt.current === armed.id) return;
    adoptedPrompt.current = armed.id;
    syncedDraft.current = armed.text;
    setDraft(armed.text);
    resizePending.current = true;
  }, [state.autoPrompt]);

  // Adopted text needs the same auto-grow typing gets, but only once React has
  // rendered it (scrollHeight is measured on the new value, not the old).
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !resizePending.current) return;
    resizePending.current = false;
    ta.style.height = "auto";
    if (draft) ta.style.height = `${ta.scrollHeight}px`;
  }, [draft]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const uploading = attachments.some((a) => a.status === "uploading");
  const readyImages = attachments
    .filter((a): a is Attachment & { ref: ChatImageRef } => a.status === "ready")
    .map((a) => a.ref);
  const canSend = (draft.trim() !== "" || readyImages.length > 0) && !uploading;

  // Rewinding is a harness capability (claude has it, pi doesn't) — everything
  // rewind-related in the UI hangs off this.
  const canRewind =
    !exited &&
    state.capabilities.rewind === true &&
    state.messages.some((m) => m.role === "user");

  const send = useCallback(() => {
    const text = draft.trim();
    // `/resume` and `/rewind` are client-only (no harness command): Tab-completing
    // one then pressing Enter opens its picker instead of prompting the harness.
    if (text === "/resume" && canResume) {
      setDraft("");
      onResume();
      return;
    }
    if (text === "/rewind" && canRewind) {
      setDraft("");
      setRewindPickerOpen(true);
      return;
    }
    const images = attachments
      .filter((a): a is Attachment & { ref: ChatImageRef } => a.status === "ready")
      .map((a) => a.ref);
    if (!text && images.length === 0) return;
    // Don't send while an image is still uploading.
    if (attachments.some((a) => a.status === "uploading")) return;
    client.chatAction(sessionId, {
      type: "prompt",
      text,
      images: images.length ? images : undefined,
    });
    setDraft("");
    // Clear the stored draft now rather than waiting for the debounce — the
    // send may have outrun it, leaving a stale tail on the server.
    pushDraft("");
    for (const a of attachments) URL.revokeObjectURL(a.previewUrl);
    setAttachments([]);
    nearBottomRef.current = true;
    const ta = textareaRef.current;
    if (ta) ta.style.height = "auto";
  }, [
    client,
    sessionId,
    draft,
    attachments,
    canResume,
    onResume,
    canRewind,
    pushDraft,
  ]);

  // Auto-grow the composer with its content (up to the CSS max-height).
  const onDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // Editing the composed text means taking over: stop the countdown.
    cancelAutoPrompt();
    setDraft(e.target.value);
    setMenuDismissed(false);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const respond = (requestId: string) =>
    (response: {
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
      answers?: Record<string, string>;
      note?: string;
    }) =>
      client.chatAction(sessionId, {
        type: "ui-response",
        requestId,
        ...response,
      });

  // AI-assistant mode (auto-answering permission/question cards) is decided on
  // the backend now — see server/assistant.ts. The server broadcasts each
  // verdict via `state.autoDecisions`, and the cards render the same countdown
  // they always have; the user can still intervene (which cancels the verdict).

  // Escape hides the auto-opened menu until the draft changes again.
  const [menuDismissed, setMenuDismissed] = useState(false);

  // AI-mode trace bubbles render inline right after the assistant turn they
  // explain (anchorMessageId), so the deliberation sits beside its tool call.
  // A note's linked session is offered only while its tab exists — auto-PR stops
  // the `/pr` session on success (the exited tab stays until closed), but a
  // removed one has nothing to jump to.
  const traceLink = (t: AssistantTrace) =>
    t.sessionId && t.sessionId !== sessionId && knownSessions.has(t.sessionId)
      ? () => onOpenSession(t.sessionId!)
      : undefined;
  // A run posts several notes naming the same session (it starts one, then may
  // report a failure about it); they'd all show the identical live transcript,
  // so only the first — the note that announced it — hosts the inline panel.
  // Render-time, like groupParts: nothing about this belongs in the reducer.
  // Gated on held, not listed: a closed nested tab stays watchable inline.
  const inlineTraceSession = (t: AssistantTrace) =>
    t.sessionId &&
    t.sessionId !== sessionId &&
    heldSessions.has(t.sessionId) &&
    state.assistantTraces.find((o) => o.sessionId === t.sessionId) === t
      ? t.sessionId
      : undefined;
  const traceBubble = (t: AssistantTrace, key: string) => (
    <AssistantTraceBubble
      key={key}
      trace={t}
      client={client}
      inlineSession={inlineTraceSession(t)}
      onOpenSession={traceLink(t)}
      onRunAutoPr={
        t.offerAutoPr
          ? () => client.chatAction(sessionId, { type: "run-auto-pr" })
          : undefined
      }
    />
  );
  // Traces and notices both hang off the turn they belong to, so they're
  // emitted together, in arrival order. Passing `undefined` yields the
  // unanchored ones, which predate every message (posted/reported into an empty
  // transcript) and so lead. Nothing renders *after* the messages: anything
  // parked at the end would stay there while every later message slid in above
  // it — the reducer keeps anchors pointing at live turns, and one whose turn
  // has aged out of history goes with it.
  const inlineAfter = (messageId: string | undefined) =>
    [
      ...state.assistantTraces
        .filter((t) => t.anchorMessageId === messageId)
        .map((t, i) => ({
          at: t.at,
          node: traceBubble(t, `trace-${t.requestId}-${t.at}-${i}`),
        })),
      ...state.notices
        .filter((n) => n.anchorMessageId === messageId)
        .map((n, i) => ({
          at: n.at,
          node: (
            <div key={`notice-${n.at}-${i}`} className={`chat-notice ${n.level}`}>
              {n.text}
            </div>
          ),
        })),
    ]
      .sort((a, b) => a.at - b.at)
      .map((x) => x.node);

  // Typing `/foo` (the whole composer, no space yet) is a live command query: it
  // opens the menu and prefix-filters it. `/resume` and `/rewind` are the
  // client-only entries — they carry a `run` instead of being inserted as text.
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1] ?? null;
  const allCommands: {
    name: string;
    description?: string;
    run?: () => void;
  }[] = [
    ...(canResume
      ? [
          {
            name: "resume",
            description: "Resume a previous session",
            run: () => onResume(),
          },
        ]
      : []),
    ...(canRewind
      ? [
          {
            name: "rewind",
            description: "Rewind to an earlier prompt",
            run: () => setRewindPickerOpen(true),
          },
        ]
      : []),
    ...state.commands,
  ];
  const menuCommands =
    slashQuery === null
      ? allCommands
      : allCommands.filter((c) =>
          c.name.toLowerCase().startsWith(slashQuery.toLowerCase()),
        );
  // The menu is purely draft-driven: it's open iff the draft is a live `/query`
  // (however the `/` got there — keyboard or the `/` button, which just types one).
  const commandsOpen =
    !exited && menuCommands.length > 0 && slashQuery !== null && !menuDismissed;
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [slashQuery]);
  const highlighted = menuCommands[Math.min(selected, menuCommands.length - 1)];

  // Replace the query with the command (Tab-completion / click while querying),
  // else append it at the end of the draft.
  const insertCommand = (name: string) => {
    setDraft((d) => (slashQuery !== null || !d ? `/${name} ` : `${d} /${name} `));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const runCommand = (c: { name: string; run?: () => void }) => {
    if (c.run) {
      setDraft("");
      c.run();
    } else insertCommand(c.name);
  };

  // Drop text into the composer for the user to review/edit — never auto-sent.
  // Focuses and grows. Used by the suggestion chips and by rewind (which puts
  // the rewound-to prompt back so it can be re-sent).
  const prefillComposer = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const caret = text.length;
      el.setSelectionRange(caret, caret);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
  };

  // --- Rewind: jump back to one of our own earlier prompts (claude only —
  // gated on the harness's reported capabilities). ---
  const rewindPoints = canRewind
    ? state.messages.filter((m) => m.role === "user")
    : [];

  // Opening the confirmation asks the backend what the rewind would touch on
  // disk, so the "restore files" checkbox can say what it would undo.
  const openRewind = (message: ChatMessage) => {
    setRewindPickerOpen(false);
    setRewindTarget(message);
    client.chatAction(sessionId, {
      type: "rewind-preview",
      messageId: message.id,
    });
  };

  const confirmRewind = (message: ChatMessage, restoreFiles: boolean) => {
    setRewindTarget(null);
    // Put the prompt back in the composer (text + images) so it can be tweaked
    // and re-sent — before the truncation event drops the message from state.
    for (const a of attachments) URL.revokeObjectURL(a.previewUrl);
    setAttachments(
      message.parts.flatMap((p) =>
        p.type === "image"
          ? [
              {
                localId: p.id,
                name: p.name ?? "image",
                previewUrl: p.url,
                status: "ready" as const,
                ref: { id: p.id, mediaType: p.mediaType, name: p.name },
              },
            ]
          : [],
      ),
    );
    prefillComposer(promptText(message));
    client.chatAction(sessionId, {
      type: "rewind",
      messageId: message.id,
      restoreFiles,
    });
  };

  // Insert literal text at the composer's cursor (used by the mobile key-bar for
  // keys the soft keyboard lacks: backtick, newline). Keeps the caret after the
  // inserted text and re-grows the textarea to fit.
  const insertAtCursor = (text: string) => {
    const ta = textareaRef.current;
    const start = ta ? ta.selectionStart : draft.length;
    const end = ta ? ta.selectionEnd : draft.length;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const caret = start + text.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
  };

  // The `/` button is just a key: it types a slash (same as the soft keyboard).
  // The menu then opens off the draft, so mobile gets the typeahead filtering too.
  const typeSlash = () => {
    setMenuDismissed(false);
    insertAtCursor("/");
  };

  // Model switcher. A harness that groups its catalog (pi, by provider) gets a
  // group box + a model box; an ungrouped one keeps the single flat menu.
  // Group order is the order they first appear — the harness owns it.
  const modelGroups = useMemo(() => {
    const out: string[] = [];
    for (const m of state.models)
      if (m.group && !out.includes(m.group)) out.push(m.group);
    return out;
  }, [state.models]);
  const currentGroup =
    state.models.find((m) => m.id === state.currentModel)?.group ?? null;
  // Follow the session's own model unless the user is browsing elsewhere.
  const shownGroup = browseGroup ?? currentGroup ?? modelGroups[0] ?? null;
  const shownModels = shownGroup
    ? state.models.filter((m) => m.group === shownGroup)
    : state.models;
  // Blank while browsing another group: none of the listed models is the live
  // one, and showing the first as selected would be a lie.
  const modelValue = shownModels.some((m) => m.id === state.currentModel)
    ? (state.currentModel ?? "")
    : "";
  // LLM display name when there is one; the raw label moves to the detail line.
  const modelItem = (m: ChatModel): MenuItem => {
    const name = state.modelNames?.[m.id];
    return name && name !== m.label
      ? { id: m.id, label: name, detail: m.label, description: m.description }
      : m;
  };
  const modelShown = modelValue
    ? (() => {
        const m = shownModels.find((x) => x.id === modelValue);
        return m ? modelItem(m).label : modelValue;
      })()
    : "Select model…";
  const modeShown =
    state.modes.find((m) => m.id === state.currentMode)?.label ??
    state.currentMode ??
    "";
  // Sections (pi: Enabled/Disabled) arrive contiguous; run-grouping keeps harness order.
  const modelSections: MenuSection[] = [];
  // Current model missing from the catalog: list it anyway.
  if (
    state.currentModel &&
    !state.models.some((m) => m.id === state.currentModel)
  )
    modelSections.push({
      items: [{ id: state.currentModel, label: state.currentModel }],
    });
  for (const [i, m] of shownModels.entries()) {
    const last = modelSections[modelSections.length - 1];
    if (last && i > 0 && last.heading === m.section) last.items.push(modelItem(m));
    else modelSections.push({ heading: m.section, items: [modelItem(m)] });
  }

  // Memoized so expanding a tool bubble doesn't re-render every other one.
  const agentsCtx = useMemo(
    () => ({
      agents: state.agents,
      onLoad: (toolId: string) =>
        client.chatAction(sessionId, { type: "load-agent", toolId }),
    }),
    [state.agents, client, sessionId],
  );

  return (
    <AgentsContext.Provider value={agentsCtx}>
    <div
      className="chat-view"
      style={{ display: active ? "flex" : "none" }}
    >
      {(state.models.length > 0 ||
        state.efforts.length > 0 ||
        state.modes.length > 0 ||
        state.commands.some((c) => c.name === "usage")) && (
        <div className="chat-header">
          {modelGroups.length > 0 && (
            <HeaderMenu
              label="Provider"
              icon={<ProviderIcon />}
              shown={shownGroup ?? ""}
              current={shownGroup}
              sections={[{ items: modelGroups.map((g) => ({ id: g, label: g })) }]}
              onPick={setBrowseGroup}
            />
          )}
          {state.models.length > 0 && (
            <HeaderMenu
              label="Model"
              icon={<ModelIcon />}
              shown={modelShown}
              current={modelValue || null}
              sections={modelSections}
              onPick={(model) =>
                client.chatAction(sessionId, { type: "set-model", model })
              }
            />
          )}
          {state.efforts.length > 0 && (
            <EffortMenu
              efforts={state.efforts}
              current={state.currentEffort}
              onPick={(effort) =>
                client.chatAction(sessionId, { type: "set-effort", effort })
              }
            />
          )}
          {state.modes.length > 0 && (
            <HeaderMenu
              label="Permission mode"
              icon={<ModeIcon />}
              shown={modeShown}
              current={state.currentMode}
              sections={[{ items: state.modes }]}
              onPick={(mode) =>
                client.chatAction(sessionId, { type: "set-mode", mode })
              }
            />
          )}
          {state.commands.some((c) => c.name === "usage") && (
            <div className="chat-usage-wrap">
              <button
                type="button"
                className={`chat-usage-btn${usageOpen ? " open" : ""}`}
                title="Usage & limits"
                aria-label="Usage & limits"
                aria-expanded={usageOpen}
                onClick={() => {
                  const next = !usageOpen;
                  setUsageOpen(next);
                  // Refresh on open so the numbers are current.
                  if (next) client.chatAction(sessionId, { type: "usage" });
                }}
              >
                <UsageIcon />
              </button>
              {usageOpen && (
                <UsagePanel
                  usage={state.usage}
                  onRefresh={() =>
                    client.chatAction(sessionId, { type: "usage" })
                  }
                  onClose={() => setUsageOpen(false)}
                />
              )}
            </div>
          )}
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {state.messages.length === 0 && !state.streaming && (
          <div className="chat-empty">
            {exited ? "Session ended." : "Send a prompt to get started."}
          </div>
        )}
        {inlineAfter(undefined)}
        {state.messages.map((m) => (
          <Fragment key={m.id}>
            <Bubble
              message={m}
              onRewind={
                canRewind && m.role === "user" ? () => openRewind(m) : undefined
              }
            />
            {inlineAfter(m.id)}
          </Fragment>
        ))}
        {state.streaming && (
          <Fragment key={state.streaming.id}>
            <Bubble message={state.streaming} streaming />
            {inlineAfter(state.streaming.id)}
          </Fragment>
        )}
        {state.queued.map((text, i) => (
          <div key={`q-${i}`} className="chat-bubble user queued">
            <Markdown text={text} />
          </div>
        ))}
        {state.pendingRequests.map((req) => (
          <UiRequestCard
            key={req.id}
            request={req}
            onRespond={respond(req.id)}
            decision={state.autoDecisions[req.id]}
            onCancelAuto={() =>
              client.chatAction(sessionId, {
                type: "cancel-assistant",
                requestId: req.id,
              })
            }
          />
        ))}
      </div>
      {commandsOpen && (
        <div className="chat-commands">
          {menuCommands.map((c, i) => (
            <button
              key={c.run ? `__${c.name}` : c.name}
              className={`chat-command${c === highlighted ? " highlighted" : ""}`}
              // Keep composer focus (and the mobile keyboard) on click.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runCommand(c)}
              title={c.description}
            >
              <span className="chat-command-name">/{c.name}</span>
              {c.description && (
                <span className="chat-command-desc">{c.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {!exited && keyboardOpen && (
        <div className="chat-key-bar">
          <button
            className="key-button"
            aria-label="Attach image"
            title="Attach image"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
          >
            🖼
          </button>
          {(state.commands.length > 0 || canResume || canRewind) && (
            <button
              className={`key-button${commandsOpen ? " active" : ""}`}
              aria-label="Slash"
              title="Slash commands"
              // Keep focus so the mobile keyboard stays up.
              onMouseDown={(e) => e.preventDefault()}
              onClick={typeSlash}
            >
              /
            </button>
          )}
          <button
            className="key-button"
            aria-label="Backtick"
            // Keep focus so the mobile keyboard stays up.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertAtCursor("`")}
          >
            `
          </button>
          <button
            className="key-button"
            aria-label="Newline"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insertAtCursor("\n")}
          >
            ⏎
          </button>
        </div>
      )}
      {/* Predicted next prompts (the TUI's follow-up hints; 0–3, substantially
          distinct). Only while idle with an empty composer, so they never fight
          what the user is typing; a tap prefills the composer with the FULL
          prompt for review (never auto-sends) even when the chip is truncated.
          Chips wrap horizontally, capped at two rows via CSS. */}
      {!exited &&
        state.promptSuggestions.length > 0 &&
        !state.busy &&
        !draft.trim() && (
          <div className="chat-suggestions">
            {state.promptSuggestions.map((suggestion, i) => (
              <button
                key={i}
                className="chat-suggestion"
                title={suggestion}
                onClick={() => prefillComposer(suggestion)}
              >
                <span className="chat-suggestion-glyph">✎</span>
                <span className="chat-suggestion-text">{suggestion}</span>
              </button>
            ))}
          </div>
        )}
      {!exited && attachments.length > 0 && (
        <div className="chat-attachments">
          {attachments.map((a) => (
            <div
              key={a.localId}
              className="chat-attachment"
              data-status={a.status}
              title={a.error ?? a.name}
            >
              <img src={a.previewUrl} alt={a.name} />
              {a.status === "uploading" && (
                <span className="chat-attachment-spinner" />
              )}
              {a.status === "error" && (
                <span className="chat-attachment-error">!</span>
              )}
              <button
                className="chat-attachment-remove"
                aria-label="Remove image"
                onClick={() => removeAttachment(a.localId)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {!exited && (
        <div
          className={`chat-composer${dragOver ? " drag-over" : ""}`}
          // Reaching for any control other than Send is intervening: withdraw
          // the armed prompt so only a deliberate Send submits it.
          onPointerDownCapture={(e) => {
            if (!armedPrompt) return;
            const control = (e.target as HTMLElement).closest(
              "button, input, textarea",
            );
            if (control && !control.classList.contains("chat-send"))
              cancelAutoPrompt();
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files);
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              addFiles(files);
            }
            setDragOver(false);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {/* On mobile the `/` and attach toggles live in the key-bar (above)
              so they're not duplicated here while the keyboard is up. */}
          {!keyboardOpen && (
            <button
              className="chat-attach"
              title="Attach image"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              🖼
            </button>
          )}
          {!keyboardOpen && (state.commands.length > 0 || canResume || canRewind) && (
            <button
              className={`chat-slash${commandsOpen ? " active" : ""}`}
              title="Slash commands"
              onMouseDown={(e) => e.preventDefault()}
              onClick={typeSlash}
            >
              /
            </button>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={state.busy ? "Steer the agent…" : "Prompt…"}
            onChange={onDraftChange}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              // Command menu: ↑/↓ move, Tab completes, Esc dismisses.
              if (commandsOpen && highlighted) {
                if (e.key === "Tab") {
                  e.preventDefault();
                  insertCommand(highlighted.name);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : menuCommands.length - 1;
                  setSelected(
                    (s) =>
                      (Math.min(s, menuCommands.length - 1) + d) %
                      menuCommands.length,
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMenuDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {state.busy && (
            <button
              className="chat-stop"
              title="Abort the current run"
              onClick={() =>
                client.chatAction(sessionId, { type: "abort" })
              }
            >
              Stop
            </button>
          )}
          <button
            className={`chat-send${armedPrompt ? " auto-press" : ""}`}
            // The ring is display-only — the backend sends it. `animation-delay`
            // is negative so a client joining mid-countdown paints the arc it's
            // actually at instead of restarting the sweep.
            style={
              armedPrompt
                ? ({
                    ["--auto-duration" as string]: `${armedPrompt.delayMs}ms`,
                    // Custom property, not `animation-delay`: the animation runs
                    // on ::after, and only custom properties inherit into it.
                    ["--auto-elapsed" as string]: `-${Math.max(
                      0,
                      Date.now() - armedPrompt.at,
                    )}ms`,
                  } as React.CSSProperties)
                : undefined
            }
            disabled={!canSend}
            onClick={send}
          >
            {state.busy ? "Steer" : "Send"}
          </button>
        </div>
      )}
      {/* `/rewind`: pick one of our own prompts to jump back to (newest first,
          mirroring the CLI). Picking one opens the same confirmation the bubble
          button does. */}
      {rewindPickerOpen && (
        <RewindDialog
          title="Rewind to a prompt"
          onClose={() => setRewindPickerOpen(false)}
        >
          {rewindPoints.length === 0 ? (
            <div className="resume-empty">No prompts to rewind to yet.</div>
          ) : (
            [...rewindPoints].reverse().map((m) => (
              <div key={m.id} className="resume-item">
                <button className="resume-item-open" onClick={() => openRewind(m)}>
                  <span className="resume-item-title">
                    {promptText(m).split("\n")[0] || "(image-only prompt)"}
                  </span>
                  <span className="resume-item-time">{relativeTime(m.createdAt)}</span>
                </button>
              </div>
            ))
          )}
        </RewindDialog>
      )}
      {rewindTarget && (
        <RewindConfirm
          key={rewindTarget.id}
          message={rewindTarget}
          preview={state.rewindPreview}
          canRestoreFiles={state.capabilities.rewindFiles === true}
          onCancel={() => setRewindTarget(null)}
          onConfirm={(restoreFiles) => confirmRewind(rewindTarget, restoreFiles)}
        />
      )}
    </div>
    </AgentsContext.Provider>
  );
}
