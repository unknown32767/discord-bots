// Base provider interface for AI agent implementations

export type AIProvider = 'claude' | 'codex';

export interface ToolDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface QueryOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  mode?: 'default' | 'plan';
  onToolRequest?: (toolName: string, input: Record<string, unknown>) => Promise<ToolDecision>;
}

export type AgentMessage =
  | { type: 'init'; sessionId: string }
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_start'; toolName: string; input: unknown }
  | { type: 'tool_end'; result: unknown }
  | { type: 'result'; text: string; cost?: number; durationMs?: number }
  | { type: 'error'; message: string };

export interface AgentProvider {
  readonly name: AIProvider;

  /**
   * Execute a query with the AI agent
   * Returns an async iterable of messages (streaming)
   */
  query(options: QueryOptions): AsyncIterable<AgentMessage>;

  /**
   * Interrupt the current query/session
   */
  interrupt(): Promise<void>;
}

export interface AskQuestionData {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}
