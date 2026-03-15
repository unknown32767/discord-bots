import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { getAllProjects, getSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { getProviderDisplayName } from "../../providers/index.js";

const STATUS_EMOJI: Record<string, string> = {
  online: "🟢",
  waiting: "🟡",
  idle: "⚪",
  offline: "🔴",
};

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show status of all registered project sessions");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId!;
  const projects = getAllProjects(guildId);

  if (projects.length === 0) {
    await interaction.editReply({
      content: L("No projects registered. Use `/register` in a channel first.", "등록된 프로젝트가 없습니다. 먼저 채널에서 `/register`를 사용하세요."),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(L("AI Agent Sessions", "AI 에이전트 세션"))
    .setColor(0x7c3aed)
    .setTimestamp();

  for (const project of projects) {
    const session = getSession(project.channel_id);
    const status = session?.status ?? "offline";
    const emoji = STATUS_EMOJI[status] ?? "🔴";
    const lastActivity = session?.last_activity ?? "never";
    const provider = getProviderDisplayName(project.provider ?? "claude");

    const modeDisplay = project.mode === "plan" ? "📋 Plan" : "⚡ Default";

    embed.addFields({
      name: `${emoji} <#${project.channel_id}>`,
      value: [
        `\`${project.project_path}\``,
        `${L("Provider", "제공자")}: **${provider}**`,
        `${L("Status", "상태")}: **${status}**`,
        `${L("Auto-approve", "자동 승인")}: ${project.auto_approve ? L("On", "켜짐") : L("Off", "꺼짐")}`,
        `${L("Mode", "모드")}: ${modeDisplay}`,
        `${L("Last activity", "마지막 활동")}: ${lastActivity}`,
      ].join("\n"),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
