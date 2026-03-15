import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { getProject, setProvider } from "../../db/database.js";
import { sessionManager } from "../../claude/session-manager.js";
import { L } from "../../utils/i18n.js";
import { isValidProvider, getProviderDisplayName, type AIProvider } from "../../providers/index.js";

export const data = new SlashCommandBuilder()
  .setName("switch-model")
  .setDescription("Switch between Claude and Codex AI models")
  .addStringOption((opt) =>
    opt
      .setName("model")
      .setDescription("AI model to use")
      .setRequired(true)
      .addChoices(
        { name: "Claude", value: "claude" },
        { name: "Codex", value: "codex" },
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const modelInput = interaction.options.getString("model", true);

  // Validate the model input
  if (!isValidProvider(modelInput)) {
    await interaction.editReply({
      content: L(
        "Invalid model. Please choose 'claude' or 'codex'.",
        "잘못된 모델입니다. 'claude' 또는 'codex'를 선택하세요.",
      ),
    });
    return;
  }

  const newProvider: AIProvider = modelInput;

  // Check if channel is registered
  const project = getProject(channelId);
  if (!project) {
    await interaction.editReply({
      content: L(
        "This channel is not registered to any project. Use `/register` first.",
        "이 채널은 등록된 프로젝트가 없습니다. 먼저 `/register`를 사용하세요.",
      ),
    });
    return;
  }

  // Check if there's an active session
  if (sessionManager.isActive(channelId)) {
    await interaction.editReply({
      content: L(
        "⚠️ There is an active session in this channel. Please stop it first with `/stop` before switching models.",
        "⚠️ 이 채널에서 활성 세션이 실행 중입니다. 모델을 전환하기 전에 `/stop`으로 중지하세요.",
      ),
    });
    return;
  }

  // Check if the provider is already set to the requested one
  const currentProvider = project.provider ?? "claude";
  if (currentProvider === newProvider) {
    await interaction.editReply({
      content: L(
        `This channel is already using ${getProviderDisplayName(newProvider)}.`,
        `이 채널은 이미 ${getProviderDisplayName(newProvider)}를 사용 중입니다.`,
      ),
    });
    return;
  }

  // Update the provider in the database
  setProvider(channelId, newProvider);

  const providerDisplay = getProviderDisplayName(newProvider);
  const oldProviderDisplay = getProviderDisplayName(currentProvider);

  await interaction.editReply({
    embeds: [
      {
        title: L("Model Switched", "모델 전환됨"),
        description: L(
          `AI model for this channel has been switched from **${oldProviderDisplay}** to **${providerDisplay}**.`,
          `이 채널의 AI 모델이 **${oldProviderDisplay}**에서 **${providerDisplay}**로 전환되었습니다.`,
        ),
        color: 0x00ff00,
        fields: [
          {
            name: L("Project", "프로젝트"),
            value: `\`${project.project_path}\``,
            inline: false,
          },
          {
            name: L("Current Model", "현재 모델"),
            value: providerDisplay,
            inline: true,
          },
          {
            name: L("Auto-approve", "자동 승인"),
            value: project.auto_approve ? L("On", "켜짐") : L("Off", "꺼짐"),
            inline: true,
          },
        ],
      },
    ],
  });
}
