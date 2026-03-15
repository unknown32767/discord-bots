import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { getProject, setMode } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import type { AgentMode } from "../../db/types.js";

const MODES: { name: string; value: AgentMode; description: string }[] = [
  { name: "Default", value: "default", description: "Normal execution mode" },
  { name: "Plan", value: "plan", description: "Plan mode - requires user approval before executing changes" },
];

export const data = new SlashCommandBuilder()
  .setName("mode")
  .setDescription("Set the execution mode for this channel")
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("Execution mode")
      .setRequired(true)
      .addChoices(
        { name: "Default", value: "default" },
        { name: "Plan", value: "plan" },
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const modeInput = interaction.options.getString("mode", true) as AgentMode;
  const channelId = interaction.channelId;

  const project = getProject(channelId);
  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project. Use `/register` first.",
        "이 채널은 프로젝트에 등록되지 않았습니다. 먼저 `/register`를 사용하세요.",
      ),
    });
    return;
  }

  setMode(channelId, modeInput);

  const modeInfo = MODES.find((m) => m.value === modeInput);

  await interaction.editReply({
    embeds: [
      {
        title: L("Mode Updated", "모드 업데이트됨"),
        description: L(
          `Execution mode set to: **${modeInfo?.name ?? modeInput}**`,
          `실행 모드가 **${modeInfo?.name ?? modeInput}**(으)로 설정되었습니다.`,
        ),
        color: 0x00ff00,
        fields: [
          {
            name: L("Description", "설명"),
            value: modeInfo?.description ?? "",
            inline: false,
          },
        ],
      },
    ],
  });
}
