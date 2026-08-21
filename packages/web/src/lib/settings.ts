export const SETTINGS_STORAGE_KEY = "agentreview:settings";
export const LOCAL_SETTINGS_ENDPOINT = "/__agentreview__/settings";
export const DEFAULT_AGENT_BACKEND = "claude";
export const DEFAULT_AGENT_MODEL = "claude-opus-4-8";

export type AgentBackend = "claude" | "codex";

export const KNOWN_AGENT_BACKENDS: AgentBackend[] = ["claude", "codex"];

// Mirrors KNOWN_AGENT_MODELS in the CLI; the claude CLI has no command to
// enumerate models, so this is a curated list and free-form input is allowed.
export const KNOWN_AGENT_MODELS = [
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "opus",
  "sonnet",
  "haiku",
  "fable",
];

// Mirrors KNOWN_CODEX_MODELS in the CLI.
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const KNOWN_CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.5-codex-mini",
  "gpt-5.1-codex-max",
];
export const DEFAULT_CODEX_REASONING_EFFORT = "";
export const KNOWN_CODEX_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface AgentReviewSettings {
  agent: AgentBackend;
  model: string;
  codexModel: string;
  codexReasoningEffort: string;
}

export function isAgentBackend(value: unknown): value is AgentBackend {
  return value === "claude" || value === "codex";
}

export function loadStoredSettings(): AgentReviewSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AgentReviewSettings> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.model === "string" &&
      parsed.model.trim().length > 0
    ) {
      return {
        agent: isAgentBackend(parsed.agent) ? parsed.agent : DEFAULT_AGENT_BACKEND,
        model: parsed.model.trim(),
        codexModel:
          typeof parsed.codexModel === "string" ? parsed.codexModel.trim() : "",
        codexReasoningEffort:
          typeof parsed.codexReasoningEffort === "string"
            ? parsed.codexReasoningEffort.trim().toLowerCase()
            : DEFAULT_CODEX_REASONING_EFFORT,
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

export function saveStoredSettings(settings: AgentReviewSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage may be unavailable; the local server still persists to disk
  }
}

export interface RemoteSettings extends AgentReviewSettings {
  defaultModel?: string;
  knownModels?: string[];
  knownCodexModels?: string[];
  knownCodexReasoningEfforts?: string[];
}

/**
 * Fetch settings from the local agentreview server. Returns null when the
 * endpoint is unavailable (e.g. the hosted web UI, where there is no agent).
 */
export async function fetchRemoteSettings(): Promise<RemoteSettings | null> {
  try {
    const response = await fetch(LOCAL_SETTINGS_ENDPOINT, { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      agent?: unknown;
      model?: unknown;
      codexModel?: unknown;
      codexReasoningEffort?: unknown;
      defaultModel?: unknown;
      knownModels?: unknown;
      knownCodexModels?: unknown;
      knownCodexReasoningEfforts?: unknown;
    };
    if (typeof data.model !== "string" || !data.model.trim()) return null;
    return {
      agent: isAgentBackend(data.agent) ? data.agent : DEFAULT_AGENT_BACKEND,
      model: data.model.trim(),
      codexModel: typeof data.codexModel === "string" ? data.codexModel.trim() : "",
      codexReasoningEffort:
        typeof data.codexReasoningEffort === "string"
          ? data.codexReasoningEffort.trim().toLowerCase()
          : DEFAULT_CODEX_REASONING_EFFORT,
      defaultModel:
        typeof data.defaultModel === "string" ? data.defaultModel : undefined,
      knownModels: Array.isArray(data.knownModels)
        ? data.knownModels.filter((m): m is string => typeof m === "string")
        : undefined,
      knownCodexModels: Array.isArray(data.knownCodexModels)
        ? data.knownCodexModels.filter((m): m is string => typeof m === "string")
        : undefined,
      knownCodexReasoningEfforts: Array.isArray(data.knownCodexReasoningEfforts)
        ? data.knownCodexReasoningEfforts.filter(
            (effort): effort is string => typeof effort === "string"
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

export async function saveRemoteSettings(
  settings: AgentReviewSettings
): Promise<boolean> {
  try {
    const response = await fetch(LOCAL_SETTINGS_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    return response.ok;
  } catch {
    return false;
  }
}
