"use client";

import { useState } from "react";
import { type AgentReviewPayload } from "@/lib/payload/types";
import { PayloadContext } from "@/hooks/usePayload";
import { CommentsContext, useCommentsProvider } from "@/hooks/useComments";
import { FileList } from "./FileList";
import { DiffView } from "./DiffView";
import { FullFileView } from "./FullFileView";
import { ExportModal } from "./ExportModal";

interface ReviewLayoutProps {
  payload: AgentReviewPayload;
}

export function ReviewLayout({ payload }: ReviewLayoutProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    payload.files[0]?.path ?? null
  );
  const [showFullFile, setShowFullFile] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const commentsValue = useCommentsProvider();

  const currentFile = payload.files.find((f) => f.path === selectedFile);

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
              <span className="text-xs text-gray-500">
                {commentsValue.comments.length} comment
                {commentsValue.comments.length !== 1 ? "s" : ""}
              </span>
              <button
                onClick={() => setExportOpen(true)}
                disabled={commentsValue.comments.length === 0}
                className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg font-medium transition-colors"
              >
                Export Comments
              </button>
            </div>
          </header>

          {/* Body */}
          <div className="flex flex-1 overflow-hidden">
            {/* Sidebar */}
            <aside className="w-64 border-r border-gray-800 overflow-y-auto bg-gray-900 shrink-0 p-2">
              <FileList
                files={payload.files}
                selectedFile={selectedFile}
                onSelectFile={setSelectedFile}
              />
            </aside>

            {/* Main pane */}
            <main className="flex-1 overflow-y-auto p-4">
              {currentFile ? (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-mono text-gray-300">
                      {currentFile.path}
                    </h2>
                    {currentFile.source && (
                      <button
                        onClick={() => setShowFullFile(!showFullFile)}
                        className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
                      >
                        {showFullFile ? "Show diff" : "Show full file"}
                      </button>
                    )}
                  </div>
                  {showFullFile ? (
                    <FullFileView file={currentFile} />
                  ) : (
                    <DiffView file={currentFile} />
                  )}
                </div>
              ) : (
                <div className="text-gray-500 text-sm">
                  Select a file to view
                </div>
              )}
            </main>
          </div>
        </div>

        <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      </CommentsContext.Provider>
    </PayloadContext.Provider>
  );
}
