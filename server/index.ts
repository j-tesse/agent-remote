import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { buildAdapters } from "./adapters/registry.js";
import { SessionManager } from "./sessions/manager.js";
import {
  listFolders,
  upsertFolder,
  removeFolder,
  recordCommand,
  upsertChatSession,
  setChatSessionTitle,
  listResumableSessions,
  deleteChatSession,
  listChatRenderLog,
  getUserView,
  setUserView,
  closeDb,
  getModelNames,
  setModelNames,
} from "./db.js";
import { recordChatRenders, forgetChatRenders } from "./chatLog.js";
import { listCommands, resolveCommand, RESOLVER_IDS } from "./commands.js";
import {
  listDir,
  readTextFile,
  writeTextFile,
  openDownload,
  saveBinaryFile,
  statEntry,
  parseRange,
} from "./files.js";
import { mediaTypeFor } from "../shared/media.js";
import { browseDirs } from "./browse.js";
import {
  saveUpload,
  loadUpload,
  isAllowedImageType,
  MAX_IMAGE_BYTES,
} from "./uploads.js";
import { authedUser, handleAuthRoute } from "./auth.js";
import { normalizeFolder } from "./paths.js";
import { startLlmPolling, llmStatus } from "./llm.js";
import {
  noteSystemWatcher,
  startSystemSampling,
  systemSnapshot,
} from "./system/sampler.js";
import { attachAssistant } from "./assistant.js";
import { attachSuggestions } from "./suggestions.js";
import { attachModelNames } from "./modelNames.js";
import { attachTurnRouter } from "./turnRouter.js";
import { attachContinuity } from "./continuity.js";
import { attachSessionTools } from "./sessionTools.js";
import type {
  ChatImageRef,
  ClientMessage,
  HarnessInfo,
  ServerMessage,
  ViewState,
} from "../shared/protocol.js";

// Single port for UI, /api, and /ws. Dev (--dev): Vite in middleware mode on
// this server (UI + HMR). Prod: serve prebuilt dist/web.
const DEV = process.argv.includes("--dev");

const config = loadConfig();
const adapters = buildAdapters(config);
const manager = new SessionManager(adapters);
const PORT = config.server?.port ?? 4000;

// Best-effort LLM assist: poll the configured endpoint's health in the
// background. Never blocks startup; unavailable is fine.
startLlmPolling(config.llm);

// System state page: seed one cheap /proc sample so the first GET isn't empty.
// Sampling itself only runs while a browser is actually watching — see
// noteSystemWatcher in server/system/sampler.ts.
startSystemSampling(config);

// Backend AI-assistant mode: a server-global decider that auto-answers chat
// permission/question cards for sessions that enabled it — runs regardless of
// whether any browser is connected. See server/assistant.ts.
attachAssistant(manager);

// Harness-agnostic next-prompt suggestions: for chat harnesses that don't emit
// their own (pi and future ones — Claude does, so it's skipped), synthesize a
// composer-chip suggestion from the transcript after each turn. See
// server/suggestions.ts. Best-effort; no-op when the LLM endpoint is down.
attachSuggestions(manager, adapters);

// LLM-generated readable model names for harnesses with raw-id catalogs (pi).
// Persisted per catalog, so names survive restarts until the list changes.
// See server/modelNames.ts.
attachModelNames(manager, adapters, { get: getModelNames, set: setModelNames });

// Where a settled turn goes: the LLM routes it to auto-PR (branch/commit/push,
// open the PR by driving a real `pi /pr` session, and with `auto merge`
// squash-merge it and return to main) or to Continuity Mode (write and send the
// developer's next message). See server/turnRouter.ts.
attachTurnRouter(manager, config.autoPr);

// The other half of Continuity Mode: cancel an armed prompt when a human types,
// withdraws it, or the session moves on. See server/continuity.ts.
attachContinuity(manager);

// Host tools: agents (claude) can spawn and drive other chat sessions as
// ordinary tabs, rate-limited globally. See server/sessionTools.ts.
attachSessionTools(manager, () => listFolders().map((f) => f.path));

const harnesses: HarnessInfo[] = [...adapters.values()].map((a) => ({
  id: a.id,
  name: a.name,
}));

