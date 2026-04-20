"use client";

import { type KeyboardEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClientId } from "@/lib/id";
import { decodePayload } from "@/lib/payload/decode";
import { validatePayload } from "@/lib/payload/validate";
import { storeReviewPayloadInSession } from "@/lib/storage/reviews";

export function PasteArea() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function handleSubmit() {
    setError(null);
    try {
      const payload = decodePayload(value);
      const validation = validatePayload(payload);
      if (!validation.valid) {
        setError(validation.error!);
        return;
      }
      const reviewSessionId = createClientId();
      storeReviewPayloadInSession(payload, reviewSessionId);
      router.push("/review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to decode payload");
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (value.trim()) {
        handleSubmit();
      }
    }
  }

  return (
    <div className="w-full">
      <textarea
        className="w-full h-72 rounded-[26px] border border-white/10 bg-slate-950/85 p-5 font-mono text-sm text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] focus:outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 resize-none"
        placeholder="Paste your ===AGENTREVIEW:v1=== payload here..."
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-slate-300">
            Paste the payload and jump straight into the interactive review UI.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Press <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-slate-300">Enter</span> or click the button to start.
          </p>
          {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
        </div>
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="inline-flex items-center justify-center rounded-full bg-cyan-400 px-6 py-3 text-sm font-semibold text-slate-950 transition-transform transition-colors hover:scale-[1.01] hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
        >
          Start Review
        </button>
      </div>
    </div>
  );
}
