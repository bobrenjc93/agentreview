"use client";

import { useEffect, useMemo, useState } from "react";
import { useHighlighter } from "@/hooks/useHighlighter";
import { type BundledLanguage } from "shiki";

interface CodeBlockProps {
  code: string;
  language?: string;
}

type FoldKind = "indent" | "bracket";

interface FoldRange {
  start: number;
  end: number;
  kind: FoldKind;
}

type OpenBracket = "{" | "[" | "(";
type CloseBracket = "}" | "]" | ")";
type QuoteChar = "\"" | "'" | "`";

const CLOSE_TO_OPEN: Record<CloseBracket, OpenBracket> = {
  "}": "{",
  "]": "[",
  ")": "(",
};

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
      ranges.push({ start: i, end, kind: "indent" });
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
          ranges.push({ start: top.line, end: lineIndex, kind: "bracket" });
        }
      }
    }

    escaped = false;
  }

  return ranges;
}

function buildFoldRanges(code: string): FoldRange[] {
  const lines = code.split("\n");
  const candidates = [...buildBracketRanges(lines), ...buildIndentRanges(lines)];
  const byStart = new Map<number, FoldRange>();

  for (const range of candidates) {
    if (range.end <= range.start) continue;
    const existing = byStart.get(range.start);
    if (!existing) {
      byStart.set(range.start, range);
      continue;
    }

    if (range.end > existing.end) {
      byStart.set(range.start, range);
      continue;
    }

    if (range.end === existing.end && range.kind === "bracket" && existing.kind === "indent") {
      byStart.set(range.start, range);
    }
  }

  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighter = useHighlighter();
  const lines = useMemo(() => code.split("\n"), [code]);
  const foldRanges = useMemo(() => buildFoldRanges(code), [code]);
  const foldStarts = useMemo(() => foldRanges.map((range) => range.start), [foldRanges]);
  const foldRangeByStart = useMemo(
    () => new Map(foldRanges.map((range) => [range.start, range])),
    [foldRanges]
  );
  const [collapsedStarts, setCollapsedStarts] = useState<Set<number>>(new Set());

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

  const tokenLines = useMemo(() => {
    if (!language) return null;
    if (!highlighter.getLoadedLanguages().includes(language)) return null;
    return highlighter.codeToTokens(code, {
      lang: language as BundledLanguage,
      theme: "github-dark",
    }).tokens;
  }, [highlighter, code, language]);

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