// Server-global subscriber recording every command run (with cwd) for the
// builder's recent/frequent lists. Must NOT live in the per-connection
// subscription below, or each browser would double-record.
manager.subscribe({
  onStarted() {},
  onOutput() {},
  onExit() {},
  onEvent(sessionId, event) {
    if (event.type !== "command-start") return;
    // Chat sessions mirror busy via command events — those are prompts, not
    // shell commands; keep them out of recents.
    if (manager.sessionUi(sessionId) === "chat") return;
    const command = event.command.trim();
    const cwd = manager.sessionCwd(sessionId) ?? "";
    if (command && cwd) recordCommand(command, cwd, event.at);
  },
  // Persist resumable chat sessions (DB is the source of truth for the resume
  // list): record the key at init, set the title from the first user prompt.
  onResumable(sessionId, key) {
    const info = manager.sessionInfo(sessionId);
    const folder = manager.sessionFolder(sessionId);
    if (!info || !folder) return;
    upsertChatSession({
      resumeKey: key,
      harnessId: info.harnessId,
      harnessName: info.harnessName,
      folder,
    });
  },
  onChatEvent(sessionId, event) {
    // Log finalized-message renders (diagnostics). Skip high-frequency streaming
    // events (and draft keystrokes, which touch no message) — final form lands
    // on assistant-end/tool-end; chatLog dedupes.
    // An agent-event is as frequent as whatever it wraps, so judge the inner one.
    const kind =
      event.type === "agent-event" ? event.event.type : event.type;
    if (kind !== "part-delta" && kind !== "tool-update" && kind !== "draft") {
      const state = manager.chatState(sessionId);
      const info = manager.sessionInfo(sessionId);
      if (state)
        recordChatRenders(sessionId, state, {
          harnessId: info?.harnessId,
          cwd: info?.cwd,
        });
    }
    if (event.type !== "user-message") return;
    const key = manager.resumeKey(sessionId);
    if (!key) return;
    const text = event.message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim()
      .split("\n", 1)[0];
    if (text) setChatSessionTitle(key, text.slice(0, 120));
  },
  onRemoved(sessionId) {
    forgetChatRenders(sessionId);
  },
});

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;
let viteMiddlewares: Middleware | undefined;

const server = createHttpServer((req, res) => {
  // Auth routes (login/register/logout/me) are always reachable.
  void handleAuthRoute(req, res, config).then((handled) => {
    if (handled) return;
    routeAfterAuth(req, res);
  });
});

