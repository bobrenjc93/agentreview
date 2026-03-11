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
import {
  formatCommentRange,
  type ReviewComment,
  type ReviewCommentSide,
} from "@/lib/comments/types";

interface DiffViewProps {
  file: AgentReviewFile;
}

interface FoldRange {
  start: number;
  end: number;
}

interface ChunkLineRange {
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

interface VisibleCommentableRow {
  key: string;
  chunkIndex: number;
  rowIndex: number;
  order: number;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ActiveLineSelection {
  side: ReviewCommentSide;
  anchorRowKey: string;
  currentRowKey: string;
}

interface PendingCommentRange {
  side: ReviewCommentSide;
  startLineNumber: number;
  endLineNumber: number;
  lineContent: string;
  lineContents: string[];
  startRowKey: string;
  endRowKey: string;
}

type OpenBracket = "{" | "[" | "(";
type CloseBracket = "}" | "]" | ")";
type QuoteChar = "\"" | "'" | "`";

const CLOSE_TO_OPEN: Record<CloseBracket, OpenBracket> = {
  "}": "{",
  "]": "[",
  ")": "(",
};

const CONTEXT_EXPAND_STEP = 20;

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

function commentRowKey(chunkIndex: number, rowIndex: number): string {
  return `${chunkIndex}:${rowIndex}`;
}

function getChangeOldLineNumber(change: ParsedChange): number | null {
  if (change.type !== "del" && change.type !== "normal") return null;
  const lineNumber =
    (change as { ln1?: number; ln?: number }).ln1 ??
    (change as { ln?: number }).ln;
  if (typeof lineNumber !== "number" || lineNumber <= 0) {
    return null;
  }
  return lineNumber;
}

function getChangeNewLineNumber(change: ParsedChange): number | null {
  if (change.type !== "add" && change.type !== "normal") return null;
  const lineNumber =
    (change as { ln2?: number; ln?: number }).ln2 ??
    (change as { ln?: number }).ln;
  if (typeof lineNumber !== "number" || lineNumber <= 0) {
    return null;
  }
  return lineNumber;
}

function buildChunkLineRanges(chunks: PreparedChunk[]): Array<ChunkLineRange | null> {
  return chunks.map((chunk) => {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;

    for (const preparedChange of chunk.changes) {
      const lineNumber = getChangeNewLineNumber(preparedChange.change);
      if (lineNumber == null) continue;
      if (lineNumber < start) start = lineNumber;
      if (lineNumber > end) end = lineNumber;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }

    return { start, end };
  });
}

function getRowLineNumber(
  row: VisibleCommentableRow,
  side: ReviewCommentSide
): number | undefined {
  return side === "old" ? row.oldLineNumber : row.newLineNumber;
}

function buildSelectedCommentRange(
  selection: ActiveLineSelection,
  rows: VisibleCommentableRow[]
): PendingCommentRange | null {
  const rowIndexes = new Map(rows.map((row, index) => [row.key, index]));
  const anchorIndex = rowIndexes.get(selection.anchorRowKey);
  const currentIndex = rowIndexes.get(selection.currentRowKey);
  if (anchorIndex == null || currentIndex == null) {
    return null;
  }

  const startIndex = Math.min(anchorIndex, currentIndex);
  const endIndex = Math.max(anchorIndex, currentIndex);
  const selectedRows = rows
    .slice(startIndex, endIndex + 1)
    .filter((row) => getRowLineNumber(row, selection.side) != null);

  if (selectedRows.length === 0) {
    return null;
  }

  const firstRow = selectedRows[0];
  const lastRow = selectedRows[selectedRows.length - 1];
  const startLineNumber = getRowLineNumber(firstRow, selection.side);
  const endLineNumber = getRowLineNumber(lastRow, selection.side);

  if (startLineNumber == null || endLineNumber == null) {
    return null;
  }

  return {
    side: selection.side,
    startLineNumber,
    endLineNumber,
    lineContent: firstRow.content,
    lineContents: selectedRows.map((row) => row.content),
    startRowKey: firstRow.key,
    endRowKey: lastRow.key,
  };
}

export function DiffView({ file }: DiffViewProps) {
  const [commentingRange, setCommentingRange] = useState<PendingCommentRange | null>(null);
  const [dragSelection, setDragSelection] = useState<ActiveLineSelection | null>(null);
  const [collapsedFolds, setCollapsedFolds] = useState<Set<string>>(new Set());
  const [expandedContextByGap, setExpandedContextByGap] = useState<
    Record<number, { up: number; down: number }>
  >({});
  const { addComment, removeComment, getCommentsEndingOnLine, getCommentsForLine } = useComments();
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

  useEffect(() => {
    setCommentingRange(null);
    setDragSelection(null);
  }, [file.diff, file.path]);

  useEffect(() => {
    setExpandedContextByGap({});
  }, [file.diff, file.path, file.source]);

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

  const sourceLines = useMemo(
    () => (file.source ? file.source.split("\n") : []),
    [file.source]
  );

  const chunkLineRanges = useMemo(
    () => buildChunkLineRanges(preparedChunks),
    [preparedChunks]
  );

  const visibleCommentableRows = useMemo<VisibleCommentableRow[]>(() => {
    const rows: VisibleCommentableRow[] = [];

    for (let chunkIndex = 0; chunkIndex < preparedChunks.length; chunkIndex++) {
      const chunk = preparedChunks[chunkIndex];
      for (let rowIndex = 0; rowIndex < chunk.changes.length; rowIndex++) {
        const preparedChange = chunk.changes[rowIndex];
        rows.push({
          key: commentRowKey(chunkIndex, rowIndex),
          chunkIndex,
          rowIndex,
          order: rows.length,
          content: preparedChange.content,
          oldLineNumber: getChangeOldLineNumber(preparedChange.change) ?? undefined,
          newLineNumber: getChangeNewLineNumber(preparedChange.change) ?? undefined,
        });

        const foldRange = chunk.foldRangeByStart.get(rowIndex);
        const isFolded = !!foldRange && collapsedFolds.has(foldKey(chunkIndex, rowIndex));
        if (foldRange && isFolded) {
          rowIndex = foldRange.end;
        }
      }
    }

    return rows;
  }, [preparedChunks, collapsedFolds]);

  const activeSelectionRows = useMemo(() => {
    if (dragSelection) {
      return buildSelectedCommentRange(dragSelection, visibleCommentableRows);
    }
    return commentingRange;
  }, [commentingRange, dragSelection, visibleCommentableRows]);

  const selectedRowKeys = useMemo(() => {
    if (!activeSelectionRows) return new Set<string>();

    const rowIndexes = new Map(
      visibleCommentableRows.map((row, index) => [row.key, index])
    );
    const startIndex = rowIndexes.get(activeSelectionRows.startRowKey);
    const endIndex = rowIndexes.get(activeSelectionRows.endRowKey);
    if (startIndex == null || endIndex == null) {
      return new Set<string>();
    }

    const keys = new Set<string>();
    for (const row of visibleCommentableRows.slice(startIndex, endIndex + 1)) {
      if (getRowLineNumber(row, activeSelectionRows.side) != null) {
        keys.add(row.key);
      }
    }
    return keys;
  }, [activeSelectionRows, visibleCommentableRows]);

  const finalizeDragSelection = useCallback(() => {
    if (!dragSelection) return;
    setCommentingRange(buildSelectedCommentRange(dragSelection, visibleCommentableRows));
    setDragSelection(null);
  }, [dragSelection, visibleCommentableRows]);

  useEffect(() => {
    if (!dragSelection) return;

    function handlePointerUp() {
      finalizeDragSelection();
    }

    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragSelection, finalizeDragSelection]);

  const canRenderContextGaps = useMemo(
    () =>
      sourceLines.length > 0 &&
      chunkLineRanges.length > 0 &&
      chunkLineRanges.every((range) => range !== null),
    [sourceLines.length, chunkLineRanges]
  );

  const resolvedChunkRanges = useMemo(
    () => (canRenderContextGaps ? (chunkLineRanges as ChunkLineRange[]) : []),
    [canRenderContextGaps, chunkLineRanges]
  );

  const getGapBounds = useCallback(
    (gapIndex: number): ChunkLineRange | null => {
      if (!canRenderContextGaps) return null;

      if (gapIndex < 0 || gapIndex > resolvedChunkRanges.length) {
        return null;
      }

      let start = 1;
      let end = sourceLines.length;

      if (gapIndex === 0) {
        end = resolvedChunkRanges[0].start - 1;
      } else if (gapIndex === resolvedChunkRanges.length) {
        start = resolvedChunkRanges[resolvedChunkRanges.length - 1].end + 1;
      } else {
        start = resolvedChunkRanges[gapIndex - 1].end + 1;
        end = resolvedChunkRanges[gapIndex].start - 1;
      }

      if (start > end) return null;
      return { start, end };
    },
    [canRenderContextGaps, resolvedChunkRanges, sourceLines.length]
  );

  const expandGapContext = useCallback(
    (gapIndex: number, direction: "up" | "down") => {
      setExpandedContextByGap((prev) => {
        const current = prev[gapIndex] ?? { up: 0, down: 0 };
        const next = {
          up:
            direction === "up"
              ? current.up + CONTEXT_EXPAND_STEP
              : current.up,
          down:
            direction === "down"
              ? current.down + CONTEXT_EXPAND_STEP
              : current.down,
        };
        return { ...prev, [gapIndex]: next };
      });
    },
    []
  );

  const expandAllGapContext = useCallback(
    (gapIndex: number) => {
      const bounds = getGapBounds(gapIndex);
      if (!bounds) return;

      const totalHiddenLines = bounds.end - bounds.start + 1;
      if (totalHiddenLines <= 0) return;

      setExpandedContextByGap((prev) => ({
        ...prev,
        [gapIndex]: { up: 0, down: totalHiddenLines },
      }));
    },
    [getGapBounds]
  );

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

  function handleStartLineSelection({
    rowKey,
    side,
  }: {
    rowKey: string;
    side: ReviewCommentSide;
  }) {
    setCommentingRange(null);
    setDragSelection({
      side,
      anchorRowKey: rowKey,
      currentRowKey: rowKey,
    });
  }

  function handleExtendLineSelection({
    rowKey,
    side,
  }: {
    rowKey: string;
    side: ReviewCommentSide;
  }) {
    setDragSelection((current) => {
      if (!current || current.side !== side) {
        return current;
      }
      if (current.currentRowKey === rowKey) {
        return current;
      }
      return { ...current, currentRowKey: rowKey };
    });
  }

  function handleAddComment(body: string) {
    if (!commentingRange) return;
    addComment({
      filePath: file.path,
      lineNumber: commentingRange.startLineNumber,
      startLineNumber: commentingRange.startLineNumber,
      endLineNumber: commentingRange.endLineNumber,
      side: commentingRange.side,
      lineContent: commentingRange.lineContent,
      lineContents: commentingRange.lineContents,
      body,
    });
    setCommentingRange(null);
  }

  function renderContextLine(
    gapIndex: number,
    lineNumber: number
  ): JSX.Element {
    const content = sourceLines[lineNumber - 1] ?? "";
    return (
      <div
        key={`gap-${gapIndex}-line-${lineNumber}`}
        className="flex font-mono text-xs leading-6 bg-gray-950/20"
      >
        <span className="w-6 shrink-0" />
        <span className="w-10 shrink-0 px-1 text-right text-gray-700" />
        <span className="w-10 shrink-0 px-1 text-right text-gray-600">
          {lineNumber}
        </span>
        <span className="w-4 shrink-0 text-center text-gray-700"> </span>
        <span className="flex-1 whitespace-pre px-2 text-gray-500">
          {content.length > 0 ? content : "\u00A0"}
        </span>
      </div>
    );
  }

  function renderContextGap(gapIndex: number): JSX.Element | null {
    const bounds = getGapBounds(gapIndex);
    if (!bounds) return null;

    const totalHiddenLines = bounds.end - bounds.start + 1;
    if (totalHiddenLines <= 0) return null;

    const expanded = expandedContextByGap[gapIndex] ?? { up: 0, down: 0 };
    const downVisible = Math.min(expanded.down, totalHiddenLines);
    const upVisible = Math.min(expanded.up, totalHiddenLines - downVisible);
    const remainingHidden = totalHiddenLines - downVisible - upVisible;

    const rows: JSX.Element[] = [];

    for (let ln = bounds.start; ln < bounds.start + downVisible; ln++) {
      rows.push(renderContextLine(gapIndex, ln));
    }

    if (remainingHidden > 0) {
      rows.push(
        <div
          key={`gap-${gapIndex}-controls`}
          className="flex items-center font-mono text-xs leading-6 bg-gray-900 border-y border-gray-800"
        >
          <span className="w-6 shrink-0" />
          <span className="w-10 shrink-0" />
          <span className="w-10 shrink-0" />
          <span className="w-4 shrink-0 text-center text-gray-600">…</span>
          <div className="flex items-center gap-2 px-2 py-1">
            <button
              type="button"
              onClick={() => expandGapContext(gapIndex, "down")}
              className="rounded border border-gray-700 px-1.5 text-[11px] text-gray-300 hover:border-gray-500 hover:text-white"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => expandGapContext(gapIndex, "up")}
              className="rounded border border-gray-700 px-1.5 text-[11px] text-gray-300 hover:border-gray-500 hover:text-white"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => expandAllGapContext(gapIndex)}
              className="rounded border border-gray-700 px-1.5 text-[11px] text-gray-300 hover:border-gray-500 hover:text-white"
            >
              Expand all
            </button>
            <span className="text-[11px] text-gray-500">
              {remainingHidden} hidden line{remainingHidden === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      );
    }

    for (let ln = bounds.end - upVisible + 1; ln <= bounds.end; ln++) {
      rows.push(renderContextLine(gapIndex, ln));
    }

    return (
      <div key={`gap-${gapIndex}`} className="border-b border-gray-800/60">
        {rows}
      </div>
    );
  }

