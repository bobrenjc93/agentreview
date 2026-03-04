"use client";

import { type ParsedChange } from "@/lib/diff/parser";
import { type ThemedToken } from "@/hooks/useHighlighter";

interface DiffLineProps {
  change: ParsedChange;
  content: string;
  onClickLineNumber: (lineNumber: number, content: string) => void;
  highlighted?: boolean;
  tokens?: ThemedToken[];
}

export function DiffLine({ change, content, onClickLineNumber, highlighted, tokens }: DiffLineProps) {
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

  const clickableLineNum = newNum ?? oldNum ?? 0;

  return (
    <div
      className={`flex font-mono text-xs leading-6 ${bgClass} ${highlighted ? "ring-1 ring-blue-500 ring-inset" : ""} group`}
    >
      <button
        onClick={() => onClickLineNumber(clickableLineNum, content)}
        className="w-10 text-right text-gray-600 hover:text-blue-400 hover:bg-gray-800 px-1 select-none shrink-0 cursor-pointer"
        title="Add comment"
      >
        {oldNum ?? ""}
      </button>
      <button
        onClick={() => onClickLineNumber(clickableLineNum, content)}
        className="w-10 text-right text-gray-600 hover:text-blue-400 hover:bg-gray-800 px-1 select-none shrink-0 cursor-pointer"
        title="Add comment"
      >
        {newNum ?? ""}
      </button>
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
