import type { AgentProvider, AgentMessage, QueryOptions, AIProvider } from "./base.js";
import { getChannelConfig } from "../db/database.js";

// Codex SDK types
interface ThreadEvent {
  type: string;
  thread_id?: string;
  item?: ThreadItem;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
  };
  error?: {
    message: string;
  };
}

interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  message?: string;
}

export class CodexProvider implements AgentProvider {
  readonly name: AIProvider = "codex";
  private abortController: AbortController | null = null;

  async *query(options: QueryOptions): AsyncIterable<AgentMessage> {
    const { prompt, cwd, channelId, sessionId } = options;

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

      // Start or resume thread
      // sandboxMode: workspace-write allows file edits, read-only is default
      const thread = sessionId
        ? codex.resumeThread(sessionId, {
            workingDirectory: cwd,
            approvalPolicy: "on-request",
            skipGitRepoCheck: true,
            sandboxMode: "workspace-write",
            networkAccessEnabled: true,
            additionalDirectories: channelConfig.additionalDirectories,
          })
        : codex.startThread({
            workingDirectory: cwd,
            approvalPolicy: "on-request",
            skipGitRepoCheck: true,
            sandboxMode: "workspace-write",
            networkAccessEnabled: true,
            additionalDirectories: channelConfig.additionalDirectories,
          });

      // Yield init message with thread ID
      if (thread.id) {
        yield { type: "init", sessionId: thread.id };
      }

      // Run the turn
      const turn = await thread.runStreamed(prompt, {
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
