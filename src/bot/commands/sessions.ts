import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { getProject, getSession, upsertSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { getProviderDisplayName } from "../../providers/index.js";

interface SessionInfo {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  fileSize: number;
}

/**
 * Find the Claude session directory for a given project path.
 * Claude Code stores sessions in ~/.claude/projects/<encoded-path>/
 * The encoding isn't just simple "/" -> "-" replacement (also replaces "_" etc.)
 * So we find the correct directory by checking JSONL file contents.
 */
export function findSessionDir(projectPath: string): string | null {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return null;

  // Try simple conversion first (Claude Code encodes / and _ as -)
  const simpleName = projectPath.replace(/[\\/\_]/g, "-");
  const simplePath = path.join(claudeDir, simpleName);
  if (fs.existsSync(simplePath)) return simplePath;

  // Fallback: scan directories and match by reading JSONL cwd field
  const dirs = fs.readdirSync(claudeDir);
  for (const dir of dirs) {
    const dirPath = path.join(claudeDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) continue;

    // Read first few lines of the first JSONL to check cwd
    const firstFile = path.join(dirPath, jsonlFiles[0]);
    const content = fs.readFileSync(firstFile, { encoding: "utf-8" });
    const lines = content.split("\n").slice(0, 10);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.cwd === projectPath) return dirPath;
      } catch {
        // skip
      }
    }
  }

  return null;
}

/**
 * Read the last assistant text message from a JSONL session file.
 */
export async function getLastAssistantMessage(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastText = "";

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.content) {
        const content = entry.message.content;
        let raw = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              raw += block.text;
            }
          }
        } else if (typeof content === "string") {
          raw = content;
        }
        if (raw.trim()) {
          lastText = raw.trim();
        }
      }
    } catch {
      // skip
    }
  }

  rl.close();
  stream.destroy();

  if (!lastText) return "(no message)";

  // Extract the last meaningful sentence/line
  const lines = lastText.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || lastText.slice(-200);
}

/**
 * Read the full last assistant text message from a JSONL session file.
 */
export async function getLastAssistantMessageFull(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastText = "";

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.content) {
        const content = entry.message.content;
        let raw = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              raw += block.text;
            }
          }
        } else if (typeof content === "string") {
          raw = content;
        }
        if (raw.trim()) {
          lastText = raw.trim();
        }
      }
    } catch {
      // skip
    }
  }

  rl.close();
  stream.destroy();

  return lastText || "(no message)";
}

/**
 * Read the first user message from a JSONL session file.
 */
async function getFirstUserMessage(filePath: string): Promise<{ text: string; timestamp: string }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp = "";
  let text = "";

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);

      // Grab timestamp from first line
      if (!timestamp && entry.timestamp) {
        timestamp = entry.timestamp;
      }

      // Find first user message with real text content (skip IDE-injected tags)
      if (entry.type === "user" && entry.message?.content) {
        const content = entry.message.content;
        let raw = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              raw = block.text;
              break;
            }
          }
        } else if (typeof content === "string") {
          raw = content;
        }
        // Strip system/IDE tags like <ide_opened_file>...</ide_opened_file>, <system-reminder>...
        const cleaned = raw.replace(/<[^>]+>[^<]*<\/[^>]+>/g, "").replace(/<[^>]+>/g, "").trim();
        if (cleaned) {
          text = cleaned;
          break;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  rl.close();
  stream.destroy();

  return { text: text || "(empty session)", timestamp };
}

/**
 * List all session JSONL files for a given project path.
 */
async function listSessions(projectPath: string): Promise<SessionInfo[]> {
  const sessionDir = findSessionDir(projectPath);
  if (!sessionDir) return [];

  const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const stat = fs.statSync(filePath);

    // Skip very small files (likely empty/abandoned sessions)
    if (stat.size < 512) continue;

    const sessionId = file.replace(".jsonl", "");
    const { text } = await getFirstUserMessage(filePath);

    // Skip sessions with no actual user message
    if (text === "(empty session)") continue;

    sessions.push({
      sessionId,
      firstMessage: text.slice(0, 80),
      timestamp: stat.mtime.toISOString(),
      fileSize: stat.size,
    });
  }

  // Sort by most recent first
  sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return sessions;
}

/**
 * Read the first user message from a Codex session JSONL file.
 */