function routeAfterAuth(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/api/harnesses") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(harnesses));
    return;
  }
  if (req.method === "GET" && url.startsWith("/api/commands")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const cwd = new URL(url, "http://x").searchParams.get("cwd") ?? "";
    // Allowlist to opened folders so this isn't an arbitrary filesystem browser.
    if (!listFolders().some((f) => f.path === cwd)) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Unknown folder." }));
      return;
    }
    void listCommands(cwd).then(
      (listing) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(listing));
      },
      (err: unknown) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: (err as Error).message }));
      },
    );
    return;
  }
  if (req.method === "GET" && url.startsWith("/api/resolve")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const id = params.get("id") ?? "";
    const cwd = params.get("cwd") ?? "";
    // Folder allowlist + known resolver id (client supplies only an id, never a command).
    if (!RESOLVER_IDS.has(id) || !listFolders().some((f) => f.path === cwd)) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Unknown resolver or folder." }));
      return;
    }
    void resolveCommand(id, cwd).then(
      (result) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      },
      (err: unknown) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: (err as Error).message }));
      },
    );
    return;
  }
  // Resumable chat sessions for a folder (GET) / forget one (DELETE).
  if (url.startsWith("/api/resumable")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    if (req.method === "GET") {
      const cwd = params.get("cwd") ?? "";
      if (!listFolders().some((f) => f.path === cwd))
        return sendJsonError(res, 400, "Unknown folder.");
      // Hide sessions that are currently open — you resume closed ones.
      const live = manager.liveResumeKeys();
      const sessions = listResumableSessions(cwd).filter(
        (s) => !live.has(s.resumeKey),
      );
      return sendJson(res, sessions);
    }
    if (req.method === "DELETE") {
      const key = params.get("key") ?? "";
      if (key) deleteChatSession(key);
      return sendJson(res, { ok: true });
    }
  }
  // Last view (folder + tab) of the requesting user. Read on page load, written
  // as the view changes; deliberately not pushed over /ws, so an open tab is
  // never yanked around by another device.
  if (url === "/api/view") {
    const user = authedUser(req, config);
    if (!user) return sendUnauthorized(res);
    if (req.method === "GET") return sendJson(res, getUserView(user));
    if (req.method === "PUT") {
      readTextBody(req)
        .then((body) => {
          const raw = JSON.parse(body) as Partial<ViewState>;
          setUserView(user, {
            folder: typeof raw.folder === "string" ? raw.folder : null,
            sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
          });
          sendJson(res, { ok: true });
        })
        .catch(() => sendJsonError(res, 400, "Bad view."));
      return;
    }
  }
  // Chat render log (read-only diagnostics). ?session= filters, ?limit= caps rows.
  if (req.method === "GET" && url.startsWith("/api/chat-log")) {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const session = params.get("session") || undefined;
    const limit = Math.min(
      Math.max(Number(params.get("limit")) || 100, 1),
      1000,
    );
    return sendJson(res, listChatRenderLog(limit, session));
  }
  // Optional LLM assist: the UI polls health for the assistant-mode button
  // color/gate. The actual evaluation runs on the backend (server/assistant.ts),
  // not over REST — so AI-assistant mode works with no browser open.
  if (req.method === "GET" && url === "/api/llm-status") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    return sendJson(res, llmStatus());
  }
  // Host/GPU/engine/docker telemetry for the System state page. Cheap by
  // construction: reads a snapshot a background sampler refreshes, and the GET
  // itself is the "a browser is watching" heartbeat keeping that sampler alive
  // (it stops a few seconds after the page closes). Auth-gated like every
  // sibling — the snapshot names host processes and containers.
  if (req.method === "GET" && url === "/api/system") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    noteSystemWatcher();
    return sendJson(res, systemSnapshot());
  }
  // File editor: list/read/write under a known folder root (files.ts confines
  // every path to it).
  const pathname = new URL(url, "http://x").pathname;
  if (pathname === "/api/files" && req.method === "GET") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    void listDir(cwd, path).then(
      (listing) => sendJson(res, listing),
      (err: unknown) => sendJsonError(res, 400, (err as Error).message),
    );
    return;
  }
  // Add-folder picker: subdirectories of any readable path (see browse.ts for
  // why this one isn't folder-allowlisted).
  if (pathname === "/api/browse" && req.method === "GET") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const path = new URL(url, "http://x").searchParams.get("path") ?? "";
    void browseDirs(path).then(
      (listing) => sendJson(res, listing),
      (err: unknown) => sendJsonError(res, 400, (err as Error).message),
    );
    return;
  }
  if (pathname === "/api/file") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    if (req.method === "GET") {
      void readTextFile(cwd, path).then(
        (file) => sendJson(res, file),
        (err: unknown) => sendJsonError(res, 400, (err as Error).message),
      );
      return;
    }
    if (req.method === "PUT") {
      void readTextBody(req)
        .then((content) => writeTextFile(cwd, path, content))
        .then(
          () => sendJson(res, { ok: true }),
          (err: unknown) => sendJsonError(res, 400, (err as Error).message),
        );
      return;
    }
  }
  // File transfer: download any file out of a folder, upload any file into it.
  // Same auth + folder allowlist as /api/file; files.ts confines the path. Both
  // stream, so a large artifact never buffers in memory.
  if (pathname === "/api/download" && req.method === "GET") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    void openDownload(cwd, path).then(
      ({ size, name, stream }) => {
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", String(size));
        res.setHeader("content-disposition", contentDisposition(name));
        stream.pipe(res);
        stream.on("error", () => res.destroy());
      },
      (err: unknown) => sendJsonError(res, 400, (err as Error).message),
    );
    return;
  }
  // Inline media for the Files-tab preview. Separate from /api/download (always
  // an attachment) because a preview needs a real content-type, an inline
  // disposition and Range: Safari won't start a <video> without a 206.
  if (pathname === "/api/media" && req.method === "GET") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    // Closed allowlist: this route can never serve text/html out of a folder.
    const mediaType = mediaTypeFor(path);
    if (!mediaType) return sendJsonError(res, 400, "Not a previewable media file.");
    void statEntry(cwd, path)
      .then(async (info) => {
        if (!info || info.isDir) return sendJsonError(res, 404, "File not found.");
        const range = parseRange(req.headers.range, info.size);
        if (range === "unsatisfiable") {
          res.statusCode = 416;
          res.setHeader("content-range", `bytes */${info.size}`);
          return res.end();
        }
        const { name, stream } = await openDownload(cwd, path, range ?? undefined);
        res.setHeader("content-type", mediaType);
        res.setHeader("accept-ranges", "bytes");
        res.setHeader("content-disposition", contentDisposition(name, "inline"));
        res.setHeader("cache-control", "private, no-store"); // the agent rewrites these
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-security-policy", "default-src 'none'; sandbox");
        if (range) {
          res.statusCode = 206;
          res.setHeader("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
          res.setHeader("content-length", String(range.end - range.start + 1));
        } else {
          res.setHeader("content-length", String(info.size));
        }
        stream.pipe(res);
        stream.on("error", () => res.destroy());
        // Dismissing a large video mid-load would otherwise leak an fd.
        res.on("close", () => stream.destroy());
      })
      .catch((err: unknown) => sendJsonError(res, 400, (err as Error).message));
    return;
  }
  if (pathname === "/api/file-upload" && req.method === "POST") {
    if (!authedUser(req, config)) return sendUnauthorized(res);
    const params = new URL(url, "http://x").searchParams;
    const cwd = params.get("cwd") ?? "";
    const path = params.get("path") ?? "";
    const overwrite = params.get("overwrite") === "1";
    if (!listFolders().some((f) => f.path === cwd))
      return sendJsonError(res, 400, "Unknown folder.");
    void statEntry(cwd, path)
      .then(async (existing) => {
        if (existing?.isDir) throw new Error("Path is a directory.");
        // 409 lets the client confirm an overwrite and retry; the picker gives
        // no other warning that a name is already taken.
        if (existing && !overwrite) {
          res.statusCode = 409;
          return sendJson(res, { message: "File already exists.", exists: true });
        }
        await saveBinaryFile(cwd, path, req);
        sendJson(res, { ok: true });
      })
      .catch((err: unknown) => sendJsonError(res, 400, (err as Error).message));
    return;
  }
  // Image uploads: store a user's attached image (POST) and serve it back
  // (GET). Both auth-gated; the serve route additionally enforces per-user
  // ownership so a guessed id can't leak another user's image.
  if (pathname === "/api/upload" && req.method === "POST") {
    const user = authedUser(req, config);
    if (!user) return sendUnauthorized(res);
    const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim();
    if (!isAllowedImageType(mediaType))
      return sendJsonError(res, 400, "Unsupported image type.");
    const name = new URL(url, "http://x").searchParams.get("name") ?? undefined;
    void readBinaryBody(req, MAX_IMAGE_BYTES)
      .then((buf) => saveUpload(user, mediaType, name, buf))
      .then(
        (id) => sendJson(res, { id, mediaType, name }),
        (err: unknown) => sendJsonError(res, 400, (err as Error).message),
      );
    return;
  }
  if (pathname.startsWith("/api/upload/") && req.method === "GET") {
    const user = authedUser(req, config);
    if (!user) return sendUnauthorized(res);
    const id = decodeURIComponent(pathname.slice("/api/upload/".length));
    void loadUpload(user, id).then(
      (img) => {
        if (!img) {
          res.statusCode = 404;
          return res.end("Not found");
        }
        res.setHeader("content-type", img.mediaType);
        res.setHeader("cache-control", "private, max-age=31536000, immutable");
        res.end(img.buf);
      },
      () => {
        res.statusCode = 404;
        res.end("Not found");
      },
    );
    return;
  }
  if (viteMiddlewares) {
    viteMiddlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
    return;
  }
  serveStatic(req.url ?? "/", res);
}

function sendUnauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: "Not logged in." }));
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message }));
}

// Build a Content-Disposition for a download. Non-ASCII names need the RFC 5987
// `filename*` form; the plain `filename` stays as an ASCII-only fallback.
function contentDisposition(
  name: string,
  kind: "attachment" | "inline" = "attachment",
): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Read a raw text request body (PUT /api/file), capped so one write can't
// exhaust memory (matches files.ts's MAX_FILE_BYTES).
function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) reject(new Error("File is too large."));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Read a raw binary request body (POST /api/upload), capped so one upload can't
// exhaust memory. Unlike readTextBody it never coerces to a string (which would
// corrupt image bytes).
function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Image is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Resolve a prompt's image refs to base64, loading only images owned by `user`
// (ownership enforced in loadUpload). Unknown/foreign ids are silently dropped
// so a prompt can never smuggle another user's image to the agent. The returned
// refs keep id/mediaType/name (for the transcript bubble) and gain `data`.
async function resolvePromptImages(
  user: string,
  refs: ChatImageRef[],
): Promise<ChatImageRef[]> {
  const out: ChatImageRef[] = [];
  for (const ref of refs) {
    const img = await loadUpload(user, ref.id);
    if (!img) continue;
    out.push({
      id: ref.id,
      mediaType: img.mediaType,
      name: img.name ?? ref.name,
      data: img.buf.toString("base64"),
    });
  }
  return out;
}

