import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { getProject, getSession } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";
import { getProviderDisplayName } from "../../providers/index.js";

const STATUS_EMOJI: Record<string, string> = {
  online: "🟢",
  waiting: "🟡",
  idle: "⚪",
  offline: "🔴",
};

export const data = new SlashCommandBuilder()
  .setName("session")
  .setDescription("Show detailed information about the current channel's session");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const project = getProject(channelId);

  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project. Use `/register` first.",
        "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요."
      ),
    });
    return;
  }

  const session = getSession(channelId);
  const isActive = sessionManager.isActive(channelId);
  const queueSize = sessionManager.getQueueSize(channelId);

  const embed = new EmbedBuilder()
    .setTitle(L("📋 Session Information", "📋 세션 정보"))
    .setColor(0x7c3aed)
    .setTimestamp();

  // Project Information
  const providerDisplay = getProviderDisplayName(project.provider ?? "claude");
  const modeDisplay = project.mode === "plan" ? "📋 Plan" : "⚡ Default";

  embed.addFields({
    name: L("Project", "프로젝트"),
    value: [
      `**${L("Path", "경로")}:** \`${project.project_path}\``,
      `**${L("Provider", "제공자")}:** ${providerDisplay}`,
      `**${L("Mode", "모드")}:** ${modeDisplay}`,
      `**${L("Auto-approve", "자동 승인")}:** ${project.auto_approve ? L("✅ On", "✅ 켜짐") : L("❌ Off", "❌ 꺼짐")}`,
    ].join("\n"),
    inline: false,
  });

  // Session Information
  if (session) {
    const status = session.status ?? "offline";
    const emoji = STATUS_EMOJI[status] ?? "🔴";
    const lastActivity = session.last_activity ?? L("Never", "없음");

    embed.addFields({
      name: L("Session", "세션"),
      value: [
        `**${L("Status", "상태")}:** ${emoji} ${status}`,
        `**${L("Active in Memory", "메모리에 활성")}:** ${isActive ? L("✅ Yes", "✅ 예") : L("❌ No", "❌ 아니오")}`,
        `**${L("Queue Size", "큐 크기")}:** ${queueSize}`,
        `**${L("Last Activity", "마지막 활동")}:** ${lastActivity}`,
      ].join("\n"),
      inline: false,
    });

    // Session IDs (collapsible or secondary field)
    const sessionIdDisplay = session.session_id ?? L("Not set (new session will be created)", "설정되지 않음 (새 세션이 생성됩니다)");
    embed.addFields({
      name: L("Session IDs", "세션 ID"),
      value: [
        `**${L("AI Session ID", "AI 세션 ID")}:** \`${sessionIdDisplay}\``,
        `**${L("Database ID", "데이터베이스 ID")}:** \`${session.id}\``,
      ].join("\n"),
      inline: false,
    });
  } else {
    embed.addFields({
      name: L("Session", "세션"),
      value: [
        `**${L("Status", "상태")}:** 🔴 offline`,
        `**${L("Active in Memory", "메모리에 활성")}:** ❌ No`,
        `**${L("Queue Size", "큐 크기")}:** ${queueSize}`,
        "",
        L("No session found. Send a message to start a new session.", "세션이 없습니다. 메시지를 보내어 새 세션을 시작하세요."),
      ].join("\n"),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