  return (
    <div className="border border-gray-700 overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-full">
          {preparedChunks.map((chunk, ci) => (
            <div key={ci}>
              {renderContextGap(ci)}
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
                  const rowKey = commentRowKey(ci, rowIndex);
                  const isFolded =
                    !!foldRange &&
                    collapsedFolds.has(foldKeyValue);

                  const oldLineNumber = getChangeOldLineNumber(change) ?? undefined;
                  const newLineNumber = getChangeNewLineNumber(change) ?? undefined;
                  const oldLineComments =
                    typeof oldLineNumber === "number"
                      ? getCommentsForLine(file.path, oldLineNumber, "old")
                      : [];
                  const newLineComments =
                    typeof newLineNumber === "number"
                      ? getCommentsForLine(file.path, newLineNumber, "new")
                      : [];
                  const endingComments = new Map<string, ReviewComment>();
                  if (typeof oldLineNumber === "number") {
                    for (const comment of getCommentsEndingOnLine(
                      file.path,
                      oldLineNumber,
                      "old"
                    )) {
                      endingComments.set(comment.id, comment);
                    }
                  }
                  if (typeof newLineNumber === "number") {
                    for (const comment of getCommentsEndingOnLine(
                      file.path,
                      newLineNumber,
                      "new"
                    )) {
                      endingComments.set(comment.id, comment);
                    }
                  }
                  const rowComments = [...endingComments.values()];
                  const isCommenting = commentingRange?.endRowKey === rowKey;
                  const selectedSide = activeSelectionRows?.side;
                  const isSelected = selectedRowKeys.has(rowKey);

                  rows.push(
                    <div key={rowKey}>
                      <DiffLine
                        rowKey={rowKey}
                        change={change}
                        content={lineContent}
                        onStartLineSelection={handleStartLineSelection}
                        onExtendLineSelection={handleExtendLineSelection}
                        highlighted={
                          oldLineComments.length > 0 ||
                          newLineComments.length > 0
                        }
                        oldHighlighted={oldLineComments.length > 0}
                        newHighlighted={newLineComments.length > 0}
                        selected={isSelected}
                        oldSelected={
                          isSelected &&
                          selectedSide === "old" &&
                          typeof oldLineNumber === "number"
                        }
                        newSelected={
                          isSelected &&
                          selectedSide === "new" &&
                          typeof newLineNumber === "number"
                        }
                        tokens={tokens}
                        foldable={!!foldRange}
                        folded={isFolded}
                        onToggleFold={
                          foldRange
                            ? () => toggleFold(ci, rowIndex)
                            : undefined
                          }
                      />
                      {rowComments.map((c) => (
                        <InlineComment
                          key={c.id}
                          comment={c}
                          onDelete={removeComment}
                        />
                      ))}
                      {isCommenting && (
                        <InlineCommentForm
                          selectionLabel={formatCommentRange(
                            commentingRange.startLineNumber,
                            commentingRange.endLineNumber,
                            commentingRange.side
                          )}
                          onSubmit={handleAddComment}
                          onCancel={() => setCommentingRange(null)}
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
          {renderContextGap(preparedChunks.length)}
          {preparedChunks.length === 0 && (
            <div className="p-4 text-gray-500 text-sm">No diff hunks to display</div>
          )}
        </div>
      </div>
    </div>
  );
}
