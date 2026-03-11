"use client";

import {
  type ReviewComment,
  formatReviewCommentRange,
} from "@/lib/comments/types";

interface InlineCommentProps {
  comment: ReviewComment;
  onDelete: (id: string) => void;
}

export function InlineComment({ comment, onDelete }: InlineCommentProps) {
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
        <button
          onClick={() => onDelete(comment.id)}
          className="text-gray-500 hover:text-red-400 text-xs shrink-0 transition-colors"
          title="Delete comment"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
