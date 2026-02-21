"use client";

import { useState } from "react";
import { usePayload } from "@/hooks/usePayload";
import { useComments } from "@/hooks/useComments";
import { generateExportPrompt } from "@/lib/export/prompt";

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
}

export function ExportModal({ open, onClose }: ExportModalProps) {
  const payload = usePayload();
  const { comments } = useComments();
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const prompt = generateExportPrompt(payload, comments);

  async function handleCopy() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col m-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold">Export Comments</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xl"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 font-mono whitespace-pre-wrap">
            {prompt}
          </pre>
        </div>
        <div className="flex justify-end gap-3 p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Close
          </button>
          <button
            onClick={handleCopy}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
          >
            {copied ? "Copied!" : "Copy to Clipboard"}
          </button>
        </div>
      </div>
    </div>
  );
}
