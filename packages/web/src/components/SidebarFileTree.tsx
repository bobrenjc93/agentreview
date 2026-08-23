"use client";

import { useEffect, useMemo, useState } from "react";
import { type AgentReviewFile } from "@/lib/payload/types";

interface SidebarFileTreeProps {
  files: AgentReviewFile[];
  selectedFileId: string | null;
  getFileId: (file: AgentReviewFile) => string;
  getCommentCount: (fileId: string) => number;
  getFileNavId: (fileId: string) => string;
  onSelectFile: (fileId: string) => void;
}

interface RawDirectoryNode {
  name: string;
  path: string;
  directories: Map<string, RawDirectoryNode>;
  files: Array<{ name: string; file: AgentReviewFile }>;
}

interface DirectoryNode {
  label: string;
  path: string;
  directories: DirectoryNode[];
  files: Array<{ name: string; file: AgentReviewFile }>;
}

const STATUS_STYLES: Record<AgentReviewFile["status"], string> = {
  added: "bg-green-500/15 text-green-300",
  modified: "bg-amber-500/15 text-amber-300",
  deleted: "bg-red-500/15 text-red-300",
  renamed: "bg-blue-500/15 text-blue-300",
};

const STATUS_LABELS: Record<AgentReviewFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

function createRawDirectory(name: string, path: string): RawDirectoryNode {
  return {
    name,
    path,
    directories: new Map(),
    files: [],
  };
}

function compactDirectory(node: RawDirectoryNode): DirectoryNode {
  let current = node;
  let label = node.name;

  while (current.files.length === 0 && current.directories.size === 1) {
    const child = Array.from(current.directories.values())[0];
    label = `${label}/${child.name}`;
    current = child;
  }

  return {
    label,
    path: current.path,
    directories: Array.from(current.directories.values())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(compactDirectory),
    files: [...current.files].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

function buildFileTree(files: AgentReviewFile[]): DirectoryNode {
  const root = createRawDirectory("", "");

  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    const fileName = parts.pop() || file.path;
    let directory = root;
    let directoryPath = "";

    parts.forEach((part) => {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = createRawDirectory(part, directoryPath);
        directory.directories.set(part, child);
      }
      directory = child;
    });

    directory.files.push({ name: fileName, file });
  });

  return {
    label: "",
    path: "",
    directories: Array.from(root.directories.values())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(compactDirectory),
    files: [...root.files].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4 shrink-0 text-slate-400"
    >
      <path
        d="M2.5 5.25A1.75 1.75 0 0 1 4.25 3.5h3.1l1.6 1.75h6.8a1.75 1.75 0 0 1 1.75 1.75v7.25A1.75 1.75 0 0 1 15.75 16H4.25a1.75 1.75 0 0 1-1.75-1.75v-9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DirectoryBranch({
  directory,
  collapsedFolders,
  onToggleFolder,
  ...fileProps
}: {
  directory: DirectoryNode;
  collapsedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
} & SidebarFileTreeProps) {
  const isCollapsed = collapsedFolders.has(directory.path);

  return (
    <div role="treeitem" aria-expanded={!isCollapsed}>
      <button
        type="button"
        onClick={() => onToggleFolder(directory.path)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm text-gray-300 transition-colors hover:bg-gray-900 hover:text-white"
        title={directory.path}
      >
        <span
          aria-hidden="true"
          className={`w-3 shrink-0 text-[10px] text-gray-500 transition-transform ${
            isCollapsed ? "" : "rotate-90"
          }`}
        >
          ▶
        </span>
        <FolderIcon />
        <span className="min-w-0 truncate font-mono">{directory.label}</span>
      </button>

      {!isCollapsed && (
        <div role="group" className="ml-[13px] border-l border-gray-800 pl-1.5">
          {directory.directories.map((child) => (
            <DirectoryBranch
              key={child.path}
              directory={child}
              collapsedFolders={collapsedFolders}
              onToggleFolder={onToggleFolder}
              {...fileProps}
            />
          ))}
          {directory.files.map(({ name, file }) => (
            <FileRow key={fileProps.getFileId(file)} name={name} file={file} {...fileProps} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({
  name,
  file,
  selectedFileId,
  getFileId,
  getCommentCount,
  getFileNavId,
  onSelectFile,
}: { name: string; file: AgentReviewFile } & SidebarFileTreeProps) {
  const fileId = getFileId(file);
  const commentCount = getCommentCount(fileId);
  const isSelected = selectedFileId === fileId;

  return (
    <button
      id={getFileNavId(fileId)}
      type="button"
      role="treeitem"
      aria-selected={isSelected}
      onClick={() => onSelectFile(fileId)}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors ${
        isSelected
          ? "bg-gray-800 text-white"
          : "text-gray-300 hover:bg-gray-900 hover:text-white"
      }`}
      title={file.path}
    >
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold ${STATUS_STYLES[file.status]}`}
      >
        {STATUS_LABELS[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
      {commentCount > 0 && (
        <span className="min-w-[1.25rem] rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-xs text-white">
          {commentCount}
        </span>
      )}
    </button>
  );
}

export function SidebarFileTree(props: SidebarFileTreeProps) {
  const tree = useMemo(() => buildFileTree(props.files), [props.files]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const selectedFile = props.files.find(
    (file) => props.getFileId(file) === props.selectedFileId
  );
  const selectedFilePath = selectedFile?.path;

  useEffect(() => {
    if (!selectedFilePath) return;

    setCollapsedFolders((current) => {
      const next = new Set(current);
      let changed = false;

      current.forEach((folderPath) => {
        if (selectedFilePath.startsWith(`${folderPath}/`)) {
          next.delete(folderPath);
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [selectedFilePath]);

  const toggleFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div role="tree" aria-label="Changed files" className="flex flex-col gap-0.5">
      {tree.directories.map((directory) => (
        <DirectoryBranch
          key={directory.path}
          directory={directory}
          collapsedFolders={collapsedFolders}
          onToggleFolder={toggleFolder}
          {...props}
        />
      ))}
      {tree.files.map(({ name, file }) => (
        <FileRow key={props.getFileId(file)} name={name} file={file} {...props} />
      ))}
    </div>
  );
}
