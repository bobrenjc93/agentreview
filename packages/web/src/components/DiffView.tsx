"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type AgentReviewFile } from "@/lib/payload/types";
import { parseDiffString, type ParsedChange } from "@/lib/diff/parser";
import { DiffLine } from "./DiffLine";
import { InlineCommentForm } from "./InlineCommentForm";
import { InlineComment } from "./InlineComment";
import { useComments } from "@/hooks/useComments";
import { useHighlighter, type ThemedToken } from "@/hooks/useHighlighter";
import { type BundledLanguage } from "shiki";

interface DiffViewProps {
  file: AgentReviewFile;
}

interface FoldRange {
  start: number;
  end: number;
}

interface PreparedChange {
  change: ParsedChange;
  content: string;
  tokenIndex: number;
}

interface PreparedChunk {
  content: string;
  changes: PreparedChange[];
  foldRangeByStart: Map<number, FoldRange>;
  foldStarts: number[];
}

type OpenBracket = "{" | "[" | "(";
type CloseBracket = "}" | "]" | ")";
type QuoteChar = "\"" | "'" | "`";

const CLOSE_TO_OPEN: Record<CloseBracket, OpenBracket> = {
  "}": "{",
  "]": "[",
  ")": "(",
};

function stripDiffPrefix(content: string): string {
  const marker = content[0];
  if (marker === "+" || marker === "-" || marker === " ") {
    return content.slice(1);
  }
  return content;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function getIndentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width += 1;
      continue;
    }
    if (char === "\t") {
      width += 2;
      continue;
    }
    break;
  }
  return width;
}

function buildIndentRanges(lines: string[]): FoldRange[] {
  const ranges: FoldRange[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    if (isBlank(lines[i])) continue;

    const baseIndent = getIndentWidth(lines[i]);
    let nextLine = i + 1;

    while (nextLine < lines.length && isBlank(lines[nextLine])) {
      nextLine += 1;
    }

    if (nextLine >= lines.length) continue;

    const nextIndent = getIndentWidth(lines[nextLine]);
    if (nextIndent <= baseIndent) continue;

    let end = nextLine;
    for (let j = nextLine + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      if (getIndentWidth(lines[j]) <= baseIndent) break;
      end = j;
    }

    if (end > i) {
      ranges.push({ start: i, end });
    }
  }

  return ranges;
}

function buildBracketRanges(lines: string[]): FoldRange[] {
  const ranges: FoldRange[] = [];
  const stack: Array<{ char: OpenBracket; line: number }> = [];
  let inBlockComment = false;
  let inString: QuoteChar | null = null;
  let escaped = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = i + 1 < line.length ? line[i + 1] : "";

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === inString) {
          inString = null;
        }
        continue;
      }

      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }

      if (char === "/" && next === "/") {
        break;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        inString = char;
        escaped = false;
        continue;
      }

      if (char === "{" || char === "[" || char === "(") {
        stack.push({ char, line: lineIndex });
        continue;
      }

      if (char === "}" || char === "]" || char === ")") {
        const expected = CLOSE_TO_OPEN[char];
        const top = stack[stack.length - 1];
        if (!top || top.char !== expected) continue;

        stack.pop();
        if (top.line < lineIndex) {
          ranges.push({ start: top.line, end: lineIndex });
        }
      }
    }

    escaped = false;
  }

  return ranges;
}

