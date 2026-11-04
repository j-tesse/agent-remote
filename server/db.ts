import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  FolderInfo,
  ResumableSession,
  ViewState,
} from "../shared/protocol.js";
import { expandHome, normalizeFolder } from "./paths.js";
import { validatePointer, type ContentPointer } from "../shared/content.js";

// The project's only persistence layer: folders, user accounts, login sessions,
// command log, and resumable chat sessions all survive restarts here (live PTYs
// can't). Shared across browsers via the server.

const DB_PATH = resolve(process.cwd(), "data/agent-remote.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(
  `CREATE TABLE IF NOT EXISTS folders (
     path TEXT PRIMARY KEY,
     last_used_at INTEGER NOT NULL
   )`,
);
db.exec(
  `CREATE TABLE IF NOT EXISTS users (
     username TEXT PRIMARY KEY,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
);
// Login sessions, keyed by an opaque random token in the browser's cookie.
// Named auth_sessions to avoid confusion with live agent (PTY) sessions.
db.exec(
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     token TEXT PRIMARY KEY,
     username TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
);
// Commands run in Terminal sessions (via shell integration), with their cwd.
// Powers the command builder's recent/frequent lists.
db.exec(
  `CREATE TABLE IF NOT EXISTS commands (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     command TEXT NOT NULL,
     cwd TEXT NOT NULL,
     ran_at INTEGER NOT NULL
   )`,
);
db.exec("CREATE INDEX IF NOT EXISTS commands_ran_at ON commands(ran_at)");
db.exec("CREATE INDEX IF NOT EXISTS commands_cwd ON commands(cwd)");
// Resumable chat sessions: harness-native resume key (e.g. Claude SDK session
// id) + its folder, so a conversation can be reopened after the tab closes or
// the server restarts. Rows outlive the live session.
db.exec(
  `CREATE TABLE IF NOT EXISTS chat_sessions (
     resume_key TEXT PRIMARY KEY,
     harness_id TEXT NOT NULL,
     harness_name TEXT NOT NULL,
     folder TEXT NOT NULL,
     title TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
);
db.exec(
  "CREATE INDEX IF NOT EXISTS chat_sessions_folder ON chat_sessions(folder)",
);
// Co-create pointer (JSON), added after the table shipped — so migrate in place.
if (
  !(db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[]).some(
    (c) => c.name === "content",
  )
)
  db.exec("ALTER TABLE chat_sessions ADD COLUMN content TEXT");
// Chat render log (diagnostics): one row per rendered message, both the original
// ChatMessage and its rendered form (HTML + component/class per part). Keyed by
// (session, message), upserted so late tool results refresh the row.
db.exec(
  `CREATE TABLE IF NOT EXISTS chat_render_log (
     session_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     role TEXT NOT NULL,
     harness_id TEXT,
     cwd TEXT,
     original TEXT NOT NULL,
     rendered TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, message_id)
   )`,
);
db.exec(
  "CREATE INDEX IF NOT EXISTS chat_render_log_updated ON chat_render_log(updated_at)",
);
// User-uploaded images (attached to chat prompts). Bytes live on disk under
// data/uploads/; this table is the ownership record so a stored image can only
// be served/used by the user who uploaded it. Pruned probabilistically.
db.exec(
  `CREATE TABLE IF NOT EXISTS uploads (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     media_type TEXT NOT NULL,
     name TEXT,
     bytes INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
);
db.exec("CREATE INDEX IF NOT EXISTS uploads_created ON uploads(created_at)");
// Last view (folder + tab) per user, so a page load on another device resumes
// where you left off. One row per user, overwritten in place.
db.exec(
  `CREATE TABLE IF NOT EXISTS user_views (
     owner TEXT PRIMARY KEY,
     folder TEXT,
     session_id TEXT,
     updated_at INTEGER NOT NULL
   )`,
);

// LLM model display names, keyed by a hash of the whole catalog (+ prompt
// version) — names depend on the catalog, so any change is a miss. Few rows.
db.exec(
  `CREATE TABLE IF NOT EXISTS model_names (
     catalog_key TEXT PRIMARY KEY,
     names TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
);

const listStmt = db.prepare(
  "SELECT path, last_used_at AS lastUsedAt FROM folders ORDER BY last_used_at DESC",
);
const upsertStmt = db.prepare(
  `INSERT INTO folders (path, last_used_at) VALUES (?, ?)
   ON CONFLICT(path) DO UPDATE SET last_used_at = excluded.last_used_at`,
);
const removeStmt = db.prepare("DELETE FROM folders WHERE path = ?");

// Tables whose rows are keyed by a path a folder row once handed them; a `~`
// row leaves them stranded from the expanded folder's queries.
const PATH_COLUMNS = [
  ["chat_sessions", "folder"],
  ["commands", "cwd"],
  ["chat_render_log", "cwd"],
] as const;

/** One-time migration of folder rows written before paths were normalized. A
 * legacy `~/x` row otherwise duplicates itself (opening it starts a session with
 * the expanded cwd, which upserts a *second* row); a slash-less `/x/y` row does
 * the same against `/x/y/`. Idempotent, so it's cheap to run at every boot. */
function migrateFolderPaths(): void {
  const folderRows = db
    .prepare("SELECT path, last_used_at AS ts FROM folders")
    .all() as { path: string; ts: number }[];
  const priorStmt = db.prepare(
    "SELECT last_used_at AS ts FROM folders WHERE path = ?",
  );
  db.transaction(() => {
    for (const { path, ts } of folderRows) {
      const next = normalizeFolder(path);
      if (next === path) continue; // already canonical (or `~user/…`: unexpandable)
      // Merge, don't rename: the canonical row may already exist.
      const prior = priorStmt.get(next) as { ts: number } | undefined;
      upsertStmt.run(next, Math.max(ts, prior?.ts ?? 0));
      removeStmt.run(path);
      // Only `~` needs re-pointing: these columns hold live cwds (subdirectories
      // included), whose trailing slash is theirs, not the folder key's.
      const expanded = expandHome(path);
      if (expanded === path) continue;
      for (const [t, c] of PATH_COLUMNS) {
        db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(expanded, path);
      }
    }
  })();
}
migrateFolderPaths();

export function listFolders(): FolderInfo[] {
  return listStmt.all() as FolderInfo[];
}

/** Insert the folder, or bump its recency if already known.
 * Normalizes here, not at the call site: the path is the row's identity, so one
 * un-normalized caller anywhere would fork a folder into two list entries. */
export function upsertFolder(path: string, ts = Date.now()): void {
  upsertStmt.run(normalizeFolder(path), ts);
}

export function removeFolder(path: string): void {
  removeStmt.run(normalizeFolder(path));
}

// --- command log -----------------------------------------------------------

// Bounded, pruned probabilistically on insert (exact ceiling doesn't matter).
const COMMAND_RETENTION = 10_000;

const recordCommandStmt = db.prepare(
  "INSERT INTO commands (command, cwd, ran_at) VALUES (?, ?, ?)",
);
const pruneCommandsStmt = db.prepare(
  `DELETE FROM commands
   WHERE id NOT IN (SELECT id FROM commands ORDER BY id DESC LIMIT ?)`,
);
// Recent: distinct commands, those run in the given cwd first (by recency there),
// then the rest by overall recency.
const recentCommandsStmt = db.prepare(
  `SELECT command FROM commands
   GROUP BY command
   ORDER BY MAX(CASE WHEN cwd = ? THEN ran_at END) IS NULL,
            MAX(CASE WHEN cwd = ? THEN ran_at END) DESC,
            MAX(ran_at) DESC
   LIMIT ?`,
);
// Frequent: distinct commands by overall count, those ever run in the given cwd
// first; ties broken by recency.
const frequentCommandsStmt = db.prepare(
  `SELECT command FROM commands
   GROUP BY command
   ORDER BY SUM(CASE WHEN cwd = ? THEN 1 ELSE 0 END) = 0,
            COUNT(*) DESC,
            MAX(ran_at) DESC
   LIMIT ?`,
);

/** Record a command run in a shell session, with the cwd it ran in. */
export function recordCommand(command: string, cwd: string, ts = Date.now()): void {
  recordCommandStmt.run(command, cwd, ts);
  if (Math.random() < 0.01) pruneCommandsStmt.run(COMMAND_RETENTION);
}

export function recentCommands(cwd: string, limit: number): string[] {
  return (recentCommandsStmt.all(cwd, cwd, limit) as { command: string }[]).map(
    (r) => r.command,
  );
}

export function frequentCommands(cwd: string, limit: number): string[] {
  return (frequentCommandsStmt.all(cwd, limit) as { command: string }[]).map(
    (r) => r.command,
  );
}

// --- resumable chat sessions -----------------------------------------------

// Cap the table like the command log; pruned probabilistically on upsert.
const CHAT_SESSION_RETENTION = 2_000;

const upsertChatSessionStmt = db.prepare(
  `INSERT INTO chat_sessions (resume_key, harness_id, harness_name, folder, title, content, created_at, updated_at)
   VALUES (@resumeKey, @harnessId, @harnessName, @folder, NULL, @content, @ts, @ts)
   ON CONFLICT(resume_key) DO UPDATE SET
     harness_id = excluded.harness_id,
     harness_name = excluded.harness_name,
     folder = excluded.folder,
     content = excluded.content,
     updated_at = excluded.updated_at`,
);
// Only set the title while still empty, so the first user prompt sticks as the label.
const setChatSessionTitleStmt = db.prepare(
  `UPDATE chat_sessions SET title = ?
   WHERE resume_key = ? AND (title IS NULL OR title = '')`,
);
const listResumableSessionsStmt = db.prepare(
  `SELECT resume_key AS resumeKey, harness_id AS harnessId,
          harness_name AS harnessName, COALESCE(title, '') AS title,
          updated_at AS updatedAt, content
   FROM chat_sessions WHERE folder = ? ORDER BY updated_at DESC`,
);
const deleteChatSessionStmt = db.prepare(
  "DELETE FROM chat_sessions WHERE resume_key = ?",
);
const pruneChatSessionsStmt = db.prepare(
  `DELETE FROM chat_sessions
   WHERE resume_key NOT IN (
     SELECT resume_key FROM chat_sessions ORDER BY updated_at DESC LIMIT ?
   )`,
);

/** Record (or refresh) a resumable session for the given folder. Leaves an
 * existing title untouched — only recency and location are updated. */
export function upsertChatSession(row: {
  resumeKey: string;
  harnessId: string;
  harnessName: string;
  folder: string;
  content?: ContentPointer;
  ts?: number;
}): void {
  upsertChatSessionStmt.run({
    ...row,
    content: row.content ? JSON.stringify(row.content) : null,
    ts: row.ts ?? Date.now(),
  });
  if (Math.random() < 0.02) pruneChatSessionsStmt.run(CHAT_SESSION_RETENTION);
}

/** Set the session's title if it has none yet (idempotent). */
export function setChatSessionTitle(resumeKey: string, title: string): void {
  setChatSessionTitleStmt.run(title, resumeKey);
}

/** Resumable sessions for a folder, newest first. */
export function listResumableSessions(folder: string): ResumableSession[] {
  return (
    listResumableSessionsStmt.all(folder) as (Omit<ResumableSession, "content"> & {
      content: string | null;
    })[]
  ).map(({ content, ...r }) => {
    let pointer = null;
    try {
      pointer = content ? validatePointer(JSON.parse(content)) : null;
    } catch {}
    return pointer ? { ...r, content: pointer } : r;
  });
}

export function deleteChatSession(resumeKey: string): void {
  deleteChatSessionStmt.run(resumeKey);
}

// --- chat render log --------------------------------------------------------

// Cap the table like the other logs; pruned probabilistically on write.
const CHAT_RENDER_LOG_RETENTION = 20_000;

const upsertChatRenderStmt = db.prepare(
  `INSERT INTO chat_render_log
     (session_id, message_id, role, harness_id, cwd, original, rendered, created_at, updated_at)
   VALUES (@sessionId, @messageId, @role, @harnessId, @cwd, @original, @rendered, @ts, @ts)
   ON CONFLICT(session_id, message_id) DO UPDATE SET
     role = excluded.role,
     harness_id = excluded.harness_id,
     cwd = excluded.cwd,
     original = excluded.original,
     rendered = excluded.rendered,
     updated_at = excluded.updated_at`,
);
const pruneChatRenderStmt = db.prepare(
  `DELETE FROM chat_render_log
   WHERE rowid NOT IN (
     SELECT rowid FROM chat_render_log ORDER BY updated_at DESC LIMIT ?
   )`,
);
const listChatRenderStmt = db.prepare(
  `SELECT session_id AS sessionId, message_id AS messageId, role,
          harness_id AS harnessId, cwd, original, rendered,
          created_at AS createdAt, updated_at AS updatedAt
   FROM chat_render_log ORDER BY updated_at DESC LIMIT ?`,
);
const listChatRenderForSessionStmt = db.prepare(
  `SELECT session_id AS sessionId, message_id AS messageId, role,
          harness_id AS harnessId, cwd, original, rendered,
          created_at AS createdAt, updated_at AS updatedAt
   FROM chat_render_log WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?`,
);

export interface ChatRenderLogRow {
  sessionId: string;
  messageId: string;
  role: string;
  harnessId: string | null;
  cwd: string | null;
  /** JSON of the original normalized ChatMessage. */
  original: string;
  /** JSON of the RenderedMessage (what the UI shows). */
  rendered: string;
  createdAt: number;
  updatedAt: number;
}

/** Record (or refresh) the render log for one chat message. */
export function logChatRender(row: {
  sessionId: string;
  messageId: string;
  role: string;
  harnessId?: string | null;
  cwd?: string | null;
  original: string;
  rendered: string;
  ts?: number;
}): void {
  upsertChatRenderStmt.run({
    harnessId: null,
    cwd: null,
    ...row,
    ts: row.ts ?? Date.now(),
  });
  if (Math.random() < 0.01) pruneChatRenderStmt.run(CHAT_RENDER_LOG_RETENTION);
}

/** Recent render-log rows, newest first. Filtered to one session when given.
 * `original`/`rendered` are parsed back from JSON for the caller. */
export function listChatRenderLog(
  limit: number,
  sessionId?: string,
): (Omit<ChatRenderLogRow, "original" | "rendered"> & {
  original: unknown;
  rendered: unknown;
})[] {
  const rows = (
    sessionId
      ? listChatRenderForSessionStmt.all(sessionId, limit)
      : listChatRenderStmt.all(limit)
  ) as ChatRenderLogRow[];
  return rows.map((r) => ({
    ...r,
    original: safeParse(r.original),
    rendered: safeParse(r.rendered),
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// --- users & auth sessions -------------------------------------------------

export interface UserRow {
  username: string;
  passwordHash: string;
}

const getUserStmt = db.prepare(
  "SELECT username, password_hash AS passwordHash FROM users WHERE username = ?",
);
const createUserStmt = db.prepare(
  "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
);
const createAuthSessionStmt = db.prepare(
  "INSERT INTO auth_sessions (token, username, expires_at) VALUES (?, ?, ?)",
);
const getAuthSessionStmt = db.prepare(
  "SELECT username, expires_at AS expiresAt FROM auth_sessions WHERE token = ?",
);
const deleteAuthSessionStmt = db.prepare(
  "DELETE FROM auth_sessions WHERE token = ?",
);

export function getUser(username: string): UserRow | undefined {
  return getUserStmt.get(username) as UserRow | undefined;
}

export function createUser(username: string, passwordHash: string): void {
  createUserStmt.run(username, passwordHash, Date.now());
}

export function createAuthSession(
  token: string,
  username: string,
  expiresAt: number,
): void {
  createAuthSessionStmt.run(token, username, expiresAt);
}

/** The session's username if the token exists and hasn't expired; otherwise
 * undefined. Expired rows are deleted lazily on lookup. */
export function getAuthSession(token: string): string | undefined {
  const row = getAuthSessionStmt.get(token) as
    | { username: string; expiresAt: number }
    | undefined;
  if (!row) return undefined;
  if (row.expiresAt <= Date.now()) {
    deleteAuthSessionStmt.run(token);
    return undefined;
  }
  return row.username;
}

export function deleteAuthSession(token: string): void {
  deleteAuthSessionStmt.run(token);
}

const setPasswordStmt = db.prepare(
  "UPDATE users SET password_hash = ? WHERE username = ?",
);
const deleteUserSessionsStmt = db.prepare(
  "DELETE FROM auth_sessions WHERE username = ?",
);

/** Replace a password and log that user out everywhere. */
export function setUserPassword(username: string, passwordHash: string): void {
  db.transaction(() => {
    setPasswordStmt.run(passwordHash, username);
    deleteUserSessionsStmt.run(username);
  })();
}

// --- uploads (image attachments) -------------------------------------------

export interface UploadRow {
  id: string;
  owner: string;
  mediaType: string;
  name: string | null;
  bytes: number;
  createdAt: number;
}

// Keep at most this many upload rows; pruned probabilistically on insert. The
// on-disk bytes are cleaned up by uploads.ts against this table.
const UPLOAD_RETENTION = 500;
const insertUploadStmt = db.prepare(
  `INSERT INTO uploads (id, owner, media_type, name, bytes, created_at)
   VALUES (@id, @owner, @mediaType, @name, @bytes, @createdAt)`,
);
const getUploadStmt = db.prepare(
  `SELECT id, owner, media_type AS mediaType, name, bytes, created_at AS createdAt
   FROM uploads WHERE id = ?`,
);
const staleUploadIdsStmt = db.prepare(
  `SELECT id FROM uploads
   WHERE id NOT IN (SELECT id FROM uploads ORDER BY created_at DESC LIMIT ?)`,
);
const deleteUploadStmt = db.prepare("DELETE FROM uploads WHERE id = ?");

export function insertUpload(row: {
  id: string;
  owner: string;
  mediaType: string;
  name?: string | null;
  bytes: number;
  createdAt?: number;
}): void {
  insertUploadStmt.run({
    ...row,
    name: row.name ?? null,
    createdAt: row.createdAt ?? Date.now(),
  });
}

export function getUpload(id: string): UploadRow | undefined {
  return getUploadStmt.get(id) as UploadRow | undefined;
}

/** Delete a single upload row (paired with removing its file). */
export function deleteUpload(id: string): void {
  deleteUploadStmt.run(id);
}

/** Ids of rows beyond the retention cap, so the caller can delete their files
 * then their rows. Returns nothing when under the cap. */
export function staleUploadIds(retention = UPLOAD_RETENTION): string[] {
  return (staleUploadIdsStmt.all(retention) as { id: string }[]).map(
    (r) => r.id,
  );
}

// --- last view -------------------------------------------------------------

const getViewStmt = db.prepare(
  "SELECT folder, session_id AS sessionId FROM user_views WHERE owner = ?",
);
const setViewStmt = db.prepare(
  `INSERT INTO user_views (owner, folder, session_id, updated_at)
   VALUES (@owner, @folder, @sessionId, @updatedAt)
   ON CONFLICT(owner) DO UPDATE SET
     folder = excluded.folder,
     session_id = excluded.session_id,
     updated_at = excluded.updated_at`,
);

export function getUserView(owner: string): ViewState {
  const row = getViewStmt.get(owner) as ViewState | undefined;
  return { folder: row?.folder ?? null, sessionId: row?.sessionId ?? null };
}

export function setUserView(owner: string, view: ViewState): void {
  setViewStmt.run({
    owner,
    // Normalize at the persistence boundary, like every other folder column.
    folder: view.folder ? normalizeFolder(view.folder) : null,
    sessionId: view.sessionId ?? null,
    updatedAt: Date.now(),
  });
}

const getModelNamesStmt = db.prepare(
  "SELECT names FROM model_names WHERE catalog_key = ?",
);
const setModelNamesStmt = db.prepare(
  `INSERT INTO model_names (catalog_key, names, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(catalog_key) DO UPDATE SET
     names = excluded.names, updated_at = excluded.updated_at`,
);
// Only recent catalogs are worth keeping.
const pruneModelNamesStmt = db.prepare(
  `DELETE FROM model_names WHERE catalog_key NOT IN
     (SELECT catalog_key FROM model_names ORDER BY updated_at DESC LIMIT 20)`,
);

export function getModelNames(key: string): Record<string, string> | undefined {
  const row = getModelNamesStmt.get(key) as { names: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.names) as Record<string, string>;
  } catch {
    return undefined;
  }
}

export function setModelNames(key: string, names: Record<string, string>): void {
  setModelNamesStmt.run(key, JSON.stringify(names), Date.now());
  pruneModelNamesStmt.run();
}

// --- shutdown --------------------------------------------------------------

/** Flush the WAL into the main .db file and close. Without this, a SIGKILLed
 * server leaves writes stranded in the WAL and the .db file empty. */
export function closeDb(): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
