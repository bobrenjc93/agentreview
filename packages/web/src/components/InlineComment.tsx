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
}

export function InlineComment({ comment, onEdit, onDelete }: InlineCommentProps) {
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
