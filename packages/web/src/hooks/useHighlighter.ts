"use client";

import { useEffect, useState } from "react";
import { type Highlighter, type ThemedToken, createHighlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [
        "typescript",
        "tsx",
        "javascript",
        "jsx",
        "python",
        "go",
        "rust",
        "java",
        "ruby",
        "css",
        "html",
        "json",
        "yaml",
        "markdown",
        "bash",
        "sql",
        "c",
        "cpp",
      ],
    });
  }
  return highlighterPromise;
}

export type { ThemedToken };

export function useHighlighter() {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    getHighlighter().then(setHighlighter);
  }, []);

  return highlighter;
}
