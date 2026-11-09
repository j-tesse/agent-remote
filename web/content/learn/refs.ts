// Which of a learn page's asset refs the preview inlines, and how. Pure, so the
// decisions are testable without a DOM.
import { resolveContentLink } from "../../../shared/content";
import { mediaTypeFor } from "../../../shared/media";

/** `text`: fetched via /api/file and inlined as source (CSS/JS/SVG).
 * `media`: fetched via /api/media and inlined as a data URL. */
export type RefPlan =
  | { kind: "text"; path: string; mime: string }
  | { kind: "media"; path: string; mime: string };

const TEXT_MIME: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  svg: "image/svg+xml",
};

/** Plan for one ref; null leaves it untouched (absolute URLs, data:, escapes). */
export function planRef(docPath: string, href: string | null | undefined): RefPlan | null {
  if (!href) return null;
  const path = resolveContentLink(docPath, href.trim());
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_MIME[ext]) return { kind: "text", path, mime: TEXT_MIME[ext] };
  const mime = mediaTypeFor(path);
  return mime ? { kind: "media", path, mime } : null;
}

/** An inlined script must not be able to close its own <script> element. */
export const escapeScript = (src: string) => src.replace(/<\/(script)/gi, "<\\/$1");
/** Same for an inlined <style>. */
export const escapeStyle = (src: string) => src.replace(/<\/(style)/gi, "<\\/$1");
