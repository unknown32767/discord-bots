import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import {
  getProject,
  getChannelConfig,
  setChannelConfig,
  clearChannelConfig,
} from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import path from "node:path";

export const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Manage per-channel configuration")
  .addSubcommand((sub) =>
    sub.setName("view").setDescription("View current channel configuration"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set a configuration value")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("Configuration key to set")
          .setRequired(true)
          .addChoices({
            name: "Additional Directories (for Codex)",
            value: "directories",
          }),
      )
      .addStringOption((opt) =>
        opt
          .setName("value")
          .setDescription(
            "Value to set (comma-separated for directories, e.g., /path1,/path2)",
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("Clear a configuration value")
      .addStringOption((opt) =>
        opt
          .setName("key")
          .setDescription("Configuration key to clear")
          .setRequired(true)
          .addChoices({
            name: "Additional Directories (for Codex)",
            value: "directories",
          }),
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const subcommand = interaction.options.getSubcommand(true);

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

  const config = getChannelConfig(channelId);

  switch (subcommand) {
    case "view": {
      const fields = [];

      // Additional directories
      if (config.additionalDirectories && config.additionalDirectories.length > 0) {
        fields.push({
          name: L("Additional Directories (Codex)", "추가 디렉토리 (Codex)"),
          value: config.additionalDirectories.map((d) => `- \`${d}\``).join("\n"),
          inline: false,
        });
      }

      // No configuration set
      if (fields.length === 0) {
        await interaction.editReply({
          embeds: [
            {
              title: L("Channel Configuration", "채널 설정"),
              description: L(
                "No per-channel configuration is set for this channel.",
                "이 채널에 설정된 항목이 없습니다.",
              ),
              color: 0x808080,
              fields: [
                {
                  name: L("Available Options", "사용 가능한 옵션"),
                  value: L(
                    "- `/config set directories /path1,/path2` - Set additional writable directories for Codex\n" +
                    "- `/config clear directories` - Clear the additional directories setting",
                    "- `/config set directories /path1,/path2` - Codex를 위한 추가 쓰기 가능 디렉토리 설정\n" +
                    "- `/config clear directories` - 추가 디렉토리 설정 제거",
                  ),
                  inline: false,
                },
              ],
            },
          ],
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          {
            title: L("Channel Configuration", "채널 설정"),
            description: L(
              "Current per-channel configuration for this channel:",
              "이 채널의 현재 설정:",
            ),
            color: 0x00ff00,
            fields,
          },
        ],
      });
      break;
    }

    case "set": {
      const key = interaction.options.getString("key", true);
      const value = interaction.options.getString("value", true);

      if (key === "directories") {
        // Parse comma-separated directories
        const directories = value
          .split(",")
          .map((d) => d.trim())
          .filter((d) => d.length > 0);

        if (directories.length === 0) {
          await interaction.editReply({
            content: L(
              "No valid directories provided. Please provide a comma-separated list of absolute paths.",
              "유효한 디렉토리가 없습니다. 절대 경로 목록을 쉼표로 구분하여 입력하세요.",
            ),
          });
          return;
        }

        // Validate directories (must be absolute paths)
        const invalidDirs: string[] = [];
        for (const dir of directories) {
          if (!path.isAbsolute(dir)) {
            invalidDirs.push(dir);
          }
        }

        if (invalidDirs.length > 0) {
          await interaction.editReply({
            content: L(
              `The following paths are not absolute paths: ${invalidDirs.join(", ")}\n\nPlease provide absolute paths (e.g., /home/user/projects or C:\\\\Users\\\\user\\\\projects)`,
              `다음 경로들이 절대 경로가 아닙니다: ${invalidDirs.join(", ")}\n\n절대 경로를 입력하세요 (예: /home/user/projects 또는 C:\\\\Users\\\\user\\\\projects)`,
            ),
          });
          return;
        }

        setChannelConfig(channelId, { additionalDirectories: directories });

        await interaction.editReply({
          embeds: [
            {
              title: L("Configuration Updated", "설정 업데이트됨"),
              description: L(
                "Additional directories for Codex have been set.",
                "Codex를 위한 추가 디렉토리가 설정되었습니다.",
              ),
              color: 0x00ff00,
              fields: [
                {
                  name: L("Directories", "디렉토리"),
                  value: directories.map((d) => `- \`${d}\``).join("\n"),
                  inline: false,
                },
              ],
            },
          ],
        });
      }
      break;
    }

    case "clear": {
      const key = interaction.options.getString("key", true);

      if (key === "directories") {
        const newConfig = { ...config };
        delete newConfig.additionalDirectories;

        if (Object.keys(newConfig).length === 0) {
          clearChannelConfig(channelId);
        } else {
          setChannelConfig(channelId, { additionalDirectories: undefined });
        }

        await interaction.editReply({
          embeds: [
            {
              title: L("Configuration Cleared", "설정 삭제됨"),
              description: L(
                "Additional directories for Codex have been cleared.",
                "Codex를 위한 추가 디렉토리 설정이 삭제되었습니다.",
              ),
              color: 0xff6600,
            },
          ],
        });
      }
      break;
    }
  }
}
