"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { type AgentReviewFile } from "@/lib/payload/types";
import { parseDiffString, type ParsedChange } from "@/lib/diff/parser";
import { buildFoldRanges, type FoldRange } from "@/lib/folding";
import { DiffLine } from "./DiffLine";
import { InlineCommentForm } from "./InlineCommentForm";
import { InlineComment } from "./InlineComment";
import { useTheme } from "./ThemeProvider";
import { useComments } from "@/hooks/useComments";
import { useHighlighter, type ThemedToken } from "@/hooks/useHighlighter";
import {
  canHighlightLanguage,
  highlightCodeLines,
} from "@/lib/highlighting";
import {
  commentEndsOnLine,
  formatCommentRangeFromParts,
  type ReviewComment,
  type ReviewCommentSide,
} from "@/lib/comments/types";

type DiffViewMode = "unified" | "split";

interface DiffViewProps {
  file: AgentReviewFile;
  fileId: string;
  segmentId: string;
  segmentLabel: string;
  segmentCommitHash?: string;
  segmentCommitMessage?: string;
  viewMode?: DiffViewMode;
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

interface SplitRenderedRow {
  key: string;
  old?: PreparedChange;
  new?: PreparedChange;
}

interface SplitPreparedChunk {
  content: string;
  rows: SplitRenderedRow[];
}

interface DeferredRenderBatch<T> {
  key: string;
  rows: T[];
  rowCount: number;
  rowKeys: string[];
}

interface VisibleCommentableRow {
  key: string;
  chunkIndex: number;
  rowIndex: number;
  order: number;
  oldContent?: string;
  newContent?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ActiveLineSelection {
  anchorSide: ReviewCommentSide;
  anchorRowKey: string;
  currentRowKey: string;
}

interface PendingCommentRange {
  side?: ReviewCommentSide;
  oldStartLineNumber?: number;
  oldEndLineNumber?: number;
  newStartLineNumber?: number;
  newEndLineNumber?: number;
  lineContent: string;
  lineContents: string[];
  startRowKey: string;
  endRowKey: string;
}

interface UnifiedRenderedRow {
  type: "change" | "fold-placeholder";
  key: string;
  rowKey?: string;
  preparedChange?: PreparedChange;
  rowIndex: number;
  oldLineNumber?: number;
  newLineNumber?: number;
  foldRange?: FoldRange;
  isFolded?: boolean;
  hiddenLineCount?: number;
}

interface DeferredRenderBlockProps {
  blockId: string;
  children: ReactNode;
  estimatedHeight: number;
  eagerOrder?: number;
  prioritize?: boolean;
}

const CONTEXT_EXPAND_STEP = 20;
const DARK_SHIKI_THEME = "github-dark";
const LIGHT_SHIKI_THEME = "github-light";
const DIFF_RENDER_BATCH_SIZE = 120;
const DIFF_RENDER_BATCH_THRESHOLD = 240;
const DIFF_RENDER_BATCH_ROOT_MARGIN = "1400px 0px";
const DIFF_RENDER_BATCH_STAGGER_MS = 40;
const DIFF_RENDER_BATCH_MAX_DELAY_MS = 640;
const ESTIMATED_DIFF_ROW_HEIGHT = 24;
const ESTIMATED_INLINE_COMMENT_HEIGHT = 92;
const ESTIMATED_INLINE_COMMENT_FORM_HEIGHT = 152;
const MAX_SOURCE_CONTEXT_TOKENIZED_LINES = 8000;
const MAX_DIFF_TOKENIZED_LINES = 12000;

function stripDiffPrefix(content: string): string {
  const marker = content[0];
  if (marker === "+" || marker === "-" || marker === " ") {
    return content.slice(1);
  }
  return content;
}

function countLines(content: string | undefined): number {
  if (!content) return 0;

  let lineCount = 1;
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }
  return lineCount;
}

function foldKey(chunkIndex: number, start: number): string {
  return `${chunkIndex}:${start}`;
}

function commentRowKey(chunkIndex: number, rowIndex: number): string {
  return `${chunkIndex}:${rowIndex}`;
}

function splitRowKey(
  chunkIndex: number,
  oldChange: PreparedChange | undefined,
  newChange: PreparedChange | undefined
): string {
  return `split:${chunkIndex}:${oldChange?.tokenIndex ?? "none"}:${newChange?.tokenIndex ?? "none"}`;
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

function buildTokenLineMap(
  highlighter: ReturnType<typeof useHighlighter>,
  code: string | undefined,
  language: string | undefined,
  shikiTheme: string
): Map<number, ThemedToken[]> | null {
  if (code == null) return null;
  const tokenLines = highlightCodeLines(highlighter, code, language, shikiTheme);
  if (!tokenLines) return null;

  const map = new Map<number, ThemedToken[]>();
  tokenLines.forEach((lineTokens, index) => {
    if (lineTokens) {
      map.set(index + 1, lineTokens);
    }
  });
  return map;
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

function buildSplitRows(
  chunkIndex: number,
  changes: PreparedChange[]
): SplitRenderedRow[] {
  const rows: SplitRenderedRow[] = [];

  for (let index = 0; index < changes.length; ) {
    const current = changes[index];
    if (current.change.type === "normal") {
      rows.push({
        key: splitRowKey(chunkIndex, current, current),
        old: current,
        new: current,
      });
      index += 1;
      continue;
    }

    const deletions: PreparedChange[] = [];
    const additions: PreparedChange[] = [];

    while (index < changes.length) {
      const next = changes[index];
      if (next.change.type === "normal") {
        break;
      }
      if (next.change.type === "del") {
        deletions.push(next);
      } else if (next.change.type === "add") {
        additions.push(next);
      }
      index += 1;
    }

    const rowCount = Math.max(deletions.length, additions.length);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const oldChange = deletions[rowIndex];
      const newChange = additions[rowIndex];
      rows.push({
        key: splitRowKey(chunkIndex, oldChange, newChange),
        old: oldChange,
        new: newChange,
      });
    }
  }

  return rows;
}

function buildUnifiedRenderedRows(
  chunk: PreparedChunk,
  chunkIndex: number,
  collapsedFolds: Set<string>
): UnifiedRenderedRow[] {
  const rows: UnifiedRenderedRow[] = [];

  for (let rowLoopIndex = 0; rowLoopIndex < chunk.changes.length; rowLoopIndex++) {
    const rowIndex = rowLoopIndex;
    const preparedChange = chunk.changes[rowIndex];
    const change = preparedChange.change;
    const rowKey = commentRowKey(chunkIndex, rowIndex);
    const foldRange = chunk.foldRangeByStart.get(rowIndex);
    const isFolded = !!foldRange && collapsedFolds.has(foldKey(chunkIndex, rowIndex));

    rows.push({
      type: "change",
      key: rowKey,
      rowKey,
      preparedChange,
      rowIndex,
      oldLineNumber: getChangeOldLineNumber(change) ?? undefined,
      newLineNumber: getChangeNewLineNumber(change) ?? undefined,
      foldRange,
      isFolded,
    });

    if (foldRange && isFolded) {
      rows.push({
        type: "fold-placeholder",
        key: `folded-${chunkIndex}-${rowIndex}`,
        rowIndex,
        hiddenLineCount: foldRange.end - rowIndex,
      });
      rowLoopIndex = foldRange.end;
    }
  }

  return rows;
}

function buildDeferredRenderBatches<T extends { key: string }>(
  rows: T[],
  batchSize: number,
  keyPrefix: string,
  getRowKey: (row: T) => string | undefined = (row) => row.key
): DeferredRenderBatch<T>[] {
  const batches: DeferredRenderBatch<T>[] = [];

  for (let start = 0; start < rows.length; start += batchSize) {
    const batchRows = rows.slice(start, start + batchSize);
    batches.push({
      key: `${keyPrefix}:${batches.length}`,
      rows: batchRows,
      rowCount: batchRows.length,
      rowKeys: batchRows
        .map(getRowKey)
        .filter((rowKey): rowKey is string => !!rowKey),
    });
  }

  return batches;
}

function estimateDeferredBatchHeight(
  rowCount: number,
  rowKeys: string[],
  commentRowMap: Map<string, ReviewComment[]>,
  activeCommentRowKey: string | undefined
): number {
  let commentCount = 0;

  for (const rowKey of rowKeys) {
    commentCount += commentRowMap.get(rowKey)?.length ?? 0;
  }

  const includesCommentForm =
    !!activeCommentRowKey && rowKeys.includes(activeCommentRowKey);

  return (
    rowCount * ESTIMATED_DIFF_ROW_HEIGHT +
    commentCount * ESTIMATED_INLINE_COMMENT_HEIGHT +
    (includesCommentForm ? ESTIMATED_INLINE_COMMENT_FORM_HEIGHT : 0)
  );
}

function getRowContentForSide(
  row: VisibleCommentableRow,
  side: ReviewCommentSide
): string {
  return side === "old"
    ? row.oldContent ?? row.newContent ?? ""
    : row.newContent ?? row.oldContent ?? "";
}

function buildSingleSideLineContents(
  rows: VisibleCommentableRow[],
  side: ReviewCommentSide
): string[] {
  const lineContents = rows
    .filter((row) =>
      side === "old"
        ? typeof row.oldLineNumber === "number"
        : typeof row.newLineNumber === "number"
    )
    .map((row) => getRowContentForSide(row, side));

  return lineContents.length > 0 ? lineContents : [""];
}

function buildCombinedLineContents(rows: VisibleCommentableRow[]): string[] {
  const lineContents: string[] = [];

  for (const row of rows) {
    const hasOldLine = typeof row.oldLineNumber === "number";
    const hasNewLine = typeof row.newLineNumber === "number";
    const oldContent = row.oldContent ?? row.newContent ?? "";
    const newContent = row.newContent ?? row.oldContent ?? "";

    if (hasOldLine && hasNewLine) {
      if (oldContent === newContent) {
        lineContents.push(newContent);
      } else {
        lineContents.push(`- ${oldContent}`);
        lineContents.push(`+ ${newContent}`);
      }
      continue;
    }

    if (hasOldLine) {
      lineContents.push(`- ${oldContent}`);
      continue;
    }

    if (hasNewLine) {
      lineContents.push(`+ ${newContent}`);
    }
  }

  return lineContents.length > 0 ? lineContents : [""];
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
  const selectedRows = rows.slice(startIndex, endIndex + 1);

  if (selectedRows.length === 0) {
    return null;
  }

  const oldRows = selectedRows.filter(
    (row) => typeof row.oldLineNumber === "number"
  );
  const newRows = selectedRows.filter(
    (row) => typeof row.newLineNumber === "number"
  );
  const oldStartLineNumber = oldRows[0]?.oldLineNumber;
  const oldEndLineNumber = oldRows[oldRows.length - 1]?.oldLineNumber;
  const newStartLineNumber = newRows[0]?.newLineNumber;
  const newEndLineNumber = newRows[newRows.length - 1]?.newLineNumber;

  if (
    oldStartLineNumber == null &&
    oldEndLineNumber == null &&
    newStartLineNumber == null &&
    newEndLineNumber == null
  ) {
    return null;
  }

  const side =
    oldStartLineNumber != null && newStartLineNumber == null
      ? "old"
      : newStartLineNumber != null && oldStartLineNumber == null
        ? "new"
        : undefined;
  const isSingleRowSelection = startIndex === endIndex;

  if (isSingleRowSelection) {
    const singleSide = selection.anchorSide;
    const lineContents = buildSingleSideLineContents(selectedRows, singleSide);

    return {
      side: singleSide,
      oldStartLineNumber:
        singleSide === "old" ? oldStartLineNumber : undefined,
      oldEndLineNumber: singleSide === "old" ? oldEndLineNumber : undefined,
      newStartLineNumber:
        singleSide === "new" ? newStartLineNumber : undefined,
      newEndLineNumber: singleSide === "new" ? newEndLineNumber : undefined,
      lineContent: lineContents[0] || "",
      lineContents,
      startRowKey: selectedRows[0].key,
      endRowKey: selectedRows[selectedRows.length - 1].key,
    };
  }

  const lineContents = side
    ? buildSingleSideLineContents(selectedRows, side)
    : buildCombinedLineContents(selectedRows);

  return {
    side,
    oldStartLineNumber,
    oldEndLineNumber,
    newStartLineNumber,
    newEndLineNumber,
    lineContent: lineContents[0] || "",
    lineContents,
    startRowKey: selectedRows[0].key,
    endRowKey: selectedRows[selectedRows.length - 1].key,
  };
}

function getSplitFallbackTextClass(change: ParsedChange | undefined): string {
  if (!change) return "text-gray-700";
  if (change.type === "add") return "text-green-200";
  if (change.type === "del") return "text-red-200";
  return "text-gray-300";
}

function getSplitBackgroundClass(change: ParsedChange | undefined): string {
  if (!change) return "bg-gray-950/60";
  if (change.type === "add") return "bg-green-950/35";
  if (change.type === "del") return "bg-red-950/35";
  return "bg-gray-900/40";
}

function getSplitPrefix(
  change: ParsedChange | undefined,
  side: ReviewCommentSide
): string {
  if (!change) return " ";
  if (change.type === "add") {
    return side === "new" ? "+" : " ";
  }
  if (change.type === "del") {
    return side === "old" ? "-" : " ";
  }
  return " ";
}

function getSplitPrefixClass(
  change: ParsedChange | undefined,
  side: ReviewCommentSide
): string {
  const prefix = getSplitPrefix(change, side);
  if (prefix === "+") return "text-green-300";
  if (prefix === "-") return "text-red-300";
  return "text-gray-700";
}

function DeferredRenderBlock({
  blockId,
  children,
  estimatedHeight,
  eagerOrder = 0,
  prioritize = false,
}: DeferredRenderBlockProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldRender, setShouldRender] = useState(prioritize);

  useEffect(() => {
    if (prioritize) {
      setShouldRender(true);
      return;
    }

    if (shouldRender) {
      return;
    }

    const element = containerRef.current;
    if (!element) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }

    const eagerDelayMs = Math.min(
      Math.max(0, eagerOrder) * DIFF_RENDER_BATCH_STAGGER_MS,
      DIFF_RENDER_BATCH_MAX_DELAY_MS
    );
    const eagerTimer = window.setTimeout(() => {
      setShouldRender(true);
    }, eagerDelayMs);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      { rootMargin: DIFF_RENDER_BATCH_ROOT_MARGIN }
    );

    observer.observe(element);
    return () => {
      window.clearTimeout(eagerTimer);
      observer.disconnect();
    };
  }, [blockId, eagerOrder, prioritize, shouldRender]);

  return (
    <div ref={containerRef}>
      {shouldRender ? (
        children
      ) : (
        <div
          className="flex items-center justify-center bg-gray-950/20 px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-gray-600"
          style={{ minHeight: `${Math.max(estimatedHeight, 72)}px` }}
        >
          <span className="rounded-full border border-gray-800 bg-gray-950/70 px-3 py-1">
            Rendering nearby lines…
          </span>
        </div>
      )}
    </div>
  );
}

