"use client";

import { useEffect, useMemo, useState } from "react";
import { useHighlighter } from "@/hooks/useHighlighter";
import { buildFoldRanges } from "@/lib/folding";
import { highlightCodeLines } from "@/lib/highlighting";
import { useTheme } from "./ThemeProvider";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighter = useHighlighter();
  const { theme } = useTheme();
  const lines = useMemo(() => code.split("\n"), [code]);
  const foldRanges = useMemo(() => buildFoldRanges(lines, language), [lines, language]);
  const foldStarts = useMemo(() => foldRanges.map((range) => range.start), [foldRanges]);
  const foldRangeByStart = useMemo(
    () => new Map(foldRanges.map((range) => [range.start, range])),
    [foldRanges]
  );
  const [collapsedStarts, setCollapsedStarts] = useState<Set<number>>(new Set());
  const shikiTheme = theme === "light" ? "github-light" : "github-dark";

  const tokenLines = useMemo(() => {
    return highlightCodeLines(highlighter, code, language, shikiTheme);
  }, [highlighter, code, language, shikiTheme]);

  useEffect(() => {
    setCollapsedStarts(new Set());
  }, [code]);

  if (!highlighter) {
    return (
      <div className="bg-gray-900 p-4 overflow-x-auto">
        <pre className="text-sm text-gray-300 font-mono whitespace-pre">{code}</pre>
      </div>
    );
  }

  const hasFoldRanges = foldRanges.length > 0;
  const allCollapsed = hasFoldRanges && collapsedStarts.size >= foldRanges.length;
  const anyCollapsed = collapsedStarts.size > 0;

  function toggleFold(start: number) {
    setCollapsedStarts((prev) => {
      const next = new Set(prev);
      if (next.has(start)) {
        next.delete(start);
      } else {
        next.add(start);
      }
      return next;
    });
  }

  function collapseAll() {
    setCollapsedStarts(new Set(foldStarts));
  }

  function expandAll() {
    setCollapsedStarts(new Set());
  }

  const renderedRows: JSX.Element[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rowIndex = lineIndex;
    const range = foldRangeByStart.get(rowIndex);
    const isCollapsed = !!range && collapsedStarts.has(rowIndex);
    const tokens = tokenLines?.[rowIndex];
    const line = lines[rowIndex];

    renderedRows.push(
      <div key={`line-${rowIndex}`} className="flex font-mono text-xs leading-6">
        <button
          type="button"
          onClick={() => range && toggleFold(rowIndex)}
          className={`w-6 shrink-0 select-none ${
            range ? "text-gray-500 hover:text-blue-400" : "text-gray-800 cursor-default"
          }`}
          title={
            range
              ? isCollapsed
                ? `Expand folded block at line ${rowIndex + 1}`
                : `Fold block starting at line ${rowIndex + 1}`
              : undefined
          }
          aria-label={
            range
              ? isCollapsed
                ? `Expand folded block at line ${rowIndex + 1}`
                : `Fold block starting at line ${rowIndex + 1}`
              : undefined
          }
        >
          {range ? (isCollapsed ? "▶" : "▼") : ""}
        </button>
        <span className="w-12 shrink-0 pr-2 text-right text-gray-600 select-none border-r border-gray-800">
          {rowIndex + 1}
        </span>
        <code className="flex-1 pl-3 pr-4 text-gray-300 whitespace-pre">
          {tokens
            ? tokens.map((token, tokenIndex) => (
                <span
                  key={`${rowIndex}-${tokenIndex}`}
                  style={token.color ? { color: token.color } : undefined}
                >
                  {token.content}
                </span>
              ))
            : line.length > 0
              ? line
              : "\u00A0"}
        </code>
      </div>
    );

    if (range && isCollapsed) {
      const foldedLineCount = range.end - rowIndex;
      renderedRows.push(
        <div
          key={`fold-${rowIndex}`}
          className="flex items-center font-mono text-xs leading-6 bg-gray-950/40 text-gray-400"
        >
          <span className="w-6 shrink-0" />
          <span className="w-12 shrink-0 pr-2 text-right text-gray-600 border-r border-gray-800">
            ...
          </span>
          <button
            type="button"
            onClick={() => toggleFold(rowIndex)}
            className="pl-3 pr-4 text-left hover:text-blue-300"
          >
            ... {foldedLineCount} line{foldedLineCount === 1 ? "" : "s"} folded
          </button>
        </div>
      );
      lineIndex = range.end;
    }
  }

  return (
    <div className="overflow-auto bg-gray-900">
      {hasFoldRanges && (
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900">
          <button
            type="button"
            onClick={collapseAll}
            disabled={allCollapsed}
            className="px-2.5 py-1 text-xs border border-gray-700 rounded text-gray-300 hover:text-white hover:border-gray-500 disabled:text-gray-600 disabled:border-gray-800 transition-colors"
          >
            Collapse all
          </button>
          <button
            type="button"
            onClick={expandAll}
            disabled={!anyCollapsed}
            className="px-2.5 py-1 text-xs border border-gray-700 rounded text-gray-300 hover:text-white hover:border-gray-500 disabled:text-gray-600 disabled:border-gray-800 transition-colors"
          >
            Expand all
          </button>
        </div>
      )}
      <div className="min-w-max py-1">{renderedRows}</div>
    </div>
  );
}
