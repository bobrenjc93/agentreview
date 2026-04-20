"use client";

import { type PointerEvent } from "react";
import { type ParsedChange } from "@/lib/diff/parser";
import { type ThemedToken } from "@/hooks/useHighlighter";
import { type ReviewCommentSide } from "@/lib/comments/types";

interface DiffLineProps {
  rowKey: string;
  change: ParsedChange;
  content: string;
  onStartLineSelection: (rowKey: string, side: ReviewCommentSide) => void;
  onExtendLineSelection: (rowKey: string) => void;
  highlighted?: boolean;
  oldHighlighted?: boolean;
  newHighlighted?: boolean;
  selected?: boolean;
  oldSelected?: boolean;
  newSelected?: boolean;
  tokens?: ThemedToken[];
  foldable?: boolean;
  folded?: boolean;
  onToggleFold?: () => void;
}

export function DiffLine({
  rowKey,
  change,
  content,
  onStartLineSelection,
  onExtendLineSelection,
  highlighted,
  oldHighlighted = false,
  newHighlighted = false,
  selected = false,
  oldSelected = false,
  newSelected = false,
  tokens,
  foldable = false,
  folded = false,
  onToggleFold,
}: DiffLineProps) {
  const isAdd = change.type === "add";
  const isDel = change.type === "del";
  const isNormal = change.type === "normal";

  const bgClass = isAdd
    ? "bg-green-950/40"
    : isDel
      ? "bg-red-950/40"
      : "";

  const fallbackTextClass = isAdd
    ? "text-green-300"
    : isDel
      ? "text-red-300"
      : "text-gray-300";

  const prefix = isAdd ? "+" : isDel ? "-" : " ";

  const oldNum = isDel || isNormal ? (change as { ln1?: number; ln?: number }).ln1 ?? (change as { ln?: number }).ln : undefined;
  const newNum = isAdd || isNormal ? (change as { ln2?: number; ln?: number }).ln2 ?? (change as { ln?: number }).ln : undefined;

  function renderLineButton(
    side: ReviewCommentSide,
    lineNumber: number | undefined,
    lineHighlighted: boolean,
    lineSelected: boolean
  ) {
    if (typeof lineNumber !== "number") {
      return <span className="w-10 shrink-0 px-1" />;
    }

    function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      onStartLineSelection(rowKey, side);
    }

    return (
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerEnter={() => onExtendLineSelection(rowKey)}
        className={`w-10 text-right px-1 select-none shrink-0 cursor-pointer transition-colors ${
          lineSelected
            ? "bg-blue-500/20 text-blue-200"
            : lineHighlighted
              ? "bg-blue-500/10 text-blue-300"
              : "text-gray-600 hover:text-blue-400 hover:bg-gray-800"
        }`}
        title="Add comment"
      >
        {lineNumber}
      </button>
    );
  }

  return (
    <div
      onPointerEnter={() => onExtendLineSelection(rowKey)}
      className={`flex font-mono text-xs leading-6 ${bgClass} ${
        selected
          ? "ring-1 ring-blue-400 ring-inset"
          : highlighted
            ? "ring-1 ring-blue-500/60 ring-inset"
            : ""
      } group`}
    >
      <button
        type="button"
        onClick={onToggleFold}
        disabled={!foldable}
        className={`w-6 shrink-0 select-none ${
          foldable
            ? "text-gray-500 hover:text-blue-400"
            : "text-gray-800 cursor-default"
        }`}
        aria-label={
          foldable
            ? folded
              ? "Expand folded block"
              : "Fold block"
            : undefined
        }
        title={foldable ? (folded ? "Expand folded block" : "Fold block") : undefined}
      >
        {foldable ? (folded ? "▶" : "▼") : ""}
      </button>
      {renderLineButton("old", oldNum, oldHighlighted, oldSelected)}
      {renderLineButton("new", newNum, newHighlighted, newSelected)}
      <span className={`w-4 text-center shrink-0 ${fallbackTextClass}`}>{prefix}</span>
      <span className="flex-1 whitespace-pre px-2">
        {tokens ? (
          tokens.map((token, i) => (
            <span key={i} style={{ color: token.color }}>{token.content}</span>
          ))
        ) : (
          <span className={fallbackTextClass}>{content}</span>
        )}
      </span>
    </div>
  );
}
