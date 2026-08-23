"use client";

import { memo, useMemo, useState } from "react";
import {
  type ReviewComment,
  formatReviewCommentRange,
  isSegmentComment,
} from "@/lib/comments/types";

interface AgentActivityBubbleProps {
  comments: ReviewComment[];
  onNavigateToComment: (comment: ReviewComment) => void;
  onDismiss: (commentId: string) => void;
  onDismissAll: () => void;
}

function getCommentLocationLabel(comment: ReviewComment): string {
  if (isSegmentComment(comment)) {
    return comment.segmentLabel || "Segment comment";
  }
  const fileName = (comment.filePath ?? "").split("/").pop() || "file";
  return `${fileName} · ${formatReviewCommentRange(comment)}`;
}

function getCommentSnippet(comment: ReviewComment): string {
  const text = comment.body.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function hasPendingAgentRun(comment: ReviewComment): boolean {
  if (comment.agentStatus === "pending") return true;
  return (comment.agentReplies ?? []).some(
    (exchange) => exchange.status === "pending"
  );
}

export const AgentActivityBubble = memo(function AgentActivityBubble({
  comments,
  onNavigateToComment,
  onDismiss,
  onDismissAll,
}: AgentActivityBubbleProps) {
  const [isOpen, setIsOpen] = useState(false);

  const pendingComments = useMemo(
    () => comments.filter(hasPendingAgentRun),
    [comments]
  );
  const unseenComments = useMemo(
    () => comments.filter((comment) => comment.agentUnseen && !hasPendingAgentRun(comment)),
    [comments]
  );

  if (pendingComments.length === 0 && unseenComments.length === 0) {
    return null;
  }

  const unseenErrorCount = unseenComments.filter(
    (comment) => comment.agentStatus === "error"
  ).length;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {isOpen && unseenComments.length > 0 && (
        <div className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-700 bg-gray-900/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              Finished agents
            </p>
            <button
              type="button"
              onClick={onDismissAll}
              className="text-xs text-gray-500 transition-colors hover:text-gray-300"
            >
              Dismiss all
            </button>
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {unseenComments.map((comment) => (
              <li key={comment.id} className="border-b border-gray-800/60 last:border-b-0">
                <div className="flex items-start gap-2 px-3 py-2">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      comment.agentStatus === "error"
                        ? "bg-red-400"
                        : "bg-cyan-400"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onNavigateToComment(comment);
                      setIsOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left transition-colors hover:text-white"
                  >
                    <p className="truncate text-xs font-medium text-gray-300">
                      {getCommentLocationLabel(comment)}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      {getCommentSnippet(comment)}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss(comment.id)}
                    className="shrink-0 px-1 text-xs text-gray-600 transition-colors hover:text-gray-300"
                    title="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          if (unseenComments.length === 1 && !isOpen) {
            onNavigateToComment(unseenComments[0]);
            return;
          }
          setIsOpen((open) => !open);
        }}
        className="flex items-center gap-2.5 rounded-full border border-gray-700 bg-gray-900/95 py-2 pl-3 pr-4 shadow-xl backdrop-blur transition-colors hover:border-gray-500"
        title={
          unseenComments.length > 0
            ? "Jump to a finished agent reply"
            : "Agents are still working"
        }
      >
        {pendingComments.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
            <span className="text-xs font-medium tabular-nums text-gray-300">
              {pendingComments.length}
            </span>
          </span>
        )}
        {unseenComments.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                unseenErrorCount > 0 ? "bg-red-400" : "bg-cyan-400"
              } ${isOpen ? "" : "animate-pulse"}`}
            />
            <span className="text-xs font-medium text-gray-300">
              {unseenComments.length} done
            </span>
          </span>
        )}
        {pendingComments.length > 0 && unseenComments.length === 0 && (
          <span className="text-xs text-gray-400">running</span>
        )}
      </button>
    </div>
  );
});
