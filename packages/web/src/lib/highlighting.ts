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
    const chunkLines = lines.slice(start, start + HIGHLIGHT_CHUNK_LINE_COUNT);
    const expectedLength = tokenLines.length + chunkLines.length;

    try {
      const result = highlighter.codeToTokens(chunkLines.join("\n"), {
        lang: language,
        themes: SHIKI_THEMES,
        defaultColor: false,
        grammarState,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
      });

      tokenLines.push(...result.tokens.slice(0, chunkLines.length));
      appendMissingLines(tokenLines, expectedLength);
      grammarState = result.grammarState;
    } catch {
      appendMissingLines(tokenLines, expectedLength);
      grammarState = undefined;
    }
  }

  return tokenLines;
}

export function getTokenStyle(token: ThemedToken): CSSProperties | undefined {
  if (token.htmlStyle && typeof token.htmlStyle === "object") {
    return token.htmlStyle as CSSProperties;
  }

  return token.color ? { color: token.color } : undefined;
}