async function getCodexFirstMessage(filePath: string): Promise<{ text: string; timestamp: string }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp = "";
  let text = "";
  let summaryText = "";

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);

      // Grab timestamp from session_meta
      if (!timestamp && entry.type === "session_meta" && entry.payload?.timestamp) {
        timestamp = entry.payload.timestamp;
      }

      // Best option: event_msg with type="user_message" (actual user input)
      if (entry.type === "event_msg" && entry.payload?.type === "user_message" && entry.payload?.message) {
        const msg = entry.payload.message;
        if (typeof msg === "string" && msg.trim()) {
          text = msg;
          break;
        }
      }

      // Second option: response_item with role="user" and short content (not AGENTS.md)
      if (!text && entry.type === "response_item" && entry.payload?.role === "user") {
        const content = entry.payload.content;
        if (Array.isArray(content) && content.length > 0) {
          for (const block of content) {
            if (block.type === "input_text" && block.text) {
              // Skip if it looks like AGENTS.md (starts with # or contains skill instructions)
              if (block.text.startsWith("#") || block.text.includes("AGENTS.md") || block.text.includes("skill-creator")) {
                continue;
              }
              // Must be short (actual user message, not instructions)
              if (block.text.length < 500) {
                text = block.text;
                break;
              }
            }
          }
        }
      }

      // Last resort: turn_context summary. Ignore "auto"/"none" and keep
      // scanning so a later user_message can still take precedence.
      if (!summaryText && entry.type === "turn_context" && entry.payload?.summary) {
        const summary = entry.payload.summary;
        if (summary && summary !== "none" && summary !== "auto" && summary.trim()) {
          summaryText = summary;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  rl.close();
  stream.destroy();

  return { text: text || summaryText || "(empty session)", timestamp };
}

/**
 * Check if a Codex session belongs to a specific project path.
 * Reads the events.jsonl to find the working_directory.
 */
async function getCodexSessionProjectPath(eventsFile: string): Promise<string | null> {
  const stream = fs.createReadStream(eventsFile, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let projectPath: string | null = null;

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      // Codex stores working directory in session_meta payload
      // Field name could be cwd or working_directory depending on version
      if (entry.type === "session_meta" && entry.payload) {
        const cwd = entry.payload.cwd || entry.payload.working_directory;
        if (cwd) {
          projectPath = cwd;
          break;
        }
      }
      // Fallback: check turn_context payload
      if (entry.type === "turn_context" && entry.payload) {
        const cwd = entry.payload.cwd || entry.payload.working_directory;
        if (cwd) {
          projectPath = cwd;
          break;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  rl.close();
  stream.destroy();

  return projectPath;
}

/**
 * Recursively find all Codex session JSONL files in a directory.
 * Codex files are named like: rollout-2026-03-15T02-42-48-<uuid>.jsonl
 */
function findAllCodexSessionFiles(dir: string): string[] {
  const results: string[] = [];

  function recurse(currentDir: string) {
    if (!fs.existsSync(currentDir)) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  recurse(dir);
  return results;
}

/**
 * List all Codex sessions for a given project path.
 * Codex stores sessions in ~/.codex/sessions/<date>/<thread-id>/events.jsonl
 */
async function listCodexSessions(projectPath: string): Promise<SessionInfo[]> {
  const codexDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(codexDir)) return [];

  const sessions: SessionInfo[] = [];

  // Find all .jsonl files recursively
  const allSessionFiles = findAllCodexSessionFiles(codexDir);

  for (const sessionFile of allSessionFiles) {
    const stat = fs.statSync(sessionFile);

    // Skip very small files (likely empty/abandoned sessions)
    if (stat.size < 512) continue;

    // Check if this session belongs to the project
    const sessionProjectPath = await getCodexSessionProjectPath(sessionFile);
    if (!sessionProjectPath) continue;
    // Normalize paths for comparison (remove trailing slashes, resolve . and ..)
    const normalizedSessionPath = path.normalize(sessionProjectPath);
    const normalizedProjectPath = path.normalize(projectPath);
    if (normalizedSessionPath !== normalizedProjectPath) continue;

    const { text } = await getCodexFirstMessage(sessionFile);

    // Skip sessions with no actual user message
    if (text === "(empty session)") continue;

    // Extract session ID from filename: rollout-2026-03-15T02-42-48-<uuid>.jsonl
    // The UUID is the last part of the filename
    const filename = path.basename(sessionFile, ".jsonl");
    const uuidMatch = filename.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    const sessionId = uuidMatch ? uuidMatch[0] : filename;

    // If text is "none" or empty, try to extract date from filename as display name
    // Filename format: rollout-2026-03-15T02-42-48-<uuid>.jsonl
    let displayText = text;
    if (!text || text === "none" || text.trim() === "") {
      const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      if (dateMatch) {
        const [, date, hour, min] = dateMatch;
        displayText = `Session ${date} ${hour}:${min}`;
      } else {
        displayText = `Session ${sessionId.slice(0, 8)}`;
      }
    }

    sessions.push({
      sessionId,
      firstMessage: displayText.slice(0, 80),
      timestamp: stat.mtime.toISOString(),
      fileSize: stat.size,
    });
  }

  // Sort by most recent first
  sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return sessions;
}

export const data = new SlashCommandBuilder()
  .setName("sessions")
  .setDescription("List and resume existing AI sessions for this project");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L("This channel is not registered to any project. Use `/register` first.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요."),
    });
    return;
  }

  const provider = project.provider ?? "claude";
  const providerDisplay = getProviderDisplayName(provider);

  // Use appropriate session listing based on provider
  const sessions = provider === "codex"
    ? await listCodexSessions(project.project_path)
    : await listSessions(project.project_path);

  if (sessions.length === 0) {
    const { randomUUID } = await import("node:crypto");
    upsertSession(randomUUID(), channelId, null, "idle");
    await interaction.editReply({
      embeds: [
        {
          title: L("✨ New Session", "✨ 새 세션"),
          description: L(
            `No existing sessions found for \`${project.project_path}\`.\nA new session is ready — your next message will start a new conversation.`,
            `\`${project.project_path}\`에 대한 기존 세션이 없습니다.\n새 세션이 준비되었습니다 — 다음 메시지부터 새로운 대화가 시작됩니다.`
          ),
          color: 0x00ff00,
        },
      ],
    });
    return;
  }

  // Check currently active session for this channel
  const dbSession = getSession(channelId);
  const activeSessionId = dbSession?.session_id ?? null;

  // Build select menu (max 25 options, reserve 1 for "New Session")
  const options: Array<{ label: string; description: string; value: string; default?: boolean }> = [
    {
      label: L("✨ Create New Session", "✨ 새 세션 만들기"),
      description: L("Start a new conversation without an existing session", "기존 세션 없이 새로운 대화를 시작합니다"),
      value: "__new_session__",
    },
  ];

  const sessionOptions = sessions.slice(0, 24).map((s, i) => {
    const date = new Date(s.timestamp);
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    const timeStr =
      diffMin < 1 ? L("just now", "방금") :
      diffMin < 60 ? L(`${diffMin}m ago`, `${diffMin}분 전`) :
      diffHr < 24 ? L(`${diffHr}h ago`, `${diffHr}시간 전`) :
      diffDay < 7 ? L(`${diffDay}d ago`, `${diffDay}일 전`) :
      date.toLocaleDateString(L("en-US", "ko-KR"), { month: "short", day: "numeric" });

    const sizeKB = Math.round(s.fileSize / 1024);
    const isActive = s.sessionId === activeSessionId;
    const label = isActive
      ? `▶ ${s.firstMessage.slice(0, 48)}`
      : s.firstMessage.slice(0, 50) || `Session ${i + 1}`;
    const desc = isActive
      ? `${L("Active", "사용 중")} | ${timeStr} | ${sizeKB}KB`
      : `${timeStr} | ${sizeKB}KB | ${s.sessionId.slice(0, 8)}...`;

    return {
      label,
      description: desc.slice(0, 100),
      value: s.sessionId,
      default: isActive,
    };
  });

  options.push(...sessionOptions);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("session-select")
    .setPlaceholder(L("Select a session to resume...", "재개할 세션을 선택하세요..."))
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  await interaction.editReply({
    embeds: [
      {
        title: L(`${providerDisplay} Sessions`, `${providerDisplay} 세션`),
        description: [
          `Project: \`${project.project_path}\``,
          `Provider: **${providerDisplay}**`,
          L(`Found **${sessions.length}** session(s)`, `**${sessions.length}**개의 세션을 찾았습니다`),
          "",
          L("Select a session below to resume or delete it.", "아래에서 세션을 선택하여 재개하거나 삭제하세요."),
        ].join("\n"),
        color: 0x7c3aed,
      },
    ],
    components: [row],
  });
}
