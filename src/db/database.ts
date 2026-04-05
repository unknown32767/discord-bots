import Database from "better-sqlite3";
import path from "node:path";
import type { Project, Session, SessionStatus, AgentMode, ChannelConfig } from "./types.js";

const DB_PATH = path.join(process.cwd(), "data.db");

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      channel_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      auto_approve INTEGER DEFAULT 0,
      provider TEXT DEFAULT 'claude',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES projects(channel_id) ON DELETE CASCADE,
      session_id TEXT,
      status TEXT DEFAULT 'offline',
      last_activity TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add provider column if it doesn't exist (for existing databases)
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN provider TEXT DEFAULT 'claude'`);
  } catch {
    // Column already exists, ignore error
  }

  // Migration: add mode column if it doesn't exist
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN mode TEXT DEFAULT 'default'`);
  } catch {
    // Column already exists, ignore error
  }

  // Migration: add config column for per-channel JSON configuration
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN config TEXT`);
  } catch {
    // Column already exists, ignore error
  }
}

export function getDb(): Database.Database {
  return db;
}

// Project queries
export function registerProject(
  channelId: string,
  projectPath: string,
  guildId: string,
  provider: "claude" | "codex" = "claude",
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO projects (channel_id, project_path, guild_id, provider)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(channelId, projectPath, guildId, provider);
}

export function registerInheritedProject(
  channelId: string,
  parentProject: Project,
): boolean {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO projects (
      channel_id,
      project_path,
      guild_id,
      auto_approve,
      provider,
      mode,
      config
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    channelId,
    parentProject.project_path,
    parentProject.guild_id,
    parentProject.auto_approve,
    parentProject.provider,
    parentProject.mode,
    parentProject.config,
  );

  return result.changes > 0;
}

export function unregisterProject(channelId: string): void {
  db.prepare("DELETE FROM sessions WHERE channel_id = ?").run(channelId);
  db.prepare("DELETE FROM projects WHERE channel_id = ?").run(channelId);
}

export function getProject(channelId: string): Project | undefined {
  return db
    .prepare("SELECT * FROM projects WHERE channel_id = ?")
    .get(channelId) as Project | undefined;
}

export function getAllProjects(guildId: string): Project[] {
  return db
    .prepare("SELECT * FROM projects WHERE guild_id = ?")
    .all(guildId) as Project[];
}

export function setAutoApprove(
  channelId: string,
  autoApprove: boolean,
): void {
  db.prepare("UPDATE projects SET auto_approve = ? WHERE channel_id = ?").run(
    autoApprove ? 1 : 0,
    channelId,
  );
}

export function setProvider(
  channelId: string,
  provider: "claude" | "codex",
): void {
  db.prepare("UPDATE projects SET provider = ? WHERE channel_id = ?").run(
    provider,
    channelId,
  );
}

export function setMode(
  channelId: string,
  mode: AgentMode,
): void {
  db.prepare("UPDATE projects SET mode = ? WHERE channel_id = ?").run(
    mode,
    channelId,
  );
}

// Session queries
export function upsertSession(
  id: string,
  channelId: string,
  sessionId: string | null,
  status: SessionStatus,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, channel_id, session_id, status, last_activity)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(id, channelId, sessionId, status);
}

export function getSession(channelId: string): Session | undefined {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(channelId) as Session | undefined;
}

export function getSessionsByChannel(channelId: string): Session[] {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE channel_id = ? AND session_id IS NOT NULL ORDER BY created_at DESC",
    )
    .all(channelId) as Session[];
}

export function getAllSessionRecordsByChannel(channelId: string): Session[] {
  return db
    .prepare(
      "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at DESC",
    )
    .all(channelId) as Session[];
}

export function updateSessionStatus(
  channelId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE sessions SET status = ?, last_activity = datetime('now') WHERE channel_id = ?",
  ).run(status, channelId);
}

export function getAllSessions(guildId: string): (Session & { project_path: string })[] {
  return db
    .prepare(`
      SELECT s.*, p.project_path FROM sessions s
      JOIN projects p ON s.channel_id = p.channel_id
      WHERE p.guild_id = ?
    `)
    .all(guildId) as (Session & { project_path: string })[];
}

// Channel configuration queries
export function getChannelConfig(channelId: string): ChannelConfig {
  const row = db
    .prepare("SELECT config FROM projects WHERE channel_id = ?")
    .get(channelId) as { config?: string } | undefined;

  if (!row?.config) return {};

  try {
    return JSON.parse(row.config) as ChannelConfig;
  } catch {
    return {};
  }
}

export function setChannelConfig(
  channelId: string,
  config: Partial<ChannelConfig>,
): void {
  const existing = getChannelConfig(channelId);
  const merged = { ...existing, ...config };

  db.prepare("UPDATE projects SET config = ? WHERE channel_id = ?").run(
    JSON.stringify(merged),
    channelId,
  );
}

export function clearChannelConfig(channelId: string): void {
  db.prepare("UPDATE projects SET config = NULL WHERE channel_id = ?").run(
    channelId,
  );
}
