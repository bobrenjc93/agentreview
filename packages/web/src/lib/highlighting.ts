import {
  type BundledLanguage,
  type GrammarState,
  type Highlighter,
  type ThemedToken,
} from "shiki";
import { type CSSProperties } from "react";

const HIGHLIGHT_CHUNK_LINE_COUNT = 500;
const TOKENIZE_MAX_LINE_LENGTH = 20_000;
const SHIKI_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

export type HighlightedTokenLine = ThemedToken[] | undefined;

export function canHighlightLanguage(
  highlighter: Highlighter | null,
  language: string | undefined
): language is BundledLanguage {
  return !!(
    highlighter &&
    language &&
    highlighter.getLoadedLanguages().includes(language as BundledLanguage)
  );
}

function appendMissingLines(
  tokenLines: HighlightedTokenLine[],
  targetLength: number
) {
  while (tokenLines.length < targetLength) {
    tokenLines.push(undefined);
  }
}

function tokenizeRange(
  highlighter: Highlighter,
  lines: string[],
  start: number,
  end: number,
  language: BundledLanguage,
  grammarState: GrammarState | undefined,
  tokenLines: HighlightedTokenLine[]
): GrammarState | undefined {
  const expectedLength = tokenLines.length + end - start;

  try {
    const result = highlighter.codeToTokens(lines.slice(start, end).join("\n"), {
      lang: language,
      themes: SHIKI_THEMES,
      defaultColor: false,
      grammarState,
      tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
    });

    tokenLines.push(...result.tokens.slice(0, end - start));
    appendMissingLines(tokenLines, expectedLength);
    return result.grammarState;
  } catch {
    if (end - start <= 1) {
      tokenLines.push(undefined);
      return grammarState;
    }

    const middle = start + Math.floor((end - start) / 2);
    const nextGrammarState = tokenizeRange(
      highlighter,
      lines,
      start,
      middle,
      language,
      grammarState,
      tokenLines
    );
    return tokenizeRange(
      highlighter,
      lines,
      middle,
      end,
      language,
      nextGrammarState,
      tokenLines
    );
  }
}

export function highlightCodeLines(
  highlighter: Highlighter | null,
  code: string,
  language: string | undefined
): HighlightedTokenLine[] | null {
  if (!highlighter || !canHighlightLanguage(highlighter, language)) {
    return null;
  }

  const lines = code.split("\n");
  const tokenLines: HighlightedTokenLine[] = [];
  let grammarState: GrammarState | undefined;

  for (let start = 0; start < lines.length; start += HIGHLIGHT_CHUNK_LINE_COUNT) {
    grammarState = tokenizeRange(
      highlighter,
      lines,
      start,
      Math.min(start + HIGHLIGHT_CHUNK_LINE_COUNT, lines.length),
      language,
      grammarState,
      tokenLines
    );
  }

  return tokenLines;
}

export function getTokenStyle(token: ThemedToken): CSSProperties | undefined {
  if (token.htmlStyle && typeof token.htmlStyle === "object") {
    return token.htmlStyle as CSSProperties;
  }

  return token.color ? { color: token.color } : undefined;
}
