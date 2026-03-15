import type { AgentProvider, AIProvider } from "./base.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";

export * from "./base.js";
export { ClaudeProvider } from "./claude.js";
export { CodexProvider } from "./codex.js";

/**
 * Factory function to create an AI provider instance
 */
export function createProvider(providerName: AIProvider): AgentProvider {
  switch (providerName) {
    case "claude":
      return new ClaudeProvider();
    case "codex":
      return new CodexProvider();
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Validate if a string is a valid AI provider
 */
export function isValidProvider(value: string): value is AIProvider {
  return value === "claude" || value === "codex";
}

/**
 * Get the display name for a provider
 */
export function getProviderDisplayName(provider: AIProvider): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
  }
}
