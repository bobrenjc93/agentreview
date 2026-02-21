"use client";

import { useState, useMemo } from "react";
import { type AgentReviewFile } from "@/lib/payload/types";
import { parseDiffString } from "@/lib/diff/parser";
import { DiffLine } from "./DiffLine";
import { InlineCommentForm } from "./InlineCommentForm";
import { InlineComment } from "./InlineComment";
import { useComments } from "@/hooks/useComments";
import { useHighlighter, type ThemedToken } from "@/hooks/useHighlighter";
import { type BundledLanguage } from "shiki";

interface DiffViewProps {
  file: AgentReviewFile;
}

export function DiffView({ file }: DiffViewProps) {
  const [commentingLine, setCommentingLine] = useState<{
    lineNumber: number;
    content: string;
  } | null>(null);
  const { addComment, removeComment, getCommentsForLine } = useComments();
  const highlighter = useHighlighter();

  const parsed = parseDiffString(file.diff);
  const chunks = parsed[0]?.chunks || [];

  // Build a map of line content -> tokens for syntax highlighting
  const tokenMap = useMemo(() => {
    if (!highlighter || !file.language) return null;
    const loadedLangs = highlighter.getLoadedLanguages();
    if (!loadedLangs.includes(file.language)) return null;

    // Collect all unique line contents from the diff
    const lines: string[] = [];
    for (const chunk of chunks) {
      for (const change of chunk.changes) {
        lines.push(change.content);
      }
    }

    // Tokenize as a single block so Shiki can track multi-line state
    const fullText = lines.join("\n");
    const result = highlighter.codeToTokens(fullText, {
      lang: file.language as BundledLanguage,
      theme: "github-dark",
    });

    // result.tokens is an array of lines, each line is ThemedToken[]
    const map = new Map<number, ThemedToken[]>();
    result.tokens.forEach((lineTokens, i) => {
      map.set(i, lineTokens);
    });
    return map;
  }, [highlighter, file.language, file.diff, chunks]);

  // Build a sequential index to look up tokens
  let lineIdx = 0;

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
            const currentLineIdx = lineIdx++;
            const tokens = tokenMap?.get(currentLineIdx) ?? undefined;

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
                  tokens={tokens}
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
