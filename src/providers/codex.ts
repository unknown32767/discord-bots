import type { AgentProvider, AgentMessage, QueryOptions, AIProvider } from "./base.js";
import { getChannelConfig } from "../db/database.js";
import { getConfig } from "../utils/config.js";
import path from "node:path";

// Image formats supported by Codex local_image input (gif excluded - passed as path text only)
const CODEX_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export class CodexProvider implements AgentProvider {
  readonly name: AIProvider = "codex";
  private abortController: AbortController | null = null;

  async *query(options: QueryOptions): AsyncIterable<AgentMessage> {
    const { prompt, cwd, channelId, sessionId, imagePaths } = options;

    this.abortController = new AbortController();

    try {
      // Dynamic import to handle SDK loading
      const codexModule = await import("@openai/codex-sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Codex = codexModule.Codex as any;

      if (!Codex) {
        yield {
          type: "error",
          message: "Failed to load @openai/codex-sdk. Please ensure it is properly installed.",
        };
        return;
      }

      // Create Codex instance
      // Uses CLI's device code authentication from ~/.codex/
      const codex = new Codex();

      // Load per-channel configuration for additional directories
      const channelConfig = channelId ? getChannelConfig(channelId) : {};

      // Build additional directories list including .git for write access
      // Codex 0.120+ requires explicit .git permission (read-only carveouts)
      const additionalDirs = [
        ...(channelConfig.additionalDirectories || []),
        path.join(cwd, ".git"),
      ];

      // Start or resume thread
      // sandboxMode: danger-full-access disables sandboxing entirely (use with caution)
      const codexModel = getConfig().CODEX_MODEL;
      const codexReasoningEffort = getConfig().CODEX_REASONING_EFFORT;
      const thread = sessionId
        ? codex.resumeThread(sessionId, {
            workingDirectory: cwd,
            approvalPolicy: "on-request",
            skipGitRepoCheck: true,
            sandboxMode: "danger-full-access",
            networkAccessEnabled: true,
            additionalDirectories: additionalDirs,
            ...(codexModel ? { model: codexModel } : {}),
            ...(codexReasoningEffort ? { modelReasoningEffort: codexReasoningEffort } : {}),
          })
        : codex.startThread({
            workingDirectory: cwd,
            approvalPolicy: "on-request",
            skipGitRepoCheck: true,
            sandboxMode: "danger-full-access",
            networkAccessEnabled: true,
            additionalDirectories: additionalDirs,
            ...(codexModel ? { model: codexModel } : {}),
            ...(codexReasoningEffort ? { modelReasoningEffort: codexReasoningEffort } : {}),
          });

      // Yield init message with thread ID
      if (thread.id) {
        yield { type: "init", sessionId: thread.id };
      }

      // Run the turn
      // Attach images as local_image inputs so the model can actually see them.
      // Paths are resolved to absolute (project_path from /register may be relative).
      const images = (imagePaths ?? [])
        .filter((p) => CODEX_IMAGE_EXTS.has(path.extname(p).toLowerCase()))
        .map((p) => ({ type: "local_image" as const, path: path.resolve(cwd, p) }));

      const input =
        images.length > 0
          ? [{ type: "text" as const, text: prompt }, ...images]
          : prompt;

      const turn = await thread.runStreamed(input, {
        signal: this.abortController.signal,
      });

      let accumulatedText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let turnCompleted = false;

      // Process events
      for await (const event of turn.events) {
        // Handle thread started
        if (event.type === "thread.started" && event.thread_id) {
          yield { type: "init", sessionId: event.thread_id };
          continue;
        }

        // Handle item events - only process on item.completed to avoid duplicates
        if (event.type === "item.completed") {
          const item = event.item;
          if (!item) continue;

          // Agent message - only yield on completion with full text
          if (item.type === "agent_message" && item.text) {
            // Only yield if text is different from what we've seen
            if (item.text !== accumulatedText) {
              accumulatedText = item.text;
              yield { type: "content", text: item.text };
            }
          }

          // Command execution - show as tool usage
          if (item.type === "command_execution" && item.command) {
            yield {
              type: "tool_start",
              toolName: "Bash",
              input: { command: item.command, description: "Command execution" },
            };

            if (item.status === "completed" || item.exit_code !== undefined) {
              yield {
                type: "tool_end",
                result: { exitCode: item.exit_code, output: item.status },
              };
            }
          }

          // File changes
          if (item.type === "file_change" && item.changes) {
            for (const change of item.changes) {
              yield {
                type: "tool_start",
                toolName: change.kind === "add" ? "Write" : "Edit",
                input: { file_path: change.path },
              };
              yield {
                type: "tool_end",
                result: { path: change.path, status: item.status },
              };
            }
          }

          // Error item
          if (item.type === "error" && item.message) {
            yield {
              type: "error",
              message: item.message,
            };
          }

          continue;
        }

        // Handle turn completed
        if (event.type === "turn.completed") {
          turnCompleted = true;
          if (event.usage) {
            inputTokens = event.usage.input_tokens;
            outputTokens = event.usage.output_tokens;
          }

          // Estimate cost (approximate rates for GPT-4)
          const costUsd = inputTokens * 0.0000025 + outputTokens * 0.00001;

          yield {
            type: "result",
            text: accumulatedText || "Task completed",
            cost: costUsd,
            durationMs: undefined, // Codex doesn't provide duration
          };
          continue;
        }

        // Handle turn failed
        if (event.type === "turn.failed" && event.error) {
          yield {
            type: "error",
            message: event.error.message || "Turn failed",
          };
          continue;
        }

        // Handle error event
        if (event.type === "error" && event.message) {
          yield {
            type: "error",
            message: event.message,
          };
        }
      }

      // If turn.completed was never fired, yield a fallback result
      if (!turnCompleted && accumulatedText) {
        const costUsd = inputTokens * 0.0000025 + outputTokens * 0.00001;
        yield {
          type: "result",
          text: accumulatedText,
          cost: costUsd,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Handle specific errors
      if (errorMessage.includes("codex")) {
        yield {
          type: "error",
          message: `Codex CLI not found. Please install it: npm install -g @openai/codex\nError: ${errorMessage}`,
        };
      } else {
        yield {
          type: "error",
          message: `Codex provider error: ${errorMessage}`,
        };
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
