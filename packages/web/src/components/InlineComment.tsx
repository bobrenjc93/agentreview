"use client";

import { useEffect, useState } from "react";
import {
  type ReviewComment,
  formatReviewCommentRange,
} from "@/lib/comments/types";
import { AgentReplyBody } from "./AgentMarkdown";
import { InlineCommentForm } from "./InlineCommentForm";

interface InlineCommentProps {
  comment: ReviewComment;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onRetryAgent?: (id: string) => void;
}

function formatAgentReplyNote(comment: ReviewComment): string {
  const parts: string[] = [comment.agentModel || "agent"];
  if (typeof comment.agentDurationMs === "number") {
    parts.push(`${(comment.agentDurationMs / 1000).toFixed(1)}s`);
  } else if (comment.agentFinishedAt && comment.agentStartedAt) {
    const elapsedMs =
      Date.parse(comment.agentFinishedAt) - Date.parse(comment.agentStartedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      parts.push(`${(elapsedMs / 1000).toFixed(1)}s`);
    }
  }
  if (typeof comment.agentCostUsd === "number") {
    parts.push(`$${comment.agentCostUsd.toFixed(2)}`);
  }
  return parts.join(" · ");
}

function formatElapsedSeconds(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function AgentPendingIndicator({ startedAt }: { startedAt?: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    getElapsedSeconds(startedAt)
  );

  useEffect(() => {
    setElapsedSeconds(getElapsedSeconds(startedAt));
    const interval = window.setInterval(() => {
      setElapsedSeconds(getElapsedSeconds(startedAt));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  return (
    <div className="mt-2 flex items-center gap-2 border-t border-gray-700 pt-2">
      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
      <p className="text-xs text-gray-400">
        Agent is thinking…
        <span className="ml-1.5 font-mono tabular-nums text-cyan-400/90">
          {formatElapsedSeconds(elapsedSeconds)}
        </span>
      </p>
    </div>
  );
}

function getElapsedSeconds(startedAt?: string): number {
  if (!startedAt) return 0;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return 0;
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

function AgentReplySection({
  comment,
  onRetryAgent,
}: {
  comment: ReviewComment;
  onRetryAgent?: (id: string) => void;
}) {
  if (!comment.agentStatus) return null;

  if (comment.agentStatus === "pending") {
    return <AgentPendingIndicator startedAt={comment.agentStartedAt} />;
  }

  if (comment.agentStatus === "error") {
    return (
      <div className="mt-2 border-t border-gray-700 pt-2">
        <p className="text-xs text-red-400">
          Agent reply failed: {comment.agentError || "unknown error"}
        </p>
        {onRetryAgent && (
          <button
            type="button"
            onClick={() => onRetryAgent(comment.id)}
            className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      <p className="mb-1 text-[11px] text-cyan-400/90">
        {formatAgentReplyNote(comment)}
      </p>
      <AgentReplyBody
        segments={comment.agentSegments}
        fallbackText={comment.agentReply}
      />
    </div>
  );
}

export function InlineComment({ comment, onEdit, onDelete, onRetryAgent }: InlineCommentProps) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <InlineCommentForm
        selectionLabel={formatReviewCommentRange(comment)}
        initialValue={comment.body}
        submitLabel="Save Comment"
        onSubmit={(body) => {
          onEdit(comment.id, body);
          setIsEditing(false);
        }}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md p-3 mx-2 my-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p className="text-[11px] text-gray-500 mb-1">
            {formatReviewCommentRange(comment)}
          </p>
          <p className="text-sm text-gray-200 whitespace-pre-wrap">
            {comment.body}
          </p>
          <AgentReplySection comment={comment} onRetryAgent={onRetryAgent} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="text-gray-500 hover:text-blue-300 text-xs transition-colors"
            title="Edit comment"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(comment.id)}
            className="text-gray-500 hover:text-red-400 text-xs transition-colors"
            title="Delete comment"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
