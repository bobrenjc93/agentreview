"use client";

import { useState } from "react";

interface InlineCommentFormProps {
  selectionLabel?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

export function InlineCommentForm({
  selectionLabel,
  onSubmit,
  onCancel,
}: InlineCommentFormProps) {
  const [body, setBody] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-600 rounded-md p-3 mx-2 my-1">
      {selectionLabel && (
        <p className="mb-2 text-xs text-gray-400">{selectionLabel}</p>
      )}
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a review comment..."
        className="w-full bg-gray-900 text-gray-200 text-sm border border-gray-700 rounded p-2 resize-none focus:outline-none focus:border-blue-500"
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            handleSubmit(e);
          }
          if (e.key === "Escape") {
            onCancel();
          }
        }}
      />
      <div className="flex gap-2 mt-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!body.trim()}
          className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded transition-colors"
        >
          Add Comment
        </button>
      </div>
    </form>
  );
}
