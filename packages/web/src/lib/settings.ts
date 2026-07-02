export const SETTINGS_STORAGE_KEY = "agentreview:settings";
export const LOCAL_SETTINGS_ENDPOINT = "/__agentreview__/settings";
export const DEFAULT_AGENT_MODEL = "claude-opus-4-8";

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

export interface AgentReviewSettings {
  model: string;
}

export function loadStoredSettings(): AgentReviewSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as AgentReviewSettings).model === "string" &&
      (parsed as AgentReviewSettings).model.trim().length > 0
    ) {
      return { model: (parsed as AgentReviewSettings).model.trim() };
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
      model?: unknown;
      defaultModel?: unknown;
      knownModels?: unknown;
    };
    if (typeof data.model !== "string" || !data.model.trim()) return null;
    return {
      model: data.model.trim(),
      defaultModel:
        typeof data.defaultModel === "string" ? data.defaultModel : undefined,
      knownModels: Array.isArray(data.knownModels)
        ? data.knownModels.filter((m): m is string => typeof m === "string")
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
