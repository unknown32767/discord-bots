import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  DiscordAPIError,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getAllProjects,
  getAllSessionRecordsByChannel,
  unregisterProject,
} from "../../db/database.js";
import type { Project, Session } from "../../db/types.js";
import { splitMessage } from "../../claude/output-formatter.js";
import { findSessionDir } from "./sessions.js";
import { L } from "../../utils/i18n.js";

interface CompactTarget {
  project: Project;
  sessions: Session[];
  files: string[];
}

interface PendingCompact {
  ownerUserId: string;
  targets: CompactTarget[];
}

const pendingCompacts = new Map<string, PendingCompact>();

function findCodexSessionFileById(sessionId: string): string | null {
  const codexDir = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(codexDir)) return null;

  function recurse(dir: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = recurse(fullPath);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
        return fullPath;
      }
    }
    return null;
  }

  return recurse(codexDir);
}

function findSessionFile(project: Project, sessionId: string): string | null {
  if ((project.provider ?? "claude") === "codex") {
    return findCodexSessionFileById(sessionId);
  }

  const sessionDir = findSessionDir(project.project_path);
  if (!sessionDir) return null;

  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : null;
}

async function isDeletedChannel(
  interaction: ChatInputCommandInteraction,
  channelId: string,
): Promise<boolean> {
  try {
    const channel = await interaction.client.channels.fetch(channelId);
    return !channel;
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === 10003) {
      return true;
    }
    return false;
  }
}

async function collectCompactTargets(
  interaction: ChatInputCommandInteraction,
): Promise<CompactTarget[]> {
  const guildId = interaction.guildId!;
  const projects = getAllProjects(guildId);
  const targets: CompactTarget[] = [];

  for (const project of projects) {
    if (!await isDeletedChannel(interaction, project.channel_id)) {
      continue;
    }

    const sessions = getAllSessionRecordsByChannel(project.channel_id);
    const files = Array.from(new Set(
      sessions
        .map((session) => session.session_id)
        .filter((sessionId): sessionId is string => Boolean(sessionId))
        .map((sessionId) => findSessionFile(project, sessionId))
        .filter((filePath): filePath is string => Boolean(filePath)),
    ));

    targets.push({ project, sessions, files });
  }

  return targets;
}

function buildSummary(targets: CompactTarget[]): string {
  const projectCount = targets.length;
  const sessionRecordCount = targets.reduce((sum, target) => sum + target.sessions.length, 0);
  const fileCount = targets.reduce((sum, target) => sum + target.files.length, 0);

  return [
    L("Found stale records for deleted Discord channels.", "삭제된 Discord 채널에 대한 오래된 레코드를 찾았습니다."),
    L(`Projects: **${projectCount}**`, `프로젝트: **${projectCount}**`),
    L(`Session records: **${sessionRecordCount}**`, `세션 레코드: **${sessionRecordCount}**`),
    L(`Session files to delete: **${fileCount}**`, `삭제할 세션 파일: **${fileCount}**`),
    "",
    L("Only DB-tracked session files will be deleted. Shared project directories are not bulk-cleared.", "DB에 추적된 세션 파일만 삭제합니다. 공유 프로젝트 디렉토리 전체는 비우지 않습니다."),
    L("Press Confirm to delete these records and files.", "아래 목록을 확인한 뒤 Confirm을 누르면 삭제합니다."),
  ].join("\n");
}

function buildDetails(targets: CompactTarget[]): string[] {
  const sections: string[] = [];

  for (const [index, target] of targets.entries()) {
    const provider = target.project.provider ?? "claude";
    const lines: string[] = [
      `**Stale Channel ${index + 1}**`,
      `Channel ID: \`${target.project.channel_id}\``,
      `Project: \`${target.project.project_path}\``,
      `Provider: \`${provider}\``,
      `Project created: \`${target.project.created_at}\``,
      "",
    ];

    if (target.sessions.length === 0) {
      lines.push("Session records: (none)");
    } else {
      lines.push("Session records:");
      for (const session of target.sessions) {
        lines.push(
          `- db_id=${session.id} session_id=${session.session_id ?? "null"} status=${session.status} created=${session.created_at}`,
        );
      }
    }

    if (target.files.length === 0) {
      lines.push("Session files: (none)");
    } else {
      lines.push("Session files:");
      for (const filePath of target.files) {
        lines.push(`- ${filePath}`);
      }
    }

    sections.push(lines.join("\n"));
  }

  return sections;
}

export const data = new SlashCommandBuilder()
  .setName("compact")
  .setDescription("Preview and remove stale DB records for deleted Discord channels")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const targets = await collectCompactTargets(interaction);

  if (targets.length === 0) {
    await interaction.editReply({
      content: L("No stale channel records found.", "삭제된 채널에 대한 오래된 레코드를 찾지 못했습니다."),
    });
    return;
  }

  const requestId = randomUUID();
  pendingCompacts.set(requestId, {
    ownerUserId: interaction.user.id,
    targets,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`compact-confirm:${requestId}`)
      .setLabel(L("Confirm Delete", "삭제 확인"))
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🧹"),
    new ButtonBuilder()
      .setCustomId(`compact-cancel:${requestId}`)
      .setLabel(L("Cancel", "취소"))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("❌"),
  );

  await interaction.editReply({
    content: buildSummary(targets),
  });

  const sections = buildDetails(targets);
  for (const section of sections) {
    for (const chunk of splitMessage(section)) {
      await interaction.followUp({ content: chunk });
    }
  }

  await interaction.followUp({
    content: L("Confirm deletion with the buttons below.", "아래 버튼으로 삭제 여부를 확인하세요."),
    components: [row],
  });
}

export function cancelCompactRequest(
  requestId: string,
  userId: string,
): "cancelled" | "forbidden" | "missing" {
  const pending = pendingCompacts.get(requestId);
  if (!pending) return "missing";
  if (pending.ownerUserId !== userId) return "forbidden";

  pendingCompacts.delete(requestId);
  return "cancelled";
}

export function confirmCompactRequest(
  requestId: string,
  userId: string,
): {
  status: "confirmed" | "forbidden" | "missing";
  deletedProjects?: number;
  deletedSessionRecords?: number;
  deletedFiles?: string[];
  failedFiles?: string[];
} {
  const pending = pendingCompacts.get(requestId);
  if (!pending) return { status: "missing" };
  if (pending.ownerUserId !== userId) return { status: "forbidden" };

  pendingCompacts.delete(requestId);

  let deletedProjects = 0;
  let deletedSessionRecords = 0;
  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];

  for (const target of pending.targets) {
    deletedSessionRecords += target.sessions.length;

    for (const filePath of target.files) {
      try {
        fs.unlinkSync(filePath);
        deletedFiles.push(filePath);
      } catch {
        failedFiles.push(filePath);
      }
    }

    unregisterProject(target.project.channel_id);
    deletedProjects++;
  }

  return {
    status: "confirmed",
    deletedProjects,
    deletedSessionRecords,
    deletedFiles,
    failedFiles,
  };
}
