"use client";

import { useState } from "react";
import { type AgentReviewFile } from "@/lib/payload/types";
import { parseDiffString } from "@/lib/diff/parser";
import { DiffLine } from "./DiffLine";
import { InlineCommentForm } from "./InlineCommentForm";
import { InlineComment } from "./InlineComment";
import { useComments } from "@/hooks/useComments";

interface DiffViewProps {
  file: AgentReviewFile;
}

export function DiffView({ file }: DiffViewProps) {
  const [commentingLine, setCommentingLine] = useState<{
    lineNumber: number;
    content: string;
  } | null>(null);
  const { addComment, removeComment, getCommentsForLine } = useComments();

  const parsed = parseDiffString(file.diff);
  const chunks = parsed[0]?.chunks || [];

  function handleClickLine(lineNumber: number, content: string) {
    setCommentingLine({ lineNumber, content });
  }

  function handleAddComment(body: string) {
    if (!commentingLine) return;
    addComment({
      filePath: file.path,
      lineNumber: commentingLine.lineNumber,
      lineContent: commentingLine.content,
      body,
    });
    setCommentingLine(null);
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {chunks.map((chunk, ci) => (
        <div key={ci}>
          <div className="bg-gray-800 text-gray-400 text-xs font-mono px-4 py-1 border-b border-gray-700">
            {chunk.content}
          </div>
          {chunk.changes.map((change, li) => {
            const lineNum =
              change.type === "add" || change.type === "normal"
                ? (change as { ln2?: number; ln?: number }).ln2 ??
                  (change as { ln?: number }).ln ??
                  0
                : (change as { ln1?: number; ln?: number }).ln1 ??
                  (change as { ln?: number }).ln ??
                  0;
            const lineComments = getCommentsForLine(file.path, lineNum);
            const isCommenting =
              commentingLine?.lineNumber === lineNum;

            return (
              <div key={`${ci}-${li}`}>
                <DiffLine
                  change={change}
                  onClickLineNumber={handleClickLine}
                  highlighted={lineComments.length > 0}
                />
                {lineComments.map((c) => (
                  <InlineComment
                    key={c.id}
                    comment={c}
                    onDelete={removeComment}
                  />
                ))}
                {isCommenting && (
                  <InlineCommentForm
                    onSubmit={handleAddComment}
                    onCancel={() => setCommentingLine(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
      {chunks.length === 0 && (
        <div className="p-4 text-gray-500 text-sm">No diff hunks to display</div>
      )}
    </div>
  );
}
