export type SessionStatus = "online" | "offline" | "waiting" | "idle";

export type AgentMode = "default" | "plan";

/**
 * Per-channel configuration stored as JSON in the database.
 * Allows flexible per-channel settings without schema migrations.
 */
export interface ChannelConfig {
  /** Additional directories Codex can write to (besides workingDirectory) */
  additionalDirectories?: string[];

  // Future extensions:
  // maxTokens?: number;
  // customSystemPrompt?: string;
  // allowedTools?: string[];
}

export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number; // 0 or 1
  provider: "claude" | "codex";
  mode: AgentMode;
  config?: string; // JSON serialized ChannelConfig
  created_at: string;
}

export interface Session {
  id: string;
  channel_id: string;
  session_id: string | null; // Claude Agent SDK session ID
  status: SessionStatus;
  last_activity: string | null;
  created_at: string;
}
