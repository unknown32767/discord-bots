import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { getProject } from "../../db/database.js";
import { findSessionDir } from "./sessions.js";
import { L } from "../../utils/i18n.js";
import { getProviderDisplayName } from "../../providers/index.js";

/**
 * Check if a Codex session belongs to a specific project path.
 */
async function getCodexSessionProjectPath(sessionFile: string): Promise<string | null> {
  const stream = fs.createReadStream(sessionFile, { encoding: "utf-8" });
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
      // skip
    }
  }

  rl.close();
  stream.destroy();

  return projectPath;
}

/**
 * Recursively find all Codex session files for a project.
 * Returns the file paths, not directories (since files are directly in date folders).
 */
async function findCodexSessionFilesForProject(projectPath: string): Promise<string[]> {
  const codexDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(codexDir)) return [];

  const sessionFiles: string[] = [];

  function recurse(currentDir: string) {
    if (!fs.existsSync(currentDir)) return;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        // This is a session file, we'll check project later
        sessionFiles.push(fullPath);
      }
    }
  }

  recurse(codexDir);

  // Filter by project path
  const matchingFiles: string[] = [];
  for (const file of sessionFiles) {
    const sessionProjectPath = await getCodexSessionProjectPath(file);
    if (sessionProjectPath === projectPath) {
      matchingFiles.push(file);
    }
  }

  return matchingFiles;
}

export const data = new SlashCommandBuilder()
  .setName("clear-sessions")
  .setDescription("Delete all AI session files for this project")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

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
  let deleted = 0;

  if (provider === "codex") {
    // Clear Codex sessions from ~/.codex/sessions/ (recursively)
    const sessionFiles = await findCodexSessionFilesForProject(project.project_path);
    for (const sessionFile of sessionFiles) {
      try {
        fs.unlinkSync(sessionFile);
        deleted++;
      } catch {
        // skip files that can't be deleted
      }
    }
  } else {
    // Clear Claude sessions
    const sessionDir = findSessionDir(project.project_path);
    if (!sessionDir) {
      await interaction.editReply({
        content: L(`No session directory found for \`${project.project_path}\``, `\`${project.project_path}\`에 대한 세션 디렉토리를 찾을 수 없습니다`),
      });
      return;
    }

    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) {
      await interaction.editReply({
        content: L("No session files to delete.", "삭제할 세션 파일이 없습니다."),
      });
      return;
    }

    for (const file of files) {
      try {
        fs.unlinkSync(path.join(sessionDir, file));
        deleted++;
      } catch {
        // skip files that can't be deleted
      }
    }
  }

  await interaction.editReply({
    embeds: [
      {
        title: L("Sessions Cleared", "세션 정리됨"),
        description: [
          `Project: \`${project.project_path}\``,
          `Provider: **${providerDisplay}**`,
          L(`Deleted **${deleted}** session(s)`, `**${deleted}**개의 세션이 삭제되었습니다`),
        ].join("\n"),
        color: 0xff6b6b,
      },
    ],
  });
}
