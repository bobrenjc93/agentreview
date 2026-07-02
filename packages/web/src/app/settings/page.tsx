"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_AGENT_BACKEND,
  DEFAULT_AGENT_MODEL,
  KNOWN_AGENT_MODELS,
  KNOWN_CODEX_MODELS,
  fetchRemoteSettings,
  loadStoredSettings,
  saveRemoteSettings,
  saveStoredSettings,
  type AgentBackend,
} from "@/lib/settings";

type SaveState = "idle" | "saving" | "saved" | "error";

const AGENT_OPTIONS: Array<{
  value: AgentBackend;
  label: string;
  command: string;
  description: string;
}> = [
  {
    value: "claude",
    label: "Claude Code",
    command: "claude -p",
    description: "Default. Uses the claude CLI.",
  },
  {
    value: "codex",
    label: "Codex",
    command: "codex exec",
    description: "Uses the codex CLI.",
  },
];

function ModelChips({
  models,
  selected,
  onSelect,
}: {
  models: string[];
  selected: string;
  onSelect: (model: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {models.map((model) => (
        <button
          key={model}
          type="button"
          onClick={() => onSelect(model)}
          className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
            selected === model
              ? "border-blue-500 bg-blue-500/15 text-blue-200"
              : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
          }`}
        >
          {model}
        </button>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const [agent, setAgent] = useState<AgentBackend>(DEFAULT_AGENT_BACKEND);
  const [model, setModel] = useState(DEFAULT_AGENT_MODEL);
  const [codexModel, setCodexModel] = useState("");
  const [knownModels, setKnownModels] = useState<string[]>(KNOWN_AGENT_MODELS);
  const [knownCodexModels, setKnownCodexModels] =
    useState<string[]>(KNOWN_CODEX_MODELS);
  const [hasLocalServer, setHasLocalServer] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      const stored = loadStoredSettings();
      const remote = await fetchRemoteSettings();
      if (cancelled) return;

      if (remote) {
        setHasLocalServer(true);
        setAgent(remote.agent);
        setModel(remote.model);
        setCodexModel(remote.codexModel);
        if (remote.knownModels && remote.knownModels.length > 0) {
          setKnownModels(remote.knownModels);
        }
        if (remote.knownCodexModels && remote.knownCodexModels.length > 0) {
          setKnownCodexModels(remote.knownCodexModels);
        }
      } else if (stored) {
        setAgent(stored.agent);
        setModel(stored.model);
        setCodexModel(stored.codexModel);
      }
      setLoaded(true);
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  function markDirty() {
    setSaveState("idle");
    setSaveError(null);
  }

  async function handleSave() {
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      setSaveState("error");
      setSaveError("The Claude model cannot be empty.");
      return;
    }

    const nextSettings = {
      agent,
      model: trimmedModel,
      codexModel: codexModel.trim(),
    };

    setSaveState("saving");
    setSaveError(null);
    saveStoredSettings(nextSettings);

    if (hasLocalServer) {
      const ok = await saveRemoteSettings(nextSettings);
      if (!ok) {
        setSaveState("error");
        setSaveError(
          "Saved in this browser, but the local agentreview server rejected the update."
        );
        return;
      }
    }

    setSaveState("saved");
  }

  return (
    <main className="home-shell relative min-h-screen overflow-hidden">
      <div className="mx-auto w-full max-w-2xl px-6 py-12">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <a
            href="/"
            className="text-sm text-blue-400 transition-colors hover:text-blue-300"
          >
            ← Back
          </a>
        </div>

        <section className="home-panel rounded-2xl p-6">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-gray-400">
            Inline agent
          </h2>
          <p className="mt-2 text-sm leading-6 text-gray-400">
            In <span className="font-mono text-xs">agentreview --local</span> mode,
            inline comments are answered by an agent CLI running in your
            repository. Choose which agent and model to use.
          </p>

          {!loaded ? (
            <p className="mt-6 text-sm text-gray-500">Loading…</p>
          ) : (
            <form
              className="mt-6"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <span className="block text-sm font-medium text-gray-300">
                Agent
              </span>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {AGENT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setAgent(option.value);
                      markDirty();
                    }}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      agent === option.value
                        ? "border-blue-500 bg-blue-500/10"
                        : "border-gray-700 hover:border-gray-500"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`text-sm font-medium ${
                          agent === option.value ? "text-blue-200" : "text-gray-300"
                        }`}
                      >
                        {option.label}
                      </span>
                      <span className="font-mono text-xs text-gray-500">
                        {option.command}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-gray-500">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>

              {agent === "claude" ? (
                <div className="mt-5">
                  <label
                    htmlFor="agent-model"
                    className="block text-sm font-medium text-gray-300"
                  >
                    Claude model
                  </label>
                  <input
                    id="agent-model"
                    type="text"
                    list="agent-model-options"
                    value={model}
                    onChange={(event) => {
                      setModel(event.target.value);
                      markDirty();
                    }}
                    placeholder={DEFAULT_AGENT_MODEL}
                    className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-900/70 px-3 py-2 font-mono text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                  />
                  <datalist id="agent-model-options">
                    {knownModels.map((knownModel) => (
                      <option key={knownModel} value={knownModel} />
                    ))}
                  </datalist>
                  <ModelChips
                    models={knownModels}
                    selected={model}
                    onSelect={(nextModel) => {
                      setModel(nextModel);
                      markDirty();
                    }}
                  />
                  <p className="mt-3 text-xs leading-5 text-gray-500">
                    Any model id or alias the claude CLI accepts works. The
                    default is <span className="font-mono">{DEFAULT_AGENT_MODEL}</span>.
                  </p>
                </div>
              ) : (
                <div className="mt-5">
                  <label
                    htmlFor="codex-model"
                    className="block text-sm font-medium text-gray-300"
                  >
                    Codex model
                  </label>
                  <input
                    id="codex-model"
                    type="text"
                    list="codex-model-options"
                    value={codexModel}
                    onChange={(event) => {
                      setCodexModel(event.target.value);
                      markDirty();
                    }}
                    placeholder="codex default"
                    className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-900/70 px-3 py-2 font-mono text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                  />
                  <datalist id="codex-model-options">
                    {knownCodexModels.map((knownModel) => (
                      <option key={knownModel} value={knownModel} />
                    ))}
                  </datalist>
                  <ModelChips
                    models={knownCodexModels}
                    selected={codexModel}
                    onSelect={(nextModel) => {
                      setCodexModel(nextModel);
                      markDirty();
                    }}
                  />
                  <p className="mt-3 text-xs leading-5 text-gray-500">
                    Passed to <span className="font-mono">codex exec --model</span>.
                    Leave empty to use codex&apos;s own default model.
                  </p>
                </div>
              )}

              <p className="mt-3 text-xs leading-5 text-gray-500">
                {hasLocalServer
                  ? "Saved settings persist on disk (~/.config/agentreview/settings.json) and apply to future agentreview --local runs."
                  : "No local agentreview server detected; the setting is saved in this browser and applies when a local review connects to it."}
              </p>

              <div className="mt-5 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saveState === "saving"}
                  className="primary-action-button rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium transition-colors hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500"
                >
                  {saveState === "saving" ? "Saving…" : "Save"}
                </button>
                {saveState === "saved" && (
                  <span className="text-sm text-emerald-400">Saved.</span>
                )}
                {saveState === "error" && saveError && (
                  <span className="text-sm text-red-400">{saveError}</span>
                )}
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
