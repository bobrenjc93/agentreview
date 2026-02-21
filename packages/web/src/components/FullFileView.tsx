"use client";

import { CodeBlock } from "./CodeBlock";
import { type AgentReviewFile } from "@/lib/payload/types";

interface FullFileViewProps {
  file: AgentReviewFile;
}

export function FullFileView({ file }: FullFileViewProps) {
  if (!file.source) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        Full source not available for this file.
      </div>
    );
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <CodeBlock code={file.source} language={file.language} />
    </div>
  );
}