// --- WebSocket (/ws) -------------------------------------------------------
// noServer + manual upgrade routing so /ws coexists with Vite's HMR socket.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    // Security boundary: no PTY reachable without a valid session (cookies ride
    // the same-origin upgrade request).
    const user = authedUser(req, config);
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, user));
  }
  // Other upgrades (Vite HMR) handled by Vite's own upgrade listener.
});

// All live connections, so server-owned folder history can be broadcast to
// every browser.
const connections = new Set<WebSocket>();
function foldersMessage(): ServerMessage {
  return { type: "folders", folders: listFolders(), home: homedir() };
}
function broadcastFolders(): void {
  const msg = foldersMessage();
  const raw = JSON.stringify(msg);
  for (const ws of connections) ws.send(raw);
}

// Every input bumps its folder's timestamp (folders sort by last_used_at DESC),
// but the broadcast only matters when the *order* changes. lastActiveFolder
// suppresses the redundant re-broadcast per keystroke in the same folder.
let lastActiveFolder: string | undefined;

function markFolderActive(folder: string): void {
  upsertFolder(folder);
  if (folder === lastActiveFolder) return;
  lastActiveFolder = folder;
  broadcastFolders();
}

// Strip terminal report requests (Device Attributes `…c`, Device Status `…n`)
// from replayed scrollback — replaying them makes xterm re-answer into an idle
// prompt, echoing the reply as literal text (e.g. `1;2c`). Live output untouched.
const stripReports = (s: string): string =>
  s.replace(/\x1b\[[?>=]?[0-9;]*[cn]/g, "");

wss.on("connection", (ws: WebSocket, user: string) => {
  const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
  connections.add(ws);

  // Bring the new client up to date: folders, sessions, then history
  // (scrollback for terminals, a chat-state snapshot for chat sessions).
  send(foldersMessage());
  send({ type: "sessions", sessions: manager.list() });
  for (const session of manager.list()) {
    if (session.ui === "chat") {
      const state = manager.chatState(session.id);
      if (state) send({ type: "chatState", sessionId: session.id, state });
      continue;
    }
    const buffer = manager.buffer(session.id);
    if (buffer)
      send({ type: "output", sessionId: session.id, data: stripReports(buffer) });
  }

  const unsubscribe = manager.subscribe({
    onStarted: (session, replaces) => send({ type: "started", session, replaces }),
    onOutput: (sessionId, data) => send({ type: "output", sessionId, data }),
    onExit: (sessionId, exitCode) =>
      send({
        type: "exit",
        sessionId,
        exitCode,
        // Read back off the session: the listener signature carries only the
        // code, and a deliberate stop must look different from a crash.
        stopped: manager.sessionInfo(sessionId)?.stopped,
      }),
    onRemoved: (sessionId) => send({ type: "removed", sessionId }),
    onHidden: (sessionId) => send({ type: "hidden", sessionId }),
    onEvent: (sessionId, event) =>
      send({ type: "sessionEvent", sessionId, event }),
    onChatEvent: (sessionId, event) =>
      send({ type: "chatEvent", sessionId, event }),
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "start": {
          const cwd = normalizeFolder(msg.cwd || process.cwd());
          manager.start(msg.harnessId, {
            cwd,
            resume: msg.resume,
            replaces: typeof msg.replaces === "string" ? msg.replaces : undefined,
          });
          // Launching registers/bumps its folder for everyone.
          lastActiveFolder = cwd;
          upsertFolder(cwd);
          broadcastFolders();
          break;
        }
        case "input": {
          manager.input(msg.sessionId, msg.data);
          // Typing bumps its folder to the top of the list.
          const folder = manager.sessionFolder(msg.sessionId);
          if (folder) markFolderActive(folder);
          break;
        }
        case "resize":
          manager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        case "chatAction": {
          const { sessionId, action } = msg;
          // Resolve any attached image refs to base64 here (harness-agnostic),
          // loading only images owned by this connection's user. Foreign/unknown
          // ids are dropped. Then dispatch to the manager/adapter.
          if (action.type === "prompt" && action.images?.length) {
            void resolvePromptImages(user, action.images).then((images) => {
              manager.chatAction(sessionId, { ...action, images });
            });
          } else {
            manager.chatAction(sessionId, action);
          }
          // Prompting bumps its folder like terminal input.
          const folder = manager.sessionFolder(sessionId);
          if (folder) markFolderActive(folder);
          break;
        }
        case "stop":
          manager.stop(msg.sessionId);
          break;
        case "remove":
          manager.remove(msg.sessionId);
          break;
        case "addFolder": {
          const path = normalizeFolder(msg.path);
          // Typing a new path creates it; before the upsert so a failed mkdir adds nothing.
          mkdirSync(path, { recursive: true });
          lastActiveFolder = path;
          upsertFolder(path);
          broadcastFolders();
          break;
        }
        case "removeFolder": {
          const path = normalizeFolder(msg.path);
          if (path === lastActiveFolder) lastActiveFolder = undefined;
          removeFolder(path);
          broadcastFolders();
          break;
        }
      }
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    }
  });

  ws.on("close", () => {
    unsubscribe();
    connections.delete(ws);
  });
});

