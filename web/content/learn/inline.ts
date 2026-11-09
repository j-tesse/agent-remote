// Turn a learn page + its folder-relative assets into ONE self-contained HTML
// string. Needed because the preview iframe is sandboxed (opaque origin) and
// the auth cookie is SameSite=Strict, so the frame can't fetch assets itself.
import type { ContentPointer } from "../../../shared/content";
import { escapeScript, escapeStyle, planRef, type RefPlan } from "./refs";

const q = encodeURIComponent;

export interface InlineOptions {
  /** Script injected first in <head> (preview-only; never written to disk). */
  bootstrap?: string;
}

/** Fetched page text, or throws with the server's message. */
export async function fetchPage(folder: string, path: string): Promise<string> {
  const r = await fetch(`/api/file?cwd=${q(folder)}&path=${q(path)}`);
  const body = (await r.json()) as { content?: string; message?: string };
  if (!r.ok) throw new Error(body.message ?? "Couldn't read the file.");
  return body.content ?? "";
}

async function loadText(folder: string, path: string): Promise<string | null> {
  try {
    return await fetchPage(folder, path);
  } catch {
    return null;
  }
}

async function loadDataUrl(folder: string, plan: RefPlan): Promise<string | null> {
  try {
    if (plan.kind === "text") {
      const text = await loadText(folder, plan.path);
      return text === null ? null : `data:${plan.mime};charset=utf-8,${q(text)}`;
    }
    const r = await fetch(`/api/media?cwd=${q(folder)}&path=${q(plan.path)}`);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// Elements whose URL attribute becomes a data URL.
const URL_ATTRS: [string, string][] = [
  ["img", "src"],
  ["source", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
  ["image", "href"],
  ["image", "xlink:href"],
  ["use", "href"],
];

/** `html` with every inlinable relative ref inlined (unresolvable ones are left as-is). */
export async function inlinePage(
  html: string,
  folder: string,
  pointer: ContentPointer,
  opts: InlineOptions = {},
): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // One fetch per distinct asset, however often it's referenced.
  const cache = new Map<string, Promise<string | null>>();
  const once = (key: string, load: () => Promise<string | null>) => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key)!;
  };
  const jobs: Promise<void>[] = [];

  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]')) {
    const plan = planRef(pointer.path, link.getAttribute("href"));
    if (plan?.kind !== "text") continue;
    jobs.push(
      once(`t:${plan.path}`, () => loadText(folder, plan.path)).then((css) => {
        if (css === null) return;
        const style = doc.createElement("style");
        style.textContent = escapeStyle(css);
        style.dataset.lkSrc = plan.path;
        link.replaceWith(style);
      }),
    );
  }
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[src]")) {
    const plan = planRef(pointer.path, script.getAttribute("src"));
    if (plan?.kind !== "text") continue;
    jobs.push(
      once(`t:${plan.path}`, () => loadText(folder, plan.path)).then((js) => {
        if (js === null) return;
        const inline = doc.createElement("script");
        for (const a of script.attributes) if (a.name !== "src") inline.setAttribute(a.name, a.value);
        inline.textContent = escapeScript(js);
        inline.dataset.lkSrc = plan.path;
        script.replaceWith(inline);
      }),
    );
  }
  for (const [tag, attr] of URL_ATTRS) {
    for (const el of doc.getElementsByTagName(tag)) {
      const value = el.getAttribute(attr);
      // `use href="#id"` / "sprite.svg#id": keep the fragment on the data URL.
      const hash = value?.includes("#") ? value.slice(value.indexOf("#")) : "";
      const plan = planRef(pointer.path, value);
      if (!plan) continue;
      jobs.push(
        once(`d:${plan.path}`, () => loadDataUrl(folder, plan)).then((url) => {
          if (url) el.setAttribute(attr, url + hash);
        }),
      );
    }
  }
  await Promise.all(jobs);

  if (opts.bootstrap) {
    const s = doc.createElement("script");
    s.textContent = escapeScript(opts.bootstrap);
    doc.head.prepend(s);
  }
  const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : "<!doctype html>\n";
  return doctype + doc.documentElement.outerHTML;
}
