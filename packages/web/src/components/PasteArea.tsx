"use client";

import { type KeyboardEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { decodePayload } from "@/lib/payload/decode";
import { validatePayload } from "@/lib/payload/validate";

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
      const reviewSessionId = crypto.randomUUID();
      // Store in sessionStorage for the review page to pick up
      sessionStorage.setItem("agentreview:payload", JSON.stringify(payload));
      sessionStorage.setItem("agentreview:sessionId", reviewSessionId);
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
    <div className="w-full max-w-2xl">
      <textarea
        className="w-full h-64 bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm text-gray-300 focus:outline-none focus:border-blue-500 resize-none"
        placeholder="Paste your ===AGENTREVIEW:v1=== payload here..."
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={!value.trim()}
        className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg font-medium transition-colors"
      >
        Start Review
      </button>
    </div>
  );
}
