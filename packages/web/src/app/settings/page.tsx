"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_AGENT_MODEL,
  KNOWN_AGENT_MODELS,
  fetchRemoteSettings,
  loadStoredSettings,
  saveRemoteSettings,
  saveStoredSettings,
} from "@/lib/settings";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function SettingsPage() {
  const [model, setModel] = useState(DEFAULT_AGENT_MODEL);
  const [knownModels, setKnownModels] = useState<string[]>(KNOWN_AGENT_MODELS);
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
        setModel(remote.model);
        if (remote.knownModels && remote.knownModels.length > 0) {
          setKnownModels(remote.knownModels);
        }
      } else if (stored) {
        setModel(stored.model);
      }
      setLoaded(true);
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(nextModel: string) {
    const trimmed = nextModel.trim();
    if (!trimmed) {
      setSaveState("error");
      setSaveError("The model cannot be empty.");
      return;
    }

    setSaveState("saving");
    setSaveError(null);
    saveStoredSettings({ model: trimmed });

    if (hasLocalServer) {
      const ok = await saveRemoteSettings({ model: trimmed });
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
            inline comments are answered by{" "}
            <span className="font-mono text-xs">claude -p</span>. Choose which
            model it uses.
          </p>

          {!loaded ? (
            <p className="mt-6 text-sm text-gray-500">Loading…</p>
          ) : (
            <form
              className="mt-6"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave(model);
              }}
            >
              <label
                htmlFor="agent-model"
                className="block text-sm font-medium text-gray-300"
              >
                Model
              </label>
              <input
                id="agent-model"
                type="text"
                list="agent-model-options"
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setSaveState("idle");
                  setSaveError(null);
                }}
                placeholder={DEFAULT_AGENT_MODEL}
                className="mt-2 w-full rounded-lg border border-gray-700 bg-gray-900/70 px-3 py-2 font-mono text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
              />
              <datalist id="agent-model-options">
                {knownModels.map((knownModel) => (
                  <option key={knownModel} value={knownModel} />
                ))}
              </datalist>
              <div className="mt-2 flex flex-wrap gap-2">
                {knownModels.map((knownModel) => (
                  <button
                    key={knownModel}
                    type="button"
                    onClick={() => {
                      setModel(knownModel);
                      setSaveState("idle");
                      setSaveError(null);
                    }}
                    className={`rounded-full border px-3 py-1 font-mono text-xs transition-colors ${
                      model === knownModel
                        ? "border-blue-500 bg-blue-500/15 text-blue-200"
                        : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
                    }`}
                  >
                    {knownModel}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-gray-500">
                Any model id or alias the claude CLI accepts works. The default is{" "}
                <span className="font-mono">{DEFAULT_AGENT_MODEL}</span>.{" "}
                {hasLocalServer
                  ? "Saved settings persist on disk (~/.config/agentreview/settings.json) and apply to future agentreview --local runs."
                  : "No local agentreview server detected; the setting is saved in this browser and applies when a local review connects to it."}
              </p>

              <div className="mt-5 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saveState === "saving"}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500"
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
