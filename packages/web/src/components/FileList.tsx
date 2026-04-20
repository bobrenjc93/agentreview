"use client";

import { type AgentReviewFile } from "@/lib/payload/types";
import { useComments } from "@/hooks/useComments";

interface FileListProps {
  files: AgentReviewFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
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

export function FileList({ files, selectedFile, onSelectFile }: FileListProps) {
  const { getCommentsForFile } = useComments();

  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider px-3 py-2">
        Files ({files.length})
      </h2>
      {files.map((file) => {
        const commentCount = getCommentsForFile(file.path).length;
        const isSelected = selectedFile === file.path;
        return (
          <button
            key={file.path}
            onClick={() => onSelectFile(file.path)}
            className={`flex items-center gap-2 px-3 py-1.5 text-left text-sm rounded-md transition-colors ${
              isSelected
                ? "bg-gray-700 text-white"
                : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            <span
              className={`font-mono text-xs font-bold ${STATUS_COLORS[file.status]}`}
            >
              {STATUS_LABELS[file.status]}
            </span>
            <span className="truncate flex-1">{file.path}</span>
            {commentCount > 0 && (
              <span className="text-xs bg-blue-600 text-white rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
                {commentCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