function buildFoldRanges(lines: string[]): FoldRange[] {
  const candidates = [...buildBracketRanges(lines), ...buildIndentRanges(lines)];
  const byStart = new Map<number, FoldRange>();

  for (const range of candidates) {
    if (range.end <= range.start) continue;
    const existing = byStart.get(range.start);
    if (!existing || range.end > existing.end) {
      byStart.set(range.start, range);
    }
  }

  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

function foldKey(chunkIndex: number, start: number): string {
  return `${chunkIndex}:${start}`;
}

export function DiffView({ file }: DiffViewProps) {
  const [commentingLine, setCommentingLine] = useState<{
    lineNumber: number;
    content: string;
  } | null>(null);
  const [collapsedFolds, setCollapsedFolds] = useState<Set<string>>(new Set());
  const { addComment, removeComment, getCommentsForLine } = useComments();
  const highlighter = useHighlighter();

  const parsed = parseDiffString(file.diff);
  const chunks = parsed[0]?.chunks || [];

  const preparedChunks = useMemo<PreparedChunk[]>(() => {
    let tokenIndex = 0;
    return chunks.map((chunk) => {
      const preparedChanges = chunk.changes.map((change) => ({
        change,
        content: stripDiffPrefix(change.content),
        tokenIndex: tokenIndex++,
      }));
      const foldRanges = buildFoldRanges(
        preparedChanges.map((preparedChange) => preparedChange.content)
      );
      return {
        content: chunk.content,
        changes: preparedChanges,
        foldRangeByStart: new Map(
          foldRanges.map((range) => [range.start, range])
        ),
        foldStarts: foldRanges.map((range) => range.start),
      };
    });
  }, [chunks]);

  useEffect(() => {
    setCollapsedFolds(new Set());
  }, [file.diff, file.path]);

  const allFoldKeys = useMemo(
    () =>
      preparedChunks.flatMap((chunk, chunkIndex) =>
        chunk.foldStarts.map((start) => foldKey(chunkIndex, start))
      ),
    [preparedChunks]
  );

  const hasFoldRanges = allFoldKeys.length > 0;
  const allCollapsed =
    hasFoldRanges && allFoldKeys.every((key) => collapsedFolds.has(key));
  const anyCollapsed = collapsedFolds.size > 0;

  const toggleFold = useCallback((chunkIndex: number, start: number) => {
    const key = foldKey(chunkIndex, start);
    setCollapsedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsedFolds(new Set(allFoldKeys));
  }, [allFoldKeys]);

  const expandAll = useCallback(() => {
    setCollapsedFolds(new Set());
  }, []);

  // Build a map of line content -> tokens for syntax highlighting
  const tokenMap = useMemo(() => {
    if (!highlighter || !file.language) return null;
    const loadedLangs = highlighter.getLoadedLanguages();
    if (!loadedLangs.includes(file.language)) return null;

    // Collect all unique line contents from the diff
    const lines: string[] = [];
    for (const chunk of preparedChunks) {
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
  }, [highlighter, file.language, preparedChunks]);

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
      <div className="overflow-x-auto">
        <div className="min-w-full">
          {hasFoldRanges && (
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-gray-700 bg-gray-900">
              <button
                type="button"
                onClick={collapseAll}
                disabled={allCollapsed}
                className="px-2.5 py-1 text-xs border border-gray-700 rounded text-gray-300 hover:text-white hover:border-gray-500 disabled:text-gray-600 disabled:border-gray-800 transition-colors"
              >
                Collapse code
              </button>
              <button
                type="button"
                onClick={expandAll}
                disabled={!anyCollapsed}
                className="px-2.5 py-1 text-xs border border-gray-700 rounded text-gray-300 hover:text-white hover:border-gray-500 disabled:text-gray-600 disabled:border-gray-800 transition-colors"
              >
                Expand code
              </button>
            </div>
          )}
          {preparedChunks.map((chunk, ci) => (
            <div key={ci}>
              <div className="bg-gray-800 text-gray-400 text-xs font-mono px-4 py-1 border-b border-gray-700">
                {chunk.content}
              </div>
              {(() => {
                const rows: JSX.Element[] = [];
                for (let li = 0; li < chunk.changes.length; li++) {
                  const rowIndex = li;
                  const preparedChange = chunk.changes[rowIndex];
                  const change = preparedChange.change;
                  const tokens =
                    tokenMap?.get(preparedChange.tokenIndex) ?? undefined;
                  const lineContent = preparedChange.content;
                  const foldRange = chunk.foldRangeByStart.get(rowIndex);
                  const foldKeyValue = foldKey(ci, rowIndex);
                  const isFolded =
                    !!foldRange &&
                    collapsedFolds.has(foldKeyValue);

                  const lineNum =
                    change.type === "add" || change.type === "normal"
                      ? (change as { ln2?: number; ln?: number }).ln2 ??
                        (change as { ln?: number }).ln ??
                        0
                      : (change as { ln1?: number; ln?: number }).ln1 ??
                        (change as { ln?: number }).ln ??
                        0;
                  const lineComments = getCommentsForLine(file.path, lineNum);
                  const isCommenting = commentingLine?.lineNumber === lineNum;

                  rows.push(
                    <div key={`${ci}-${rowIndex}`}>
                      <DiffLine
                        change={change}
                        content={lineContent}
                        onClickLineNumber={handleClickLine}
                        highlighted={lineComments.length > 0}
                        tokens={tokens}
                        foldable={!!foldRange}
                        folded={isFolded}
                        onToggleFold={
                          foldRange
                            ? () => toggleFold(ci, rowIndex)
                            : undefined
                        }
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

                  if (foldRange && isFolded) {
                    const hiddenLineCount = foldRange.end - rowIndex;
                    rows.push(
                      <div
                        key={`folded-${ci}-${rowIndex}`}
                        className="flex items-center font-mono text-xs leading-6 bg-gray-950/40 text-gray-400"
                      >
                        <span className="w-6 shrink-0" />
                        <span className="w-10 shrink-0" />
                        <span className="w-10 shrink-0" />
                        <span className="w-4 text-center shrink-0">…</span>
                        <button
                          type="button"
                          onClick={() => toggleFold(ci, rowIndex)}
                          className="flex-1 px-2 text-left hover:text-blue-300"
                        >
                          ... {hiddenLineCount} line
                          {hiddenLineCount === 1 ? "" : "s"} folded
                        </button>
                      </div>
                    );
                    li = foldRange.end;
                  }
                }
                return rows;
              })()}
            </div>
          ))}
          {preparedChunks.length === 0 && (
            <div className="p-4 text-gray-500 text-sm">No diff hunks to display</div>
          )}
        </div>
      </div>
    </div>
  );
}
