"use client";

import { useState, useCallback } from "react";
import { type AgentReviewPayload } from "@/lib/payload/types";
import { PayloadContext } from "@/hooks/usePayload";
import { CommentsContext, useCommentsProvider } from "@/hooks/useComments";
import { DiffView } from "./DiffView";
import { FullFileView } from "./FullFileView";
import { ExportModal } from "./ExportModal";
import { ExportDiffModal } from "./ExportDiffModal";
import { type AgentReviewFile } from "@/lib/payload/types";

interface ReviewLayoutProps {
  payload: AgentReviewPayload;
  sessionId: string;
}

const STATUS_COLORS: Record<AgentReviewFile["status"], string> = {
  added: "text-green-400",
  modified: "text-yellow-400",
  deleted: "text-red-400",
  renamed: "text-blue-400",
};

const STATUS_LABELS: Record<AgentReviewFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export function ReviewLayout({ payload, sessionId }: ReviewLayoutProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(payload.files.map((f) => f.path))
  );
  const [fullFileMode, setFullFileMode] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDiffOpen, setExportDiffOpen] = useState(false);
  const commentsValue = useCommentsProvider(sessionId);

  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedFiles(new Set(payload.files.map((f) => f.path)));
  }, [payload.files]);

  const collapseAll = useCallback(() => {
    setExpandedFiles(new Set());
  }, []);

  const toggleFullFile = useCallback((path: string) => {
    setFullFileMode((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const allExpanded = expandedFiles.size === payload.files.length;

  return (
    <PayloadContext.Provider value={payload}>
      <CommentsContext.Provider value={commentsValue}>
        <div className="flex flex-col h-screen">
          {/* Header */}
          <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900 shrink-0">
            <div className="flex items-center gap-4">
              <a href="/" className="text-lg font-bold hover:text-blue-400 transition-colors">
                AgentReview
              </a>
              <span className="text-sm text-gray-400">
                {payload.meta.repo} / {payload.meta.branch}
              </span>
              <span className="text-xs text-gray-600 font-mono">
                {payload.meta.commitHash}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={allExpanded ? collapseAll : expandAll}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
              <span className="text-xs text-gray-500">
                {commentsValue.comments.length} comment
                {commentsValue.comments.length !== 1 ? "s" : ""}
              </span>
              <button
                onClick={() => setExportDiffOpen(true)}
                className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors"
              >
                Export Diff
              </button>
              <button
                onClick={() => setExportOpen(true)}
                disabled={commentsValue.comments.length === 0}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg font-medium transition-colors"
              >
                Export Comments
              </button>
            </div>
          </header>

          {/* File cards */}
          <main className="flex-1 overflow-y-auto">
            <div className="max-w-5xl mx-auto py-4 px-4 flex flex-col gap-3">
              {payload.files.map((file) => {
                const isExpanded = expandedFiles.has(file.path);
                const isFullFile = fullFileMode.has(file.path);
                const commentCount = commentsValue.getCommentsForFile(file.path).length;

                return (
                  <div
                    key={file.path}
                    className="border border-gray-700 rounded-lg overflow-hidden bg-gray-900"
                  >
                    {/* File header — always visible */}
                    <button
                      onClick={() => toggleFile(file.path)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/50 transition-colors"
                    >
                      <span className={`transition-transform text-gray-500 text-xs ${isExpanded ? "rotate-90" : ""}`}>
                        ▶
                      </span>
                      <span className={`font-mono text-xs font-bold ${STATUS_COLORS[file.status]}`}>
                        {STATUS_LABELS[file.status]}
                      </span>
                      <span className="text-sm font-mono text-gray-200 truncate flex-1">
                        {file.path}
                      </span>
                      {commentCount > 0 && (
                        <span className="text-xs bg-blue-600 text-white rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
                          {commentCount}
                        </span>
                      )}
                    </button>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="border-t border-gray-700">
                        {file.source && (
                          <div className="flex justify-end px-4 py-1 bg-gray-850">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFullFile(file.path);
                              }}
                              className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                            >
                              {isFullFile ? "Show diff" : "Show full file"}
                            </button>
                          </div>
                        )}
                        {isFullFile ? (
                          <FullFileView file={file} />
                        ) : (
                          <DiffView file={file} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </main>
        </div>

        <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
        <ExportDiffModal open={exportDiffOpen} onClose={() => setExportDiffOpen(false)} />
      </CommentsContext.Provider>
    </PayloadContext.Provider>
  );
}