// --- Static serving of the built frontend (production) ---------------------
const WEB_DIST = resolve(process.cwd(), "dist/web");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function serveStatic(url: string, res: ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    res.statusCode = 404;
    res.end("Frontend not built. Run `npm run build`, or `npm run dev`.");
    return;
  }
  const path = url.split("?")[0];
  // Resolve within WEB_DIST, falling back to index.html for SPA routes.
  const candidate = normalize(
    join(WEB_DIST, path === "/" ? "/index.html" : path),
  );
  const file =
    candidate.startsWith(WEB_DIST) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
      ? candidate
      : join(WEB_DIST, "index.html");
  // A rebuild empties dist/web under a live server, so the file can vanish
  // between the check and the read. Never let that throw: an ENOENT escaping
  // this async handler used to kill the process (and every live session).
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    res.statusCode = 503;
    res.setHeader("retry-after", "5");
    res.end("Frontend is rebuilding — retry in a moment.");
    return;
  }
  res.setHeader(
    "content-type",
    CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
  );
  res.end(body);
}

// --- Dev: embed Vite in middleware mode (same port, with HMR) --------------
if (DEV) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  viteMiddlewares = vite.middlewares as unknown as Middleware;
}

// Fail loudly on a port collision — a stranded older server holding the port is
// how stale code keeps serving while every "restart" silently fails to bind.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use — another agent-remote server is ` +
        `probably still running. Stop it first:\n` +
        `  pkill -f "tsx watch server/index.ts"`,
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

// Stay alive on a stray throw: this process hosts every live agent session, so
// dying beats losing them only if state is truly corrupt — which a request-
// handler bug isn't. Log loudly instead (systemd would restart us into the
// same crash-loop anyway).
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server kept alive):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (server kept alive):", err);
});

// Checkpoint the WAL and close the DB cleanly on shutdown (tsx watch → SIGTERM
// on reload; Ctrl-C → SIGINT).
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  closeDb();
  console.log(`\nagent-remote stopped (${signal}).`);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => shutdown(sig));
}

server.listen(PORT, () => {
  console.log(
    `agent-remote ${DEV ? "(dev) " : ""}listening on http://localhost:${PORT}`,
  );
});
