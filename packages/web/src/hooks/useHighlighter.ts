"use client";

import { useEffect, useState } from "react";
import { type Highlighter, type ThemedToken, createHighlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [
        "typescript",
        "tsx",
        "javascript",
        "jsx",
        "python",
        "go",
        "rust",
        "java",
        "kotlin",
        "swift",
        "ruby",
        "csharp",
        "css",
        "scss",
        "html",
        "json",
        "yaml",
        "markdown",
        "bash",
        "sql",
        "toml",
        "xml",
        "vue",
        "svelte",
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
