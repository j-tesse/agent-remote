// Download a learn page as one standalone .html file (assets inlined).
import type { ContentPointer } from "../../../shared/content";
import { fetchPage, inlinePage } from "./inline";

/** Download name: the page's basename, always ending in `.html`. */
export function exportFileName(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const stem = base.replace(/\.html?$/i, "");
  return `${stem || "page"}.html`;
}

/** `html` guaranteed to open with a doctype (else browsers render quirks mode). */
export function withDoctype(html: string): string {
  return /^\s*<!doctype\s/i.test(html) ? html : `<!doctype html>\n${html}`;
}

export async function exportStandalone(folder: string, pointer: ContentPointer): Promise<void> {
  const page = await fetchPage(folder, pointer.path);
  // No bootstrap: that's preview-only scaffolding.
  const html = withDoctype(await inlinePage(page, folder, pointer));
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(pointer.path);
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Safari aborts the download if the URL is revoked synchronously.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
