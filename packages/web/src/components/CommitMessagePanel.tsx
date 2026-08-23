"use client";

import { memo, useEffect, useState } from "react";
import { AgentMarkdown } from "./AgentMarkdown";

type CommitMessageViewMode = "plain" | "markdown";

const COMMIT_MESSAGE_VIEW_MODE_STORAGE_KEY = "agentreview:commitMessageViewMode";

function isCommitMessageViewMode(
  value: string | null
): value is CommitMessageViewMode {
  return value === "plain" || value === "markdown";
}

export const CommitMessagePanel = memo(function CommitMessagePanel({
  message,
}: {
  message: string;
}) {
  const [viewMode, setViewMode] = useState<CommitMessageViewMode>("plain");

  useEffect(() => {
    const savedViewMode = window.localStorage.getItem(
      COMMIT_MESSAGE_VIEW_MODE_STORAGE_KEY
    );
    if (isCommitMessageViewMode(savedViewMode)) {
      setViewMode(savedViewMode);
    }
  }, []);

  const selectViewMode = (nextViewMode: CommitMessageViewMode) => {
    setViewMode(nextViewMode);
    window.localStorage.setItem(
      COMMIT_MESSAGE_VIEW_MODE_STORAGE_KEY,
      nextViewMode
    );
  };

  return (
    <div className="mt-4 border-t border-gray-800 pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
          Commit message
        </p>
        <div
          className="inline-flex rounded-md border border-gray-700 bg-gray-900/80 p-0.5"
          aria-label="Commit message view"
        >
          <button
            type="button"
            onClick={() => selectViewMode("plain")}
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              viewMode === "plain"
                ? "bg-cyan-500/15 text-cyan-100"
                : "text-gray-400 hover:text-white"
            }`}
            aria-pressed={viewMode === "plain"}
          >
            Plain
          </button>
          <button
            type="button"
            onClick={() => selectViewMode("markdown")}
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              viewMode === "markdown"
                ? "bg-cyan-500/15 text-cyan-100"
                : "text-gray-400 hover:text-white"
            }`}
            aria-pressed={viewMode === "markdown"}
          >
            Markdown
          </button>
        </div>
      </div>
      {viewMode === "markdown" ? (
        <AgentMarkdown text={message} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-gray-300">
          {message}
        </pre>
      )}
    </div>
  );
});
