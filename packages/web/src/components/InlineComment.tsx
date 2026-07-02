"use client";

import { useState } from "react";
import {
  type ReviewComment,
  formatReviewCommentRange,
} from "@/lib/comments/types";
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
  }
  if (typeof comment.agentCostUsd === "number") {
    parts.push(`$${comment.agentCostUsd.toFixed(2)}`);
  }
  return parts.join(" · ");
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
    return (
      <div className="mt-2 flex items-center gap-2 border-t border-gray-700 pt-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-400/80" />
        <p className="text-xs text-gray-400">Agent is thinking…</p>
      </div>
    );
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
      <p className="text-sm text-gray-300 whitespace-pre-wrap">
        {comment.agentReply}
      </p>
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