export function DiffView({
  file,
  fileId,
  segmentId,
  segmentLabel,
  segmentCommitHash,
  segmentCommitMessage,
  viewMode = "unified",
}: DiffViewProps) {
  const [commentingRange, setCommentingRange] = useState<PendingCommentRange | null>(null);
  const [dragSelection, setDragSelection] = useState<ActiveLineSelection | null>(null);
  const [collapsedFolds, setCollapsedFolds] = useState<Set<string>>(new Set());
  const [expandedContextByGap, setExpandedContextByGap] = useState<
    Record<number, { up: number; down: number }>
  >({});
  const {
    addComment,
    getCommentsForFile,
    updateComment,
    removeComment,
    getCommentsForLine,
  } = useComments();
  const highlighter = useHighlighter();
  const { theme } = useTheme();
  const shikiTheme =
    theme === "light" ? LIGHT_SHIKI_THEME : DARK_SHIKI_THEME;

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
        preparedChanges.map((preparedChange) => preparedChange.content),
        file.language
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
  }, [chunks, file.language]);

  const splitChunks = useMemo<SplitPreparedChunk[]>(
    () =>
      preparedChunks.map((chunk, chunkIndex) => ({
        content: chunk.content,
        rows: buildSplitRows(chunkIndex, chunk.changes),
      })),
    [preparedChunks]
  );

  useEffect(() => {
    setCollapsedFolds(new Set());
  }, [file.diff, fileId]);

  useEffect(() => {
    setCommentingRange(null);
    setDragSelection(null);
  }, [file.diff, fileId, viewMode]);

  useEffect(() => {
    setExpandedContextByGap({});
  }, [file.diff, fileId, file.source]);

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

  const oldSourceLineCount = useMemo(
    () => countLines(file.oldSource),
    [file.oldSource]
  );

  const diffLineCount = useMemo(
    () =>
      preparedChunks.reduce(
        (total, chunk) => total + chunk.changes.length,
        0
      ),
    [preparedChunks]
  );

  const shouldTokenizeSourceContext = useMemo(
    () =>
      sourceLines.length <= MAX_SOURCE_CONTEXT_TOKENIZED_LINES &&
      oldSourceLineCount <= MAX_SOURCE_CONTEXT_TOKENIZED_LINES,
    [oldSourceLineCount, sourceLines.length]
  );

  const shouldTokenizeDiffFallback = useMemo(
    () => diffLineCount <= MAX_DIFF_TOKENIZED_LINES,
    [diffLineCount]
  );

  const newSourceTokenMap = useMemo(
    () =>
      shouldTokenizeSourceContext
        ? buildTokenLineMap(highlighter, file.source, file.language, shikiTheme)
        : null,
    [highlighter, file.source, file.language, shikiTheme, shouldTokenizeSourceContext]
  );

  const oldSourceTokenMap = useMemo(
    () =>
      shouldTokenizeSourceContext
        ? buildTokenLineMap(
            highlighter,
            file.oldSource,
            file.language,
            shikiTheme
          )
        : null,
    [highlighter, file.oldSource, file.language, shikiTheme, shouldTokenizeSourceContext]
  );

  const chunkLineRanges = useMemo(
    () => buildChunkLineRanges(preparedChunks),
    [preparedChunks]
  );

  const unifiedVisibleCommentableRows = useMemo<VisibleCommentableRow[]>(() => {
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
          oldContent: preparedChange.content,
          newContent: preparedChange.content,
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

  const splitVisibleCommentableRows = useMemo<VisibleCommentableRow[]>(() => {
    const rows: VisibleCommentableRow[] = [];

    for (let chunkIndex = 0; chunkIndex < splitChunks.length; chunkIndex++) {
      const chunk = splitChunks[chunkIndex];
      chunk.rows.forEach((row, rowIndex) => {
        rows.push({
          key: row.key,
          chunkIndex,
          rowIndex,
          order: rows.length,
          oldContent: row.old?.content,
          newContent: row.new?.content,
          oldLineNumber: row.old
            ? getChangeOldLineNumber(row.old.change) ?? undefined
            : undefined,
          newLineNumber: row.new
            ? getChangeNewLineNumber(row.new.change) ?? undefined
            : undefined,
        });
      });
    }

    return rows;
  }, [splitChunks]);

  const visibleCommentableRows = useMemo(
    () =>
      viewMode === "split"
        ? splitVisibleCommentableRows
        : unifiedVisibleCommentableRows,
    [viewMode, splitVisibleCommentableRows, unifiedVisibleCommentableRows]
  );

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
      keys.add(row.key);
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

  const isGapFullyExpanded = useCallback(
    (gapIndex: number) => {
      const bounds = getGapBounds(gapIndex);
      if (!bounds) return false;

      const totalHiddenLines = bounds.end - bounds.start + 1;
      if (totalHiddenLines <= 0) return false;

      const expanded = expandedContextByGap[gapIndex] ?? { up: 0, down: 0 };
      const downVisible = Math.min(expanded.down, totalHiddenLines);
      const upVisible = Math.min(expanded.up, totalHiddenLines - downVisible);

      return downVisible + upVisible >= totalHiddenLines;
    },
    [expandedContextByGap, getGapBounds]
  );

  const fallbackTokenMap = useMemo(() => {
    if (!shouldTokenizeDiffFallback) return null;
    if (!canHighlightLanguage(highlighter, file.language)) return null;

    const lines: string[] = [];
    for (const chunk of preparedChunks) {
      for (const change of chunk.changes) {
        lines.push(change.content);
      }
    }

    const fullText = lines.join("\n");
    const tokenLines = highlightCodeLines(
      highlighter,
      fullText,
      file.language,
      shikiTheme
    );
    if (!tokenLines) return null;

    const map = new Map<number, ThemedToken[]>();
    tokenLines.forEach((lineTokens, index) => {
      if (lineTokens) {
        map.set(index, lineTokens);
      }
    });
    return map;
  }, [
    highlighter,
    file.language,
    preparedChunks,
    shikiTheme,
    shouldTokenizeDiffFallback,
  ]);

  function getTokensForChange(
    preparedChange: PreparedChange,
    side?: ReviewCommentSide
  ): ThemedToken[] | undefined {
    const oldLineNumber = getChangeOldLineNumber(preparedChange.change);
    const newLineNumber = getChangeNewLineNumber(preparedChange.change);

    if (side === "old") {
      return (
        (typeof oldLineNumber === "number"
          ? oldSourceTokenMap?.get(oldLineNumber)
          : undefined) ??
        fallbackTokenMap?.get(preparedChange.tokenIndex) ??
        undefined
      );
    }

    if (side === "new") {
      return (
        (typeof newLineNumber === "number"
          ? newSourceTokenMap?.get(newLineNumber)
          : undefined) ??
        fallbackTokenMap?.get(preparedChange.tokenIndex) ??
        undefined
      );
    }

    if (preparedChange.change.type === "del") {
      return (
        (typeof oldLineNumber === "number"
          ? oldSourceTokenMap?.get(oldLineNumber)
          : undefined) ??
        fallbackTokenMap?.get(preparedChange.tokenIndex) ??
        undefined
      );
    }

    if (preparedChange.change.type === "add") {
      return (
        (typeof newLineNumber === "number"
          ? newSourceTokenMap?.get(newLineNumber)
          : undefined) ??
        fallbackTokenMap?.get(preparedChange.tokenIndex) ??
        undefined
      );
    }

    return (
      (typeof newLineNumber === "number"
        ? newSourceTokenMap?.get(newLineNumber)
        : undefined) ??
      (typeof oldLineNumber === "number"
        ? oldSourceTokenMap?.get(oldLineNumber)
        : undefined) ??
      fallbackTokenMap?.get(preparedChange.tokenIndex) ??
      undefined
    );
  }

  const getLineComments = useCallback(
    (lineNumber: number | undefined, side: ReviewCommentSide) =>
      typeof lineNumber === "number"
        ? getCommentsForLine(fileId, lineNumber, side)
        : [],
    [fileId, getCommentsForLine]
  );

  const fileComments = useMemo(
    () => getCommentsForFile(fileId),
    [fileId, getCommentsForFile]
  );

  const commentRowMap = useMemo(() => {
    const rowsByComment = new Map<string, ReviewComment[]>();

    for (const comment of fileComments) {
      let anchorRowKey: string | null = null;

      for (const row of visibleCommentableRows) {
        const endsOnOldLine =
          typeof row.oldLineNumber === "number" &&
          commentEndsOnLine(comment, row.oldLineNumber, "old");
        const endsOnNewLine =
          typeof row.newLineNumber === "number" &&
          commentEndsOnLine(comment, row.newLineNumber, "new");

        if (endsOnOldLine || endsOnNewLine) {
          anchorRowKey = row.key;
        }
      }

      if (!anchorRowKey) {
        continue;
      }

      const rowComments = rowsByComment.get(anchorRowKey) ?? [];
      rowComments.push(comment);
      rowsByComment.set(anchorRowKey, rowComments);
    }

    return rowsByComment;
  }, [fileComments, visibleCommentableRows]);

  const unifiedRenderedChunks = useMemo(
    () =>
      preparedChunks.map((chunk, chunkIndex) => ({
        content: chunk.content,
        rows: buildUnifiedRenderedRows(chunk, chunkIndex, collapsedFolds),
      })),
    [collapsedFolds, preparedChunks]
  );

  const unifiedRenderBatches = useMemo(
    () =>
      unifiedRenderedChunks.map((chunk, chunkIndex) => ({
        content: chunk.content,
        rows: chunk.rows,
        batches: buildDeferredRenderBatches(
          chunk.rows,
          DIFF_RENDER_BATCH_SIZE,
          `unified:${chunkIndex}`,
          (row) => row.rowKey
        ),
      })),
    [unifiedRenderedChunks]
  );

  const splitRenderBatches = useMemo(
    () =>
      splitChunks.map((chunk, chunkIndex) => ({
        content: chunk.content,
        rows: chunk.rows,
        batches: buildDeferredRenderBatches(
          chunk.rows,
          DIFF_RENDER_BATCH_SIZE,
          `split:${chunkIndex}`
        ),
      })),
    [splitChunks]
  );

  const totalUnifiedRenderedRowCount = useMemo(
    () =>
      unifiedRenderedChunks.reduce(
        (total, chunk) => total + chunk.rows.length,
        0
      ),
    [unifiedRenderedChunks]
  );

  const totalSplitRenderedRowCount = useMemo(
    () =>
      splitChunks.reduce((total, chunk) => total + chunk.rows.length, 0),
    [splitChunks]
  );

  const shouldBatchUnifiedRows =
    totalUnifiedRenderedRowCount >= DIFF_RENDER_BATCH_THRESHOLD;
  const shouldBatchSplitRows =
    totalSplitRenderedRowCount >= DIFF_RENDER_BATCH_THRESHOLD;

  function handleStartLineSelection(
    rowKey: string,
    anchorSide: ReviewCommentSide
  ) {
    setCommentingRange(null);
    setDragSelection({
      anchorSide,
      anchorRowKey: rowKey,
      currentRowKey: rowKey,
    });
  }

  function handleExtendLineSelection(rowKey: string) {
    setDragSelection((current) => {
      if (!current) {
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
      fileId,
      filePath: file.path,
      segmentId,
      segmentLabel,
      commitHash: segmentCommitHash,
      commitMessage: segmentCommitMessage,
      oldStartLineNumber: commentingRange.oldStartLineNumber,
      oldEndLineNumber: commentingRange.oldEndLineNumber,
      newStartLineNumber: commentingRange.newStartLineNumber,
      newEndLineNumber: commentingRange.newEndLineNumber,
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
    const tokens = newSourceTokenMap?.get(lineNumber);
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
          {tokens ? (
            tokens.map((token, tokenIndex) => (
              <span
                key={`${lineNumber}-${tokenIndex}`}
                style={token.color ? { color: token.color } : undefined}
              >
                {token.content}
              </span>
            ))
          ) : (
            content.length > 0 ? content : "\u00A0"
          )}
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

    for (let lineNumber = bounds.start; lineNumber < bounds.start + downVisible; lineNumber++) {
      rows.push(renderContextLine(gapIndex, lineNumber));
    }

    if (remainingHidden > 0) {
      rows.push(
        <div
          key={`gap-${gapIndex}-controls`}
          className="flex items-center border-y border-gray-800 bg-gray-900 font-mono text-xs leading-6"
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

    for (let lineNumber = bounds.end - upVisible + 1; lineNumber <= bounds.end; lineNumber++) {
      rows.push(renderContextLine(gapIndex, lineNumber));
    }

    return (
      <div key={`gap-${gapIndex}`} className="border-b border-gray-800/60">
        {rows}
      </div>
    );
  }

  function renderTokens(
    tokens: ThemedToken[] | undefined,
    fallbackTextClass: string,
    content: string | undefined
  ) {
    if (tokens) {
      return tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ));
    }

    return <span className={fallbackTextClass}>{content?.length ? content : "\u00A0"}</span>;
  }

  function renderSplitLineNumber(
    rowKey: string,
    side: ReviewCommentSide,
    lineNumber: number | undefined,
    content: string | undefined,
    highlighted: boolean,
    selected: boolean
  ) {
    if (typeof lineNumber !== "number") {
      return <span className="w-12 shrink-0 px-2" />;
    }

    function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      handleStartLineSelection(rowKey, side);
    }

    return (
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerEnter={() => handleExtendLineSelection(rowKey)}
        className={`w-12 shrink-0 px-2 text-right select-none transition-colors ${
          selected
            ? "bg-blue-500/20 text-blue-200"
            : highlighted
              ? "bg-blue-500/10 text-blue-300"
              : "text-gray-600 hover:bg-gray-800 hover:text-blue-400"
        }`}
        title={content ? `Add comment on ${content}` : "Add comment"}
      >
        {lineNumber}
      </button>
    );
  }

  function renderSplitCell({
    rowKey,
    side,
    preparedChange,
    lineNumber,
    highlighted,
    selected,
    bordered,
  }: {
    rowKey: string;
    side: ReviewCommentSide;
    preparedChange?: PreparedChange;
    lineNumber?: number;
    highlighted: boolean;
    selected: boolean;
    bordered?: boolean;
  }) {
    const change = preparedChange?.change;
    const content = preparedChange?.content;
    const tokens = preparedChange ? getTokensForChange(preparedChange, side) : undefined;
    const prefix = getSplitPrefix(change, side);
    const prefixClass = getSplitPrefixClass(change, side);

    return (
      <div
        onPointerEnter={() => handleExtendLineSelection(rowKey)}
        className={`min-w-0 ${bordered ? "border-r border-gray-800/80" : ""}`}
      >
        <div
          className={`flex min-w-0 font-mono text-xs leading-6 ${
            getSplitBackgroundClass(change)
          } ${
            selected
              ? "ring-1 ring-inset ring-blue-400"
              : highlighted
                ? "ring-1 ring-inset ring-blue-500/60"
                : ""
          }`}
        >
          {renderSplitLineNumber(
            rowKey,
            side,
            lineNumber,
            content,
            highlighted,
            selected
          )}
          <span className={`w-4 shrink-0 text-center ${prefixClass}`}>{prefix}</span>
          <span className="min-w-0 flex-1 whitespace-pre px-2">
            {renderTokens(tokens, getSplitFallbackTextClass(change), content)}
          </span>
        </div>
      </div>
    );
  }

  function renderCommentBlock(rowKey: string, rowComments: ReviewComment[]) {
    return (
      <>
        {rowComments.map((comment) => (
          <InlineComment
            key={comment.id}
            comment={comment}
            onEdit={updateComment}
            onDelete={removeComment}
          />
        ))}
        {commentingRange?.endRowKey === rowKey && (
          <InlineCommentForm
            selectionLabel={formatCommentRangeFromParts(commentingRange)}
            onSubmit={handleAddComment}
            onCancel={() => setCommentingRange(null)}
          />
        )}
      </>
    );
  }

  function renderUnifiedRows(
    chunkIndex: number,
    renderedRows: UnifiedRenderedRow[]
  ) {
    return renderedRows.map((row) => {
      if (row.type === "fold-placeholder") {
        const hiddenLineCount = row.hiddenLineCount ?? 0;
        return (
          <div
            key={row.key}
            className="flex items-center bg-gray-950/40 font-mono text-xs leading-6 text-gray-400"
          >
            <span className="w-6 shrink-0" />
            <span className="w-10 shrink-0" />
            <span className="w-10 shrink-0" />
            <span className="w-4 shrink-0 text-center">…</span>
            <button
              type="button"
              onClick={() => toggleFold(chunkIndex, row.rowIndex)}
              className="flex-1 px-2 text-left hover:text-blue-300"
            >
              ... {hiddenLineCount} line{hiddenLineCount === 1 ? "" : "s"} folded
            </button>
          </div>
        );
      }

      const preparedChange = row.preparedChange;
      if (!preparedChange || !row.rowKey) {
        return null;
      }

      const change = preparedChange.change;
      const lineContent = preparedChange.content;
      const oldLineComments = getLineComments(row.oldLineNumber, "old");
      const newLineComments = getLineComments(row.newLineNumber, "new");
      const rowComments = commentRowMap.get(row.rowKey) ?? [];
      const isSelected = selectedRowKeys.has(row.rowKey);

      return (
        <div key={row.key}>
          <DiffLine
            rowKey={row.rowKey}
            change={change}
            content={lineContent}
            onStartLineSelection={handleStartLineSelection}
            onExtendLineSelection={handleExtendLineSelection}
            highlighted={oldLineComments.length > 0 || newLineComments.length > 0}
            oldHighlighted={oldLineComments.length > 0}
            newHighlighted={newLineComments.length > 0}
            selected={isSelected}
            oldSelected={isSelected && typeof row.oldLineNumber === "number"}
            newSelected={isSelected && typeof row.newLineNumber === "number"}
            tokens={getTokensForChange(preparedChange)}
            foldable={!!row.foldRange}
            folded={row.isFolded}
            onToggleFold={
              row.foldRange
                ? () => toggleFold(chunkIndex, row.rowIndex)
                : undefined
            }
          />
          {renderCommentBlock(row.rowKey, rowComments)}
        </div>
      );
    });
  }

  function renderSplitRows(rows: SplitRenderedRow[]) {
    return rows.map((row) => {
      const oldLineNumber = row.old
        ? getChangeOldLineNumber(row.old.change) ?? undefined
        : undefined;
      const newLineNumber = row.new
        ? getChangeNewLineNumber(row.new.change) ?? undefined
        : undefined;
      const oldLineComments = getLineComments(oldLineNumber, "old");
      const newLineComments = getLineComments(newLineNumber, "new");
      const rowComments = commentRowMap.get(row.key) ?? [];
      const isSelected = selectedRowKeys.has(row.key);

      return (
        <div key={row.key}>
          <div className="grid min-w-[960px] grid-cols-2 border-b border-gray-800/60">
            {renderSplitCell({
              rowKey: row.key,
              side: "old",
              preparedChange: row.old,
              lineNumber: oldLineNumber,
              highlighted: oldLineComments.length > 0,
              selected: isSelected,
              bordered: true,
            })}
            {renderSplitCell({
              rowKey: row.key,
              side: "new",
              preparedChange: row.new,
              lineNumber: newLineNumber,
              highlighted: newLineComments.length > 0,
              selected: isSelected,
            })}
          </div>
          {renderCommentBlock(row.key, rowComments)}
        </div>
      );
    });
  }

  function shouldPrioritizeBatch(rowKeys: string[], eagerOrder: number): boolean {
    if (eagerOrder < 2) {
      return true;
    }

    return rowKeys.some(
      (rowKey) => selectedRowKeys.has(rowKey) || commentRowMap.has(rowKey)
    );
  }

  const activeCommentRowKey = commentingRange?.endRowKey;
  let splitBatchOrder = 0;
  let unifiedBatchOrder = 0;

  return (
    <div className="overflow-hidden border border-gray-700">
      <div className="overflow-x-auto">
        {viewMode === "split" ? (
          <div className="min-w-[960px]">
            {preparedChunks.length > 0 && (
              <div className="grid grid-cols-2 border-b border-gray-700 bg-gray-900/90 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                <div className="border-r border-gray-800 px-4 py-2">Old</div>
                <div className="px-4 py-2">New</div>
              </div>
            )}
            {splitRenderBatches.map((chunk, chunkIndex) => (
              <div key={chunkIndex}>
                <div className="border-b border-gray-700 bg-gray-800 px-4 py-1 font-mono text-xs text-gray-400">
                  {chunk.content}
                </div>
                {shouldBatchSplitRows
                  ? chunk.batches.map((batch) => {
                      const batchOrder = splitBatchOrder++;
                      return (
                        <DeferredRenderBlock
                          key={`${fileId}:${viewMode}:${batch.key}`}
                          blockId={`${fileId}:${viewMode}:${batch.key}`}
                          estimatedHeight={estimateDeferredBatchHeight(
                            batch.rowCount,
                            batch.rowKeys,
                            commentRowMap,
                            activeCommentRowKey
                          )}
                          eagerOrder={batchOrder}
                          prioritize={shouldPrioritizeBatch(batch.rowKeys, batchOrder)}
                        >
                          {renderSplitRows(batch.rows)}
                        </DeferredRenderBlock>
                      );
                    })
                  : renderSplitRows(chunk.rows)}
              </div>
            ))}
            {preparedChunks.length === 0 && (
              <div className="p-4 text-sm text-gray-500">No diff hunks to display</div>
            )}
          </div>
        ) : (
          <div className="min-w-full">
            {unifiedRenderBatches.map((chunk, chunkIndex) => (
              <div key={chunkIndex}>
                {renderContextGap(chunkIndex)}
                {!(
                  canRenderContextGaps &&
                  (isGapFullyExpanded(chunkIndex) ||
                    isGapFullyExpanded(chunkIndex + 1))
                ) && (
                  <div className="border-b border-gray-700 bg-gray-800 px-4 py-1 font-mono text-xs text-gray-400">
                    {chunk.content}
                  </div>
                )}
                {shouldBatchUnifiedRows
                  ? chunk.batches.map((batch) => {
                      const batchOrder = unifiedBatchOrder++;
                      return (
                        <DeferredRenderBlock
                          key={`${fileId}:${viewMode}:${batch.key}`}
                          blockId={`${fileId}:${viewMode}:${batch.key}`}
                          estimatedHeight={estimateDeferredBatchHeight(
                            batch.rowCount,
                            batch.rowKeys,
                            commentRowMap,
                            activeCommentRowKey
                          )}
                          eagerOrder={batchOrder}
                          prioritize={shouldPrioritizeBatch(batch.rowKeys, batchOrder)}
                        >
                          {renderUnifiedRows(chunkIndex, batch.rows)}
                        </DeferredRenderBlock>
                      );
                    })
                  : renderUnifiedRows(chunkIndex, chunk.rows)}
              </div>
            ))}
            {renderContextGap(preparedChunks.length)}
            {preparedChunks.length === 0 && (
              <div className="p-4 text-sm text-gray-500">No diff hunks to display</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
