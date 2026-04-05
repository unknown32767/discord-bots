import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import type { AgentProvider, AgentMessage, QueryOptions, AIProvider } from "./base.js";

export class ClaudeProvider implements AgentProvider {
  readonly name: AIProvider = "claude";
  private queryInstance: Query | null = null;

  async *query(options: QueryOptions): AsyncIterable<AgentMessage> {
    const { prompt, cwd, sessionId, mode, onToolRequest } = options;

    this.queryInstance = query({
      prompt,
      options: {
        cwd,
        permissionMode: mode ?? "default",
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        // Enable gstack skills
        settingSources: ["user", "project"],
        ...(sessionId ? { resume: sessionId } : {}),

        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          if (!onToolRequest) {
            return { behavior: "allow" as const, updatedInput: input };
          }

          const decision = await onToolRequest(toolName, input);

          if (decision.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: decision.updatedInput ?? input,
            };
          } else {
            return {
              behavior: "deny" as const,
              message: decision.message ?? "Denied by user",
            };
          }
        },
      },
    });

    for await (const message of this.queryInstance) {
      // Handle init message
      if (
        message.type === "system" &&
        "subtype" in message &&
        message.subtype === "init"
      ) {
        const sdkSessionId = (message as { session_id?: string }).session_id;
        if (sdkSessionId) {
          yield { type: "init", sessionId: sdkSessionId };
        }
        continue;
      }

      // Handle assistant content
      if (message.type === "assistant" && "content" in message) {
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if ("text" in block && typeof block.text === "string") {
              yield { type: "content", text: block.text };
            } else if (block.type === "thinking" && block.thinking) {
              yield { type: "thinking", text: block.thinking };
            } else if (block.type === "redacted_thinking" && block.data) {
              yield { type: "redacted_thinking", data: block.data };
            }
          }
        }
        continue;
      }

      // Handle result
      if ("result" in message) {
        const resultMsg = message as {
          result?: string;
          total_cost_usd?: number;
          duration_ms?: number;
        };
        yield {
          type: "result",
          text: resultMsg.result ?? "Task completed",
          cost: resultMsg.total_cost_usd ?? 0,
          durationMs: resultMsg.duration_ms ?? 0,
        };
        continue;
      }

      // Handle tool start
      if (message.type === "tool_use") {
        const toolMsg = message as { name?: string; input?: unknown };
        if (toolMsg.name) {
          yield {
            type: "tool_start",
            toolName: toolMsg.name,
            input: toolMsg.input,
          };
        }
        continue;
      }

      // Handle tool end
      if (message.type === "tool_result") {
        const toolResult = message as { content?: unknown; result?: unknown };
        yield {
          type: "tool_end",
          result: toolResult.content ?? toolResult.result,
        };
        continue;
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.queryInstance) {
      await this.queryInstance.interrupt();
      this.queryInstance = null;
    }
  }
}
