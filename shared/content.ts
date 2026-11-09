// Co-create media-type registry: what a content pane can show and how the agent
// is told about it. Harness-agnostic — adapters only ever see the framing text.

export type ContentMediaType = "markdown" | "learn";

/** What a co-create session's right pane shows: a media type + a path relative
 * to the session folder (a file, or a folder for folder-kind types). */
export interface ContentPointer {
  mediaType: ContentMediaType;
  path: string;
}

export interface ContentType {
  label: string;
  pointer: "file" | "folder";
  /** Lowercase, with the dot. Empty for folder pointers. */
  extensions: string[];
  defaultName: string;
  /** Appended to the agent's system prompt. */
  instructions(path: string): string;
}

/** Where a learn page's kit lives, relative to the session folder. */
export function learnKitDir(path: string): string {
  const dir = path.split("/").slice(0, -1).join("/");
  return dir ? `${dir}/learnkit` : "learnkit";
}

export const CONTENT_TYPES: Record<ContentMediaType, ContentType> = {
  markdown: {
    label: "Markdown",
    pointer: "file",
    extensions: [".md", ".markdown"],
    defaultName: "notes.md",
    instructions: (path) =>
      [
        "# Co-create mode",
        `You are co-creating the markdown document \`${path}\` (relative to the working directory) with the user.`,
        "The user sees that file rendered live in a preview pane beside this chat and cannot edit it themselves: every change they ask for must be made by you, by editing that file with your file tools.",
        "Unless the user says otherwise, requests refer to this document.",
        "Keep chat replies brief — the document is the deliverable. Never paste the document (or large parts of it) into chat; summarize what you changed instead.",
        "You may read other files in the working directory for context.",
      ].join("\n"),
  },
  learn: {
    label: "Mobile learning",
    pointer: "file",
    extensions: [".html", ".htm"],
    defaultName: "lesson.html",
    instructions: (path) => {
      const kit = learnKitDir(path);
      return [
        "# Co-create mode: mobile learning page",
        `You are co-creating \`${path}\` (relative to the working directory) with the user: ONE self-contained HTML page, read on a phone by scrolling top to bottom, that explains a topic visually.`,
        "The user sees it rendered live beside this chat and cannot edit it: every change they ask for must be made by you, editing that file with your file tools. Unless they say otherwise, requests refer to this page.",
        "Keep chat replies brief — the page is the deliverable. Never paste it into chat; summarize what you changed.",
        "",
        "## Kit",
        `\`${kit}/\` holds learnkit (kit.css + kit.js): ready-made layout, scroll reveals, scrollytelling, SVG line drawing, counters, steppers, sliders, quizzes, tap-to-reveal. Read \`${kit}/README.md\` before your first edit and use the kit instead of writing your own versions.`,
        `Never edit \`${kit}/\`. Page-specific styles/scripts go in the page's own <style>/<script>. No CDNs or network requests; images/SVG files go beside the page and are referenced relatively. Prefer inline SVG for diagrams.`,
        "",
        "## Approach",
        "- Arc: hook (a question or surprising fact) → intuition → build up one step at a time → worked example → check yourself (quiz) → recap.",
        "- One idea per screen. Visual first, words second; at most ~3 short sentences per block. Define a term before using it.",
        "- Animate to explain (show change, cause, sequence), never to decorate. Every animation must also make sense as its end state (reduced motion).",
        "- Design for a 360–430px portrait screen: single column, no horizontal scroll, text ≥16px, tap targets ≥44px, nothing hover-only. Diagrams must stay legible at that width (big labels, few elements).",
        "- Build incrementally: get the arc in place first, then enrich screens with visuals and interactions.",
      ].join("\n");
    },
  },
};

export const isContentMediaType = (v: unknown): v is ContentMediaType =>
  typeof v === "string" && Object.hasOwn(CONTENT_TYPES, v);

/** Normalized pointer, or null when it's unusable. Shared client/server gate;
 * the server still confines the path to the folder (`files.ts`). */
export function validatePointer(raw: unknown): ContentPointer | null {
  if (!raw || typeof raw !== "object") return null;
  const { mediaType, path } = raw as Record<string, unknown>;
  if (!isContentMediaType(mediaType) || typeof path !== "string") return null;
  const type = CONTENT_TYPES[mediaType];
  const segs = path
    .trim()
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (path.trim().startsWith("/") || segs.length === 0) return null;
  if (segs.some((s) => s === ".." || s.includes("\0"))) return null;
  const rel = segs.join("/");
  if (type.pointer === "file") {
    if (path.trim().endsWith("/")) return null;
    const base = segs[segs.length - 1].toLowerCase();
    if (!type.extensions.some((e) => base.endsWith(e) && base.length > e.length))
      return null;
  }
  return { mediaType, path: rel };
}

/** Whether a file name fits a type's extensions (picker filtering). */
export function matchesType(mediaType: ContentMediaType, name: string): boolean {
  const lower = name.toLowerCase();
  return CONTENT_TYPES[mediaType].extensions.some((e) => lower.endsWith(e));
}

/** A link/image `href` inside the document → a folder-relative path, or null
 * when it's absolute (URL, `/x`, `#frag`, `data:`) or escapes the folder. */
export function resolveContentLink(docPath: string, href: string): string | null {
  const ref = href.split(/[?#]/, 1)[0];
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("//"))
    return null;
  const out = docPath.split("/").slice(0, -1);
  for (const seg of decodeURIComponentSafe(ref).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join("/") : null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
