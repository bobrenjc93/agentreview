"use client";

import { useHighlighter } from "@/hooks/useHighlighter";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighter = useHighlighter();

  if (!highlighter) {
    return (
      <pre className="bg-gray-900 p-4 rounded overflow-x-auto">
        <code className="text-sm text-gray-300 font-mono">{code}</code>
      </pre>
    );
  }

  const lang = language && highlighter.getLoadedLanguages().includes(language)
    ? language
    : "text";

  const html = highlighter.codeToHtml(code, {
    lang,
    theme: "github-dark",
  });

  return (
    <div
      className="overflow-x-auto rounded [&_pre]:!bg-gray-900 [&_pre]:p-4"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
