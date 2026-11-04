import { useRef, useState, type ReactNode } from "react";
import type { Client } from "./client";
import type { SessionInfo } from "../shared/protocol";
import { CONTENT_VIEWS } from "./content";

type Pane = "chat" | "content";

// Co-create split: the chat agent left, the rendered content right. Desktop shows
// both halves; narrow screens show one at a time, swapped by a bottom slider.
export default function CoCreateView({
  client,
  session,
  active,
  narrow,
  keyboardOpen,
  renderChat,
}: {
  client: Client;
  session: SessionInfo & { content: NonNullable<SessionInfo["content"]> };
  active: boolean;
  narrow: boolean;
  keyboardOpen: boolean;
  /** The ChatView, told whether it's on screen (drives its focus/display). */
  renderChat: (visible: boolean) => ReactNode;
}) {
  const [pane, setPane] = useState<Pane>("chat");
  const View = CONTENT_VIEWS[session.content.mediaType];
  const showChat = !narrow || pane === "chat";
  const showContent = !narrow || pane === "content";

  return (
    <div className="cocreate" style={{ display: active ? "flex" : "none" }}>
      <div className="cocreate-panes">
        <div className="cocreate-pane chat" style={{ display: showChat ? undefined : "none" }}>
          {renderChat(active && showChat)}
        </div>
        <div
          className="cocreate-pane content"
          style={{ display: showContent ? undefined : "none" }}
        >
          <View
            client={client}
            sessionId={session.id}
            folder={session.folder}
            pointer={session.content}
          />
        </div>
      </div>
      {narrow && !keyboardOpen && <PaneSlider pane={pane} onChange={setPane} />}
    </div>
  );
}

/** Two-position slider: drag the thumb (snaps to the nearer side) or tap a half. */
function PaneSlider({ pane, onChange }: { pane: Pane; onChange: (p: Pane) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Thumb position (0 = chat, 1 = content) while a drag is in progress.
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; from: number; moved: boolean } | null>(null);

  const fraction = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    trackRef.current!.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, from: pane === "chat" ? 0 : 1, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const width = trackRef.current!.getBoundingClientRect().width / 2;
    if (Math.abs(e.clientX - s.x) > 6) s.moved = true;
    if (s.moved) setDrag(Math.min(1, Math.max(0, s.from + (e.clientX - s.x) / width)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    // A drag snaps to the nearer side; a tap picks the half it landed on.
    const at = s.moved ? (drag ?? s.from) : fraction(e.clientX);
    setDrag(null);
    onChange(at >= 0.5 ? "content" : "chat");
  };

  const pos = drag ?? (pane === "chat" ? 0 : 1);
  return (
    <div className="cocreate-slider">
      <div
        ref={trackRef}
        className={`cocreate-slider-track ${drag !== null ? "dragging" : ""}`}
        role="switch"
        aria-checked={pane === "content"}
        aria-label="Show preview"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onChange("chat");
          else if (e.key === "ArrowRight") onChange("content");
          else if (e.key === " " || e.key === "Enter")
            onChange(pane === "chat" ? "content" : "chat");
        }}
        style={{ ["--pos" as string]: pos }}
      >
        <div className="cocreate-slider-thumb" />
        <span className={`cocreate-slider-label ${pane === "chat" ? "on" : ""}`}>Chat</span>
        <span className={`cocreate-slider-label ${pane === "content" ? "on" : ""}`}>Preview</span>
      </div>
    </div>
  );
}
