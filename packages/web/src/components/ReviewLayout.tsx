"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useTransition,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  getPayloadSegments,
  getSegmentFileId,
  type AgentReviewFile,
  type AgentReviewPayload,
  type AgentReviewSegment,
} from "@/lib/payload/types";
import { PayloadContext } from "@/hooks/usePayload";
import { CommentsContext, useCommentsProvider } from "@/hooks/useComments";
import { type ReviewComment, isSegmentComment } from "@/lib/comments/types";
import { copyTextToClipboard } from "@/lib/clipboard";
import { generateExportPrompt } from "@/lib/export/prompt";
import { generateExportDiff } from "@/lib/export/diff";
import {
  loadCollapsedReviewFilePaths,
  saveCollapsedReviewFilePaths,
} from "@/lib/storage/reviews";
import { DiffView } from "./DiffView";
import { InlineComment } from "./InlineComment";
import { InlineCommentForm } from "./InlineCommentForm";

interface ReviewLayoutProps {
  payload: AgentReviewPayload;
  sessionId: string;
  loadFileDetails?: (
    segmentId: string,
    filePath: string
  ) => Promise<{ source?: string; oldSource?: string }>;
  onRefresh?: () => Promise<void>;
  isRefreshing?: boolean;
  refreshError?: string | null;
}

interface SegmentContextMenuState {
  segmentId: string;
  clientX: number;
  clientY: number;
}

type DiffViewMode = "unified" | "split";

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

const HOTKEYS: Array<{ key: string; description: string }> = [
  { key: "?", description: "Show or hide this hotkeys panel" },
  { key: "E", description: "Expand or collapse files in the current segment" },
  { key: "D", description: "Copy export diff to the clipboard" },
  { key: "C", description: "Copy export comments to the clipboard (when comments exist)" },
  { key: "A", description: "Go to home and paste a new payload" },
  { key: "Esc", description: "Close any open panel or menu" },
];

const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 260;
const BASE_MAX_SIDEBAR_WIDTH = 520;
const MIN_MAIN_PANE_WIDTH = 320;
const EXPANDED_SIDEBAR_WIDTH_RATIO = 0.5;
const DEFAULT_SEGMENTS_PANE_HEIGHT = 320;
const MIN_SEGMENTS_PANE_HEIGHT = 180;
const MIN_FILES_PANE_HEIGHT = 180;
const SIDEBAR_SECTION_SPLITTER_HEIGHT = 12;
const SIDEBAR_WIDTH_STORAGE_KEY = "agentreview:sidebarWidth";
const SIDEBAR_SEGMENTS_HEIGHT_STORAGE_KEY = "agentreview:sidebarSegmentsHeight";
const DIFF_VIEW_MODE_STORAGE_KEY = "agentreview:diffViewMode";
const EXPORT_COPY_RESET_MS = 1500;
const ALL_COMMENTS_EXPORT_ID = "export-comments";
const FULL_DIFF_EXPORT_ID = "export-diff";
const DEFERRED_DIFF_ROOT_MARGIN = "900px 0px";
const DEFERRED_DIFF_STAGGER_MS = 80;
const DEFERRED_DIFF_MAX_DELAY_MS = 2400;
const BACKGROUND_FILE_DETAIL_CONCURRENCY = 4;
const APP_TITLE = "AgentReview";

interface QueuedFileDetail {
  segmentId: string;
  file: AgentReviewFile;
}

function getReviewDocumentTitle(payload: AgentReviewPayload): string {
  const repo = payload.meta.repo.trim();
  const branch = payload.meta.branch.trim();

  if (repo && branch) {
    return `${repo} / ${branch}`;
  }

  return repo || branch || APP_TITLE;
}

function getAllFileIds(segments: AgentReviewSegment[]): string[] {
  return segments.flatMap((segment) =>
    segment.files.map((file) => getSegmentFileId(segment.id, file.path))
  );
}

function buildExpandedFileIds(
  segments: AgentReviewSegment[],
  collapsedFilePaths: Set<string>
): Set<string> {
  const expandedFiles = new Set<string>();

  segments.forEach((segment) => {
    segment.files.forEach((file) => {
      if (!collapsedFilePaths.has(file.path)) {
        expandedFiles.add(getSegmentFileId(segment.id, file.path));
      }
    });
  });

  return expandedFiles;
}

function buildFileIdsByPath(
  segments: AgentReviewSegment[]
): Map<string, string[]> {
  const fileIdsByPath = new Map<string, string[]>();

  segments.forEach((segment) => {
    segment.files.forEach((file) => {
      const ids = fileIdsByPath.get(file.path) ?? [];
      ids.push(getSegmentFileId(segment.id, file.path));
      fileIdsByPath.set(file.path, ids);
    });
  });

  return fileIdsByPath;
}

function orderSegmentsForUi(segments: AgentReviewSegment[]): AgentReviewSegment[] {
  const uncommitted = segments.filter((segment) => segment.kind === "uncommitted");
  const commits = segments.filter((segment) => segment.kind === "commit").reverse();
  const remainder = segments.filter(
    (segment) => segment.kind !== "uncommitted" && segment.kind !== "commit"
  );
  return [...uncommitted, ...commits, ...remainder];
}

function getDefaultSelectedSegmentId(
  segments: AgentReviewSegment[]
): string | null {
  const oldestCommit = [...segments]
    .reverse()
    .find((segment) => segment.kind === "commit");
  return oldestCommit?.id ?? segments[0]?.id ?? null;
}

function getCommitSubject(message: string | undefined): string | null {
  if (!message) return null;
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function getSegmentNavTitle(segment: AgentReviewSegment): string {
  if (segment.kind === "commit") {
    return segment.commitHash || segment.label;
  }
  return segment.label;
}

function getSegmentNavSubtitle(segment: AgentReviewSegment): string {
  if (segment.kind === "commit") {
    return getCommitSubject(segment.commitMessage) || "Commit";
  }
  if (segment.kind === "uncommitted") {
    return "Working tree + untracked files";
  }
  return `${segment.files.length} file${segment.files.length === 1 ? "" : "s"}`;
}

function getSegmentPanelTitle(segment: AgentReviewSegment): string {
  if (segment.kind === "commit") {
    return segment.commitHash ? `Commit ${segment.commitHash}` : segment.label;
  }
  return segment.label;
}

function getSegmentPanelSubtitle(segment: AgentReviewSegment): string {
  if (segment.kind === "commit") {
    return getCommitSubject(segment.commitMessage) || "Commit";
  }
  if (segment.kind === "uncommitted") {
    return "Working tree changes and untracked files";
  }
  return segment.label;
}

function getFileAnchorId(fileId: string): string {
  return `file-${encodeURIComponent(fileId)}`;
}

function getSegmentCommentActionLabel(segment: AgentReviewSegment): string {
  return segment.kind === "commit" ? "Add commit comment" : "Add segment comment";
}

function getSegmentCommentSectionLabel(segment: AgentReviewSegment): string {
  return segment.kind === "commit" ? "Commit comments" : "Segment comments";
}

function clampSidebarWidth(width: number): number {
  if (typeof window === "undefined") {
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, BASE_MAX_SIDEBAR_WIDTH));
  }

  const proportionalMax = Math.floor(
    window.innerWidth * EXPANDED_SIDEBAR_WIDTH_RATIO
  );
  const dynamicMax = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_PANE_WIDTH),
      Math.max(BASE_MAX_SIDEBAR_WIDTH, proportionalMax)
    )
  );
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, dynamicMax));
}

function isDiffViewMode(value: string | null): value is DiffViewMode {
  return value === "unified" || value === "split";
}

function mergeFileDetails(
  file: AgentReviewFile,
  details: { source?: string; oldSource?: string } | undefined
): AgentReviewFile {
  if (!details) {
    return file;
  }

  return {
    ...file,
    ...(details.source !== undefined ? { source: details.source } : {}),
    ...(details.oldSource !== undefined ? { oldSource: details.oldSource } : {}),
  };
}

function requiresFileDetails(file: AgentReviewFile): boolean {
  const needsNewSource = file.status !== "deleted" && file.source == null;
  const needsOldSource = file.status !== "added" && file.oldSource == null;
  return needsNewSource || needsOldSource;
}

function buildFileDetailPrefetchQueue(
  segments: AgentReviewSegment[],
  selectedSegmentId: string | null,
  selectedFileId: string | null
): QueuedFileDetail[] {
  const queue: QueuedFileDetail[] = [];
  const seen = new Set<string>();
  const selectedSegment =
    segments.find((segment) => segment.id === selectedSegmentId) ?? segments[0] ?? null;

  function enqueue(segment: AgentReviewSegment, file: AgentReviewFile) {
    const fileId = getSegmentFileId(segment.id, file.path);
    if (seen.has(fileId)) {
      return;
    }
    seen.add(fileId);
    queue.push({
      segmentId: segment.id,
      file,
    });
  }

  if (selectedSegment) {
    if (selectedFileId) {
      const selectedFile = selectedSegment.files.find(
        (file) => getSegmentFileId(selectedSegment.id, file.path) === selectedFileId
      );
      if (selectedFile) {
        enqueue(selectedSegment, selectedFile);
      }
    }

    selectedSegment.files.forEach((file) => enqueue(selectedSegment, file));
  }

  segments.forEach((segment) => {
    if (segment.id === selectedSegment?.id) {
      return;
    }
    segment.files.forEach((file) => enqueue(segment, file));
  });

  return queue;
}

interface DeferredDiffProps {
  children: ReactNode;
  fileId: string;
  prioritize?: boolean;
  eagerOrder?: number;
}

function DeferredDiff({
  children,
  fileId,
  prioritize = false,
  eagerOrder = 0,
}: DeferredDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldRender, setShouldRender] = useState(prioritize);

  useEffect(() => {
    if (prioritize) {
      setShouldRender(true);
      return;
    }

    if (shouldRender) {
      return;
    }

    const element = containerRef.current;
    if (!element) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }

    const eagerDelayMs = Math.min(
      Math.max(0, eagerOrder) * DEFERRED_DIFF_STAGGER_MS,
      DEFERRED_DIFF_MAX_DELAY_MS
    );
    const eagerTimer = window.setTimeout(() => {
      setShouldRender(true);
    }, eagerDelayMs);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      { rootMargin: DEFERRED_DIFF_ROOT_MARGIN }
    );

    observer.observe(element);
    return () => {
      window.clearTimeout(eagerTimer);
      observer.disconnect();
    };
  }, [eagerOrder, fileId, prioritize, shouldRender]);

  return (
    <div ref={containerRef}>
      {shouldRender ? (
        children
      ) : (
        <div className="border-t border-gray-800 bg-gray-950/60 px-4 py-5 text-sm text-gray-400">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan-400/70" />
            <span>Loading diff…</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReviewLayout({
  payload,
  sessionId,
  loadFileDetails,
  onRefresh,
  isRefreshing = false,
  refreshError = null,
}: ReviewLayoutProps) {
  const router = useRouter();
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarSectionResizeRef = useRef<{ startY: number; startHeight: number } | null>(
    null
  );
  const [lazyFileDetailsById, setLazyFileDetailsById] = useState<
    Record<string, { source?: string; oldSource?: string }>
  >({});
  const [fileDetailStatusById, setFileDetailStatusById] = useState<
    Record<string, "loading" | "loaded">
  >({});
  const lazyFileDetailsRef = useRef<Record<string, { source?: string; oldSource?: string }>>(
    {}
  );
  const fileDetailPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const baseSegments = useMemo(
    () => orderSegmentsForUi(getPayloadSegments(payload)),
    [payload]
  );
  const segments = useMemo(
    () =>
      baseSegments.map((segment) => ({
        ...segment,
        files: segment.files.map((file) =>
          mergeFileDetails(
            file,
            lazyFileDetailsById[getSegmentFileId(segment.id, file.path)]
          )
        ),
      })),
    [baseSegments, lazyFileDetailsById]
  );
  const fileIdsByPath = useMemo(() => buildFileIdsByPath(baseSegments), [baseSegments]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    () => getDefaultSelectedSegmentId(segments)
  );
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [segmentsPaneHeight, setSegmentsPaneHeight] = useState(
    DEFAULT_SEGMENTS_PANE_HEIGHT
  );
  const [isResizingSidebarSections, setIsResizingSidebarSections] = useState(false);
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified");
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(getAllFileIds(segments))
  );
  const expandedFilesRef = useRef(expandedFiles);
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const [copiedExportIds, setCopiedExportIds] = useState<Set<string>>(() => new Set());
  const [openCopyMenuId, setOpenCopyMenuId] = useState<string | null>(null);
  const [segmentContextMenu, setSegmentContextMenu] =
    useState<SegmentContextMenuState | null>(null);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [addingSegmentCommentId, setAddingSegmentCommentId] = useState<string | null>(null);
  const [pendingSegmentId, setPendingSegmentId] = useState<string | null>(null);
  const [isSwitchingSegment, startSegmentTransition] = useTransition();
  const commentsValue = useCommentsProvider(sessionId);
  const commentsCount = commentsValue.comments.length;
  const exportCopyResetTimersRef = useRef<Map<string, number>>(new Map());
  const allCommentsExportText = useMemo(
    () => generateExportPrompt(payload, commentsValue.comments),
    [commentsValue.comments, payload]
  );
  const fullDiffExportText = useMemo(() => generateExportDiff(payload), [payload]);

  useEffect(() => {
    document.title = getReviewDocumentTitle(payload);
  }, [payload]);

  useEffect(() => {
    return () => {
      document.title = APP_TITLE;
    };
  }, []);

  const clampSegmentsPaneHeight = useCallback((height: number) => {
    const sidebarHeight = sidebarRef.current?.clientHeight;
    if (!sidebarHeight || !Number.isFinite(sidebarHeight)) {
      return Math.max(MIN_SEGMENTS_PANE_HEIGHT, height);
    }

    const maxHeight = Math.max(
      MIN_SEGMENTS_PANE_HEIGHT,
      sidebarHeight - MIN_FILES_PANE_HEIGHT - SIDEBAR_SECTION_SPLITTER_HEIGHT
    );
    return Math.max(MIN_SEGMENTS_PANE_HEIGHT, Math.min(height, maxHeight));
  }, []);

  useEffect(() => {
    if (selectedSegmentId && segments.some((segment) => segment.id === selectedSegmentId)) {
      return;
    }
    setSelectedSegmentId(getDefaultSelectedSegmentId(segments));
  }, [segments, selectedSegmentId]);

  useEffect(() => {
    lazyFileDetailsRef.current = {};
    setLazyFileDetailsById({});
    setFileDetailStatusById({});
    fileDetailPromisesRef.current.clear();
  }, [payload, sessionId]);

  useEffect(() => {
    const collapsedFilePaths = new Set(
      loadCollapsedReviewFilePaths(payload.meta.repo)
    );
    const nextExpandedFiles = buildExpandedFileIds(
      baseSegments,
      collapsedFilePaths
    );
    expandedFilesRef.current = nextExpandedFiles;
    setExpandedFiles(nextExpandedFiles);
  }, [baseSegments, payload.meta.repo, sessionId]);

  useEffect(() => {
    if (pendingSegmentId && pendingSegmentId === selectedSegmentId) {
      setPendingSegmentId(null);
    }
  }, [pendingSegmentId, selectedSegmentId]);

  useEffect(() => {
    setSegmentsPaneHeight((current) => clampSegmentsPaneHeight(current));
  }, [clampSegmentsPaneHeight]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const savedSidebarWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0) {
      setSidebarWidth(clampSidebarWidth(savedSidebarWidth));
    }

    const savedSegmentsPaneHeight = Number(
      window.localStorage.getItem(SIDEBAR_SEGMENTS_HEIGHT_STORAGE_KEY)
    );
    if (Number.isFinite(savedSegmentsPaneHeight) && savedSegmentsPaneHeight > 0) {
      setSegmentsPaneHeight(clampSegmentsPaneHeight(savedSegmentsPaneHeight));
    }

    const savedDiffViewMode = window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY);
    if (isDiffViewMode(savedDiffViewMode)) {
      setDiffViewMode(savedDiffViewMode);
    }

    setPreferencesLoaded(true);
  }, [clampSegmentsPaneHeight]);

  useEffect(() => {
    if (!preferencesLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampSidebarWidth(sidebarWidth))
    );
  }, [preferencesLoaded, sidebarWidth]);

  useEffect(() => {
    if (!preferencesLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(
      SIDEBAR_SEGMENTS_HEIGHT_STORAGE_KEY,
      String(clampSegmentsPaneHeight(segmentsPaneHeight))
    );
  }, [clampSegmentsPaneHeight, preferencesLoaded, segmentsPaneHeight]);

  useEffect(() => {
    if (!preferencesLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, diffViewMode);
  }, [preferencesLoaded, diffViewMode]);

  useEffect(() => {
    expandedFilesRef.current = expandedFiles;
  }, [expandedFiles]);

  const selectedSegment =
    segments.find((segment) => segment.id === selectedSegmentId) || segments[0] || null;
  const visibleFiles = selectedSegment?.files ?? [];
  const visibleFileIds = useMemo(
    () =>
      selectedSegment
        ? selectedSegment.files.map((file) => getSegmentFileId(selectedSegment.id, file.path))
        : [],
    [selectedSegment]
  );
  const visibleFilePaths = useMemo(
    () => Array.from(new Set(visibleFiles.map((file) => file.path))),
    [visibleFiles]
  );

  useEffect(() => {
    if (!selectedSegment) {
      setSelectedFileId(null);
      return;
    }

    const nextFileIds = selectedSegment.files.map((file) =>
      getSegmentFileId(selectedSegment.id, file.path)
    );
    if (selectedFileId && nextFileIds.includes(selectedFileId)) {
      return;
    }
    setSelectedFileId(nextFileIds[0] ?? null);
  }, [selectedSegment, selectedFileId]);

  const getCommentSegmentId = useCallback(
    (segmentId: string | undefined) => {
      if (segmentId) return segmentId;
      return segments.length === 1 ? segments[0]?.id : undefined;
    },
    [segments]
  );

  const getSegmentCommentCount = useCallback(
    (segmentId: string) =>
      commentsValue.comments.filter(
        (comment) => getCommentSegmentId(comment.segmentId) === segmentId
      ).length,
    [commentsValue.comments, getCommentSegmentId]
  );

  const getCommentsForSegment = useCallback(
    (segmentId: string) =>
      commentsValue.comments.filter(
        (comment) => getCommentSegmentId(comment.segmentId) === segmentId
      ),
    [commentsValue.comments, getCommentSegmentId]
  );

  const getSegmentLevelComments = useCallback(
    (segmentId: string) =>
      getCommentsForSegment(segmentId).filter((comment) => isSegmentComment(comment)),
    [getCommentsForSegment]
  );

  const persistCollapsedFilePaths = useCallback(
    (nextExpandedFiles: Set<string>) => {
      const nextCollapsedFilePaths = new Set(
        loadCollapsedReviewFilePaths(payload.meta.repo)
      );

      fileIdsByPath.forEach((fileIds, filePath) => {
        const isExpanded = fileIds.some((fileId) => nextExpandedFiles.has(fileId));
        if (isExpanded) {
          nextCollapsedFilePaths.delete(filePath);
        } else {
          nextCollapsedFilePaths.add(filePath);
        }
      });

      saveCollapsedReviewFilePaths(payload.meta.repo, nextCollapsedFilePaths);
    },
    [fileIdsByPath, payload.meta.repo]
  );

  const updateExpandedFiles = useCallback(
    (updater: (current: Set<string>) => Set<string>) => {
      const nextExpandedFiles = updater(new Set(expandedFilesRef.current));
      expandedFilesRef.current = nextExpandedFiles;
      setExpandedFiles(nextExpandedFiles);
      persistCollapsedFilePaths(nextExpandedFiles);
    },
    [persistCollapsedFilePaths]
  );

  const setFilePathExpanded = useCallback(
    (filePath: string, isExpanded: boolean) => {
      const fileIds = fileIdsByPath.get(filePath) ?? [];
      if (fileIds.length === 0) {
        return;
      }

      updateExpandedFiles((current) => {
        const next = new Set(current);
        fileIds.forEach((fileId) => {
          if (isExpanded) {
            next.add(fileId);
          } else {
            next.delete(fileId);
          }
        });
        return next;
      });
    },
    [fileIdsByPath, updateExpandedFiles]
  );

  const expandAll = useCallback(() => {
    updateExpandedFiles((current) => {
      const next = new Set(current);
      visibleFilePaths.forEach((filePath) => {
        (fileIdsByPath.get(filePath) ?? []).forEach((fileId) => next.add(fileId));
      });
      return next;
    });
  }, [fileIdsByPath, updateExpandedFiles, visibleFilePaths]);

  const collapseAll = useCallback(() => {
    updateExpandedFiles((current) => {
      const next = new Set(current);
      visibleFilePaths.forEach((filePath) => {
        (fileIdsByPath.get(filePath) ?? []).forEach((fileId) => next.delete(fileId));
      });
      return next;
    });
  }, [fileIdsByPath, updateExpandedFiles, visibleFilePaths]);

  const ensureFileDetails = useCallback(
    async (segmentId: string, file: AgentReviewFile) => {
      if (!loadFileDetails || !requiresFileDetails(file)) {
        return;
      }

      const fileId = getSegmentFileId(segmentId, file.path);
      const existingPromise = fileDetailPromisesRef.current.get(fileId);
      if (existingPromise) {
        await existingPromise;
        return;
      }

      setFileDetailStatusById((previous) => ({
        ...previous,
        [fileId]: "loading",
      }));

      const promise = loadFileDetails(segmentId, file.path)
        .then((details) => {
          setLazyFileDetailsById((previous) => {
            const next = {
              ...previous,
              [fileId]: {
                ...(previous[fileId] ?? {}),
                ...details,
              },
            };
            lazyFileDetailsRef.current = next;
            return next;
          });
          setFileDetailStatusById((previous) => ({
            ...previous,
            [fileId]: "loaded",
          }));
        })
        .catch((error) => {
          setFileDetailStatusById((previous) => {
            const next = { ...previous };
            delete next[fileId];
            return next;
          });
          throw error;
        })
        .finally(() => {
          fileDetailPromisesRef.current.delete(fileId);
        });

      fileDetailPromisesRef.current.set(fileId, promise);
      await promise;
      return lazyFileDetailsRef.current[fileId];
    },
    [loadFileDetails]
  );

  const copyFileText = useCallback(async (fileId: string, text: string) => {
    await copyTextToClipboard(text);
    setCopiedFileId(fileId);
  }, []);

  function renderFilePath(filePath: string, textClassName: string) {
    return (
      <span className={`min-w-0 flex-1 ${textClassName}`}>{filePath}</span>
    );
  }

  useEffect(() => {
    if (!loadFileDetails) {
      return;
    }

    const queue = buildFileDetailPrefetchQueue(
      baseSegments,
      selectedSegmentId,
      selectedFileId
    );
    if (queue.length === 0) {
      return;
    }

    let cancelled = false;
    let nextIndex = 0;

    async function worker() {
      while (!cancelled) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= queue.length) {
          return;
        }

        const entry = queue[currentIndex];
        const fileId = getSegmentFileId(entry.segmentId, entry.file.path);
        const hydratedFile = mergeFileDetails(
          entry.file,
          lazyFileDetailsRef.current[fileId]
        );

        if (!requiresFileDetails(hydratedFile)) {
          continue;
        }

        try {
          await ensureFileDetails(entry.segmentId, hydratedFile);
        } catch {
          continue;
        }
      }
    }

    const workerCount = Math.min(BACKGROUND_FILE_DETAIL_CONCURRENCY, queue.length);
    void Promise.all(Array.from({ length: workerCount }, () => worker()));

    return () => {
      cancelled = true;
    };
  }, [
    baseSegments,
    ensureFileDetails,
    loadFileDetails,
    selectedFileId,
    selectedSegmentId,
    sessionId,
  ]);

  const markExportCopied = useCallback((actionId: string) => {
    setCopiedExportIds((previous) => {
      const next = new Set(previous);
      next.add(actionId);
      return next;
    });

    const existingTimeout = exportCopyResetTimersRef.current.get(actionId);
    if (existingTimeout) {
      window.clearTimeout(existingTimeout);
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedExportIds((previous) => {
        if (!previous.has(actionId)) {
          return previous;
        }

        const next = new Set(previous);
        next.delete(actionId);
        return next;
      });
      exportCopyResetTimersRef.current.delete(actionId);
    }, EXPORT_COPY_RESET_MS);

    exportCopyResetTimersRef.current.set(actionId, timeoutId);
  }, []);

  const copyExportText = useCallback(
    async (text: string, actionId: string) => {
      await copyTextToClipboard(text);
      markExportCopied(actionId);
    },
    [markExportCopied]
  );

  const copyAllComments = useCallback(async () => {
    if (commentsCount === 0) return;
    await copyExportText(allCommentsExportText, ALL_COMMENTS_EXPORT_ID);
  }, [allCommentsExportText, commentsCount, copyExportText]);

  const copySelectedComments = useCallback(
    async (comments: ReviewComment[], actionId: string) => {
      if (comments.length === 0) return;
      await copyExportText(generateExportPrompt(payload, comments), actionId);
    },
    [copyExportText, payload]
  );

  const copyFullDiff = useCallback(async () => {
    await copyExportText(fullDiffExportText, FULL_DIFF_EXPORT_ID);
  }, [copyExportText, fullDiffExportText]);

  const closePanels = useCallback(() => {
    setHotkeysOpen(false);
    setSegmentContextMenu(null);
    setOpenCopyMenuId(null);
  }, []);

  useEffect(() => {
    return () => {
      exportCopyResetTimersRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      exportCopyResetTimersRef.current.clear();
    };
  }, []);

  const selectSegment = useCallback((segmentId: string) => {
    setAddingSegmentCommentId(null);
    setSegmentContextMenu(null);
    setOpenCopyMenuId(null);

    if (segmentId === pendingSegmentId) {
      return;
    }

    if (segmentId === selectedSegmentId && pendingSegmentId == null) {
      setPendingSegmentId(null);
      return;
    }

    setPendingSegmentId(segmentId);
    startSegmentTransition(() => {
      setSelectedSegmentId(segmentId);
    });
  }, [pendingSegmentId, selectedSegmentId, startSegmentTransition]);

  const clearAllComments = useCallback(() => {
    if (commentsCount === 0) return;
    commentsValue.clearComments();
  }, [commentsCount, commentsValue]);

  const clearSegmentComments = useCallback(
    (segment: AgentReviewSegment) => {
      const segmentComments = getCommentsForSegment(segment.id);
      if (segmentComments.length === 0) return;
      commentsValue.removeComments(segmentComments.map((comment) => comment.id));
      setAddingSegmentCommentId((current) => (current === segment.id ? null : current));
      setSegmentContextMenu(null);
    },
    [commentsValue, getCommentsForSegment]
  );

  const selectFile = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    const element = document.getElementById(getFileAnchorId(fileId));
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const addSegmentComment = useCallback(
    (body: string) => {
      if (!selectedSegment) return;
      commentsValue.addComment({
        kind: "segment",
        segmentId: selectedSegment.id,
        segmentLabel: getSegmentPanelTitle(selectedSegment),
        commitHash: selectedSegment.commitHash,
        commitMessage: selectedSegment.commitMessage,
        body,
      });
      setAddingSegmentCommentId(null);
    },
    [commentsValue, selectedSegment]
  );

  const allExpanded =
    visibleFileIds.length > 0 && visibleFileIds.every((fileId) => expandedFiles.has(fileId));
  const hasBlockingOverlay = hotkeysOpen;
  const allCommentsCopied =
    commentsCount > 0 && copiedExportIds.has(ALL_COMMENTS_EXPORT_ID);
  const fullDiffCopied = copiedExportIds.has(FULL_DIFF_EXPORT_ID);
  const clampedSegmentsPaneHeight = clampSegmentsPaneHeight(segmentsPaneHeight);
  const activeSegmentId = pendingSegmentId ?? selectedSegment?.id ?? null;
  const pendingSegment = pendingSegmentId
    ? segments.find((segment) => segment.id === pendingSegmentId) || null
    : null;
  const selectedSegmentCommentCount = selectedSegment
    ? getSegmentCommentCount(selectedSegment.id)
    : 0;
  const selectedSegmentLevelComments = selectedSegment
    ? getSegmentLevelComments(selectedSegment.id)
    : [];
  const selectedSegmentHasCommentForm =
    !!selectedSegment && addingSegmentCommentId === selectedSegment.id;
  const contextMenuSegment = segmentContextMenu
    ? segments.find((segment) => segment.id === segmentContextMenu.segmentId) || null
    : null;
  const contextMenuCommentCount = contextMenuSegment
    ? getCommentsForSegment(contextMenuSegment.id).length
    : 0;
  const contextMenuExportActionId = contextMenuSegment
    ? `${ALL_COMMENTS_EXPORT_ID}:${contextMenuSegment.id}`
    : null;
  const contextMenuCommentsCopied =
    contextMenuCommentCount > 0 &&
    !!contextMenuExportActionId &&
    copiedExportIds.has(contextMenuExportActionId);

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      sidebarResizeRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
      setIsResizingSidebar(true);
    },
    [sidebarWidth]
  );

  const startSidebarSectionResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      sidebarSectionResizeRef.current = {
        startY: event.clientY,
        startHeight: segmentsPaneHeight,
      };
      setIsResizingSidebarSections(true);
    },
    [segmentsPaneHeight]
  );

  const segmentContextMenuStyle =
    segmentContextMenu && typeof window !== "undefined"
      ? {
          left: Math.max(
            12,
            Math.min(segmentContextMenu.clientX, window.innerWidth - 220)
          ),
          top: Math.max(
            12,
            Math.min(segmentContextMenu.clientY, window.innerHeight - 120)
          ),
        }
      : undefined;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (hasBlockingOverlay) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [hasBlockingOverlay]);

  useEffect(() => {
    if (!copiedFileId) return;

    const timeoutId = window.setTimeout(() => {
      setCopiedFileId((current) => (current === copiedFileId ? null : current));
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [copiedFileId]);

  useEffect(() => {
    if (!openCopyMenuId) return;

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest("[data-copy-menu-root]")) return;
      setOpenCopyMenuId(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [openCopyMenuId]);

  useEffect(() => {
    if (!segmentContextMenu) return;

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target.closest("[data-segment-menu-root]")) return;
      setSegmentContextMenu(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [segmentContextMenu]);

  useEffect(() => {
    if (!hasBlockingOverlay) return;
    setOpenCopyMenuId(null);
    setSegmentContextMenu(null);
  }, [hasBlockingOverlay]);

  useEffect(() => {
    function handleResize() {
      setSidebarWidth((current) => clampSidebarWidth(current));
      setSegmentsPaneHeight((current) => clampSegmentsPaneHeight(current));
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampSegmentsPaneHeight]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    function handlePointerMove(event: PointerEvent) {
      const resizeState = sidebarResizeRef.current;
      if (!resizeState) return;

      const nextWidth =
        resizeState.startWidth + (event.clientX - resizeState.startX);
      setSidebarWidth(clampSidebarWidth(nextWidth));
    }

    function stopResizing() {
      sidebarResizeRef.current = null;
      setIsResizingSidebar(false);
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!isResizingSidebarSections) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    function handlePointerMove(event: PointerEvent) {
      const resizeState = sidebarSectionResizeRef.current;
      if (!resizeState) return;

      const nextHeight =
        resizeState.startHeight + (event.clientY - resizeState.startY);
      setSegmentsPaneHeight(clampSegmentsPaneHeight(nextHeight));
    }

    function stopResizing() {
      sidebarSectionResizeRef.current = null;
      setIsResizingSidebarSections(false);
    }

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [clampSegmentsPaneHeight, isResizingSidebarSections]);

  useEffect(() => {
    setOpenCopyMenuId(null);
    setSegmentContextMenu(null);
    setAddingSegmentCommentId(null);
  }, [selectedSegmentId]);

  useEffect(() => {
    if (!selectedSegmentId) return;
    requestAnimationFrame(() => {
      mainScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  }, [selectedSegmentId]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName;
      return (
        target.isContentEditable ||
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT"
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (openCopyMenuId) {
          event.preventDefault();
          setOpenCopyMenuId(null);
          return;
        }
        if (segmentContextMenu) {
          event.preventDefault();
          setSegmentContextMenu(null);
          return;
        }
        if (hasBlockingOverlay) {
          event.preventDefault();
          closePanels();
        }
        return;
      }

      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "?") {
        event.preventDefault();
        setHotkeysOpen((prev) => !prev);
        return;
      }

      if (hasBlockingOverlay || openCopyMenuId || segmentContextMenu) return;

      switch (event.key.toLowerCase()) {
        case "e":
          event.preventDefault();
          if (allExpanded) {
            collapseAll();
          } else {
            expandAll();
          }
          break;
        case "d":
          event.preventDefault();
          void copyFullDiff();
          break;
        case "c":
          if (commentsCount === 0) return;
          event.preventDefault();
          void copyAllComments();
          break;
        case "a":
          event.preventDefault();
          router.push("/");
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    hasBlockingOverlay,
    openCopyMenuId,
    segmentContextMenu,
    closePanels,
    allExpanded,
    collapseAll,
    expandAll,
    commentsCount,
    copyAllComments,
    copyFullDiff,
    router,
  ]);

  return (
    <PayloadContext.Provider value={payload}>
      <CommentsContext.Provider value={commentsValue}>
        <div className="review-shell flex h-screen flex-col">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-800 bg-gray-900 px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-4">
              <a href="/" className="text-lg font-bold transition-colors hover:text-blue-400">
                AgentReview
              </a>
              <span className="text-sm text-gray-400">
                {payload.meta.repo} / {payload.meta.branch}
              </span>
              <span className="font-mono text-xs text-gray-600">{payload.meta.commitHash}</span>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {onRefresh ? (
                <button
                  type="button"
                  onClick={() => {
                    void onRefresh();
                  }}
                  disabled={isRefreshing}
                  className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-500/20 disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"
                  title="Re-run this local review with the same agentreview command"
                >
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              ) : null}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500">
                  View
                </span>
                <div className="inline-flex rounded-lg border border-gray-700 bg-gray-800/80 p-1">
                  <button
                    type="button"
                    onClick={() => setDiffViewMode("unified")}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      diffViewMode === "unified"
                        ? "bg-cyan-500/15 text-cyan-100"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    Unified
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiffViewMode("split")}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      diffViewMode === "split"
                        ? "bg-cyan-500/15 text-cyan-100"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    Split
                  </button>
                </div>
              </div>
              <button
                onClick={allExpanded ? collapseAll : expandAll}
                className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:text-white"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
              <span className="text-xs text-gray-500">
                {commentsCount} comment
                {commentsCount !== 1 ? "s" : ""}
              </span>
              <button
                type="button"
                onClick={() => {
                  void copyFullDiff();
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
                  fullDiffCopied
                    ? "bg-emerald-500/15 text-emerald-100 shadow-[0_0_0_1px_rgba(52,211,153,0.35)]"
                    : "bg-gray-700 text-white hover:bg-gray-600"
                }`}
                title="Copy the full review diff to the clipboard"
              >
                {fullDiffCopied ? "Copied Diff" : "Export Diff"}
              </button>
              <button
                type="button"
                onClick={() => {
                  void copyAllComments();
                }}
                disabled={commentsCount === 0}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200 ${
                  allCommentsCopied
                    ? "bg-emerald-500/15 text-emerald-100 shadow-[0_0_0_1px_rgba(52,211,153,0.35)]"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                } disabled:bg-gray-700 disabled:text-gray-500`}
                title={
                  commentsCount === 0
                    ? "No comments to export"
                    : "Copy all review comments to the clipboard"
                }
              >
                {allCommentsCopied ? "Copied Comments" : "Export Comments"}
              </button>
              <button
                onClick={clearAllComments}
                disabled={commentsCount === 0}
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"
                title={
                  commentsCount === 0
                    ? "No comments to clear"
                    : "Remove all comments from this review"
                }
              >
                Clear Comments
              </button>
            </div>
          </header>
          {refreshError ? (
            <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
              {refreshError}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <aside
              ref={sidebarRef}
              className="hidden min-h-0 shrink-0 flex-col border-r border-gray-800 bg-gray-950 lg:flex"
              style={{ width: `${sidebarWidth}px` }}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <div
                  className="min-h-0"
                  style={{ height: `${clampedSegmentsPaneHeight}px` }}
                >
                  <div className="flex h-full min-h-0 flex-col p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                      Provenance
                    </p>
                    <div className="mt-3 flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
                      {segments.map((segment) => {
                        const isSelected = segment.id === activeSegmentId;
                        const segmentCommentCount = getSegmentCommentCount(segment.id);
                        const commitMessage = segment.kind === "commit" ? segment.commitMessage : undefined;
                        return (
                          <button
                            key={segment.id}
                            type="button"
                            onClick={() => selectSegment(segment.id)}
                            onContextMenu={
                              segment.kind === "commit"
                                ? (event) => {
                                    event.preventDefault();
                                    setSegmentContextMenu({
                                      segmentId: segment.id,
                                      clientX: event.clientX,
                                      clientY: event.clientY,
                                    });
                                  }
                                : undefined
                            }
                            title={commitMessage || undefined}
                            className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                              isSelected
                                ? "border-cyan-500/50 bg-cyan-500/10 text-white"
                                : "border-gray-800 bg-gray-900/70 text-gray-300 hover:border-gray-700 hover:bg-gray-900"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold">
                                  {getSegmentNavTitle(segment)}
                                </p>
                                <p className="mt-1 text-xs text-gray-400">
                                  {getSegmentNavSubtitle(segment)}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {segmentCommentCount > 0 && (
                                  <span className="min-w-[1.25rem] rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-xs text-white">
                                    {segmentCommentCount}
                                  </span>
                                )}
                                <span className="text-[11px] text-gray-500">
                                  {segment.files.length}
                                </span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="group flex h-3 shrink-0 items-stretch justify-center">
                  <button
                    type="button"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize sidebar sections"
                    onPointerDown={startSidebarSectionResize}
                    onDoubleClick={() =>
                      setSegmentsPaneHeight(
                        clampSegmentsPaneHeight(DEFAULT_SEGMENTS_PANE_HEIGHT)
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setSegmentsPaneHeight((current) =>
                          clampSegmentsPaneHeight(current - 24)
                        );
                      }
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setSegmentsPaneHeight((current) =>
                          clampSegmentsPaneHeight(current + 24)
                        );
                      }
                    }}
                    className="flex h-full w-full touch-none items-center justify-center bg-transparent focus:outline-none"
                    title="Drag to resize the commits and files panes. Double-click to reset."
                  >
                    <span
                      className={`h-px w-full transition-colors ${
                        isResizingSidebarSections
                          ? "bg-cyan-400"
                          : "bg-gray-800 group-hover:bg-gray-600"
                      }`}
                    />
                  </button>
                </div>

                <div className="min-h-0 flex-1">
                  <div className="flex h-full min-h-0 flex-col p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                      Files
                    </p>
                    {selectedSegment && selectedSegment.files.length > 0 ? (
                      <div className="mt-3 flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
                        {selectedSegment.files.map((file) => {
                          const fileId = getSegmentFileId(selectedSegment.id, file.path);
                          const commentCount = commentsValue.getCommentsForFile(fileId).length;
                          const isSelected = selectedFileId === fileId;
                          return (
                            <button
                              key={fileId}
                              type="button"
                              onClick={() => selectFile(fileId)}
                              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                isSelected
                                  ? "bg-gray-800 text-white"
                                  : "text-gray-300 hover:bg-gray-900"
                              }`}
                            >
                              <span className={`font-mono text-xs font-bold ${STATUS_COLORS[file.status]}`}>
                                {STATUS_LABELS[file.status]}
                              </span>
                              {renderFilePath(file.path, "block truncate font-mono")}
                              {commentCount > 0 && (
                                <span className="min-w-[1.25rem] rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-xs text-white">
                                  {commentCount}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-gray-500">No files in this segment.</p>
                    )}
                  </div>
                </div>
              </div>
            </aside>

            <div className="group hidden w-3 shrink-0 items-stretch justify-center lg:flex">
              <button
                type="button"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                onPointerDown={startSidebarResize}
                onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    setSidebarWidth((current) => clampSidebarWidth(current - 24));
                  }
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    setSidebarWidth((current) => clampSidebarWidth(current + 24));
                  }
                }}
                className="flex w-full touch-none items-center justify-center bg-transparent focus:outline-none"
                title="Drag to resize the sidebar. Double-click to reset."
              >
                <span
                  className={`h-full w-px transition-colors ${
                    isResizingSidebar
                      ? "bg-cyan-400"
                      : "bg-gray-800 group-hover:bg-gray-600"
                  }`}
                />
              </button>
            </div>

            <main
              ref={mainScrollRef}
              className="min-w-0 flex-1 overflow-y-auto"
              aria-busy={isSwitchingSegment}
            >
              <div
                className={`mx-auto flex w-full flex-col gap-4 px-4 py-4 ${
                  diffViewMode === "split" ? "max-w-[112rem]" : "max-w-5xl"
                }`}
              >
                {segments.length > 1 && (
                  <div className="lg:hidden">
                    <div className="overflow-x-auto pb-1">
                      <div className="flex gap-2">
                        {segments.map((segment) => {
                          const isSelected = segment.id === activeSegmentId;
                          return (
                            <button
                              key={segment.id}
                              type="button"
                              onClick={() => selectSegment(segment.id)}
                              className={`shrink-0 rounded-full border px-3 py-2 text-sm transition-colors ${
                                isSelected
                                  ? "border-cyan-500/50 bg-cyan-500/10 text-white"
                                  : "border-gray-800 bg-gray-900 text-gray-300"
                              }`}
                            >
                              {getSegmentNavTitle(segment)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {isSwitchingSegment && pendingSegment && (
                  <div className="sticky top-3 z-30">
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-50 shadow-[0_0_0_1px_rgba(34,211,238,0.12)] backdrop-blur">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-cyan-300" />
                        <span className="truncate">
                          Loading {pendingSegment.kind === "commit" ? "commit" : "segment"}{" "}
                          {getSegmentNavTitle(pendingSegment)}
                        </span>
                      </div>
                      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-100/80">
                        Preparing diff
                      </span>
                    </div>
                  </div>
                )}

                {selectedSegment && (
                  <section className="rounded-xl border border-gray-800 bg-gray-950/70 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                          {selectedSegment.kind === "commit" ? "Commit" : "Review Segment"}
                        </p>
                        <h2 className="mt-1 text-lg font-semibold text-white">
                          {getSegmentPanelTitle(selectedSegment)}
                        </h2>
                        <p className="mt-1 text-sm text-gray-400">
                          {getSegmentPanelSubtitle(selectedSegment)}
                        </p>
                        {selectedSegment.kind === "commit" && selectedSegment.commitMessage && (
                          <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-gray-300">
                            {selectedSegment.commitMessage}
                          </pre>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        <span>
                          {visibleFiles.length} file{visibleFiles.length === 1 ? "" : "s"}
                        </span>
                        <span>&bull;</span>
                        <span>
                          {selectedSegmentCommentCount} comment
                          {selectedSegmentCommentCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 rounded-xl border border-gray-800 bg-gray-900/60 p-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
                            {getSegmentCommentSectionLabel(selectedSegment)}
                          </p>
                          <p className="mt-1 text-sm text-gray-400">
                            Comments that apply to the whole {selectedSegment.kind === "commit" ? "commit" : "segment"}.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setAddingSegmentCommentId((current) =>
                              current === selectedSegment.id ? null : selectedSegment.id
                            )
                          }
                          className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
                        >
                          {selectedSegmentHasCommentForm
                            ? "Cancel"
                            : getSegmentCommentActionLabel(selectedSegment)}
                        </button>
                      </div>
                      {selectedSegmentHasCommentForm && (
                        <div className="mt-3">
                          <InlineCommentForm
                            selectionLabel={
                              selectedSegment.kind === "commit"
                                ? "Commit comment"
                                : "Segment comment"
                            }
                            onSubmit={addSegmentComment}
                            onCancel={() => setAddingSegmentCommentId(null)}
                          />
                        </div>
                      )}
                      {selectedSegmentLevelComments.length > 0 ? (
                        <div className="mt-3">
                          {selectedSegmentLevelComments.map((comment) => (
                            <InlineComment
                              key={comment.id}
                              comment={comment}
                              onEdit={commentsValue.updateComment}
                              onDelete={commentsValue.removeComment}
                            />
                          ))}
                        </div>
                      ) : (
                        !selectedSegmentHasCommentForm && (
                          <p className="mt-3 text-sm text-gray-500">
                            No {selectedSegment.kind === "commit" ? "commit" : "segment"} comments yet.
                          </p>
                        )
                      )}
                    </div>
                  </section>
                )}

                {selectedSegment &&
                  selectedSegment.files.map((file, fileIndex) => {
                    const fileId = getSegmentFileId(selectedSegment.id, file.path);
                    const isExpanded = expandedFiles.has(fileId);
                    const commentCount = commentsValue.getCommentsForFile(fileId).length;
                    const isSelected = selectedFileId === fileId;
                    const shouldPrioritizeDiff = isSelected || fileIndex < 2;
                    const isLoadingFileDetails =
                      fileDetailStatusById[fileId] === "loading";
                    const canCopyOldSource =
                      file.oldSource != null ||
                      (!!loadFileDetails && file.status !== "added");
                    const canCopyNewSource =
                      file.source != null ||
                      (!!loadFileDetails && file.status !== "deleted");

                    return (
                      <div
                        key={fileId}
                        id={getFileAnchorId(fileId)}
                        className={`rounded-lg border bg-gray-900 ${
                          isSelected
                            ? "border-cyan-500/50 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
                            : "border-gray-700"
                        }`}
                      >
                        <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-gray-800 bg-gray-900/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-gray-900/80">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedFileId(fileId);
                              if (!isExpanded) {
                                void ensureFileDetails(selectedSegment.id, file).catch(() => {});
                              }
                              setFilePathExpanded(file.path, !isExpanded);
                            }}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:text-white"
                          >
                            <span className={`text-xs text-gray-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                              ▶
                            </span>
                            <span className={`font-mono text-xs font-bold ${STATUS_COLORS[file.status]}`}>
                              {STATUS_LABELS[file.status]}
                            </span>
                            {renderFilePath(
                              file.path,
                              "block truncate font-mono text-sm text-gray-200"
                            )}
                          </button>
                          {commentCount > 0 && (
                            <span className="min-w-[1.25rem] rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-xs text-white">
                              {commentCount}
                            </span>
                          )}
                          {isLoadingFileDetails && (
                            <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-100">
                              Loading file
                            </span>
                          )}
                          <div className="relative shrink-0" data-copy-menu-root>
                            <button
                              type="button"
                              onClick={() =>
                                setOpenCopyMenuId((current) =>
                                  current === fileId ? null : fileId
                                )
                              }
                              className="flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
                              aria-expanded={openCopyMenuId === fileId}
                              aria-haspopup="menu"
                              aria-label={`Copy options for ${file.path}`}
                            >
                              <span>{copiedFileId === fileId ? "Copied!" : "Copy"}</span>
                              <span className="text-[10px] text-gray-500">▾</span>
                            </button>
                            {openCopyMenuId === fileId && (
                              <div
                                role="menu"
                                className="absolute right-0 top-full z-30 mt-2 w-44 rounded-lg border border-gray-700 bg-gray-950 p-1 shadow-xl"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    void copyFileText(fileId, file.path);
                                    setOpenCopyMenuId(null);
                                  }}
                                  className="block w-full rounded-md px-3 py-2 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
                                  title="Copy the file path"
                                >
                                  Copy file path
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={async () => {
                                    try {
                                      if (file.oldSource == null) {
                                        await ensureFileDetails(selectedSegment.id, file);
                                      }
                                      const nextFile = mergeFileDetails(
                                        file,
                                        lazyFileDetailsRef.current[fileId]
                                      );
                                      if (nextFile.oldSource == null) return;
                                      await copyFileText(fileId, nextFile.oldSource);
                                      setOpenCopyMenuId(null);
                                    } catch {
                                      return;
                                    }
                                  }}
                                  disabled={
                                    isLoadingFileDetails || !canCopyOldSource
                                  }
                                  className="block w-full rounded-md px-3 py-2 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:text-gray-600"
                                  title={
                                    canCopyOldSource
                                      ? "Copy the old file contents"
                                      : "Old file contents are unavailable"
                                  }
                                >
                                  {isLoadingFileDetails ? "Loading old file..." : "Copy old file"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={async () => {
                                    try {
                                      if (file.source == null) {
                                        await ensureFileDetails(selectedSegment.id, file);
                                      }
                                      const nextFile = mergeFileDetails(
                                        file,
                                        lazyFileDetailsRef.current[fileId]
                                      );
                                      if (nextFile.source == null) return;
                                      await copyFileText(fileId, nextFile.source);
                                      setOpenCopyMenuId(null);
                                    } catch {
                                      return;
                                    }
                                  }}
                                  disabled={
                                    isLoadingFileDetails || !canCopyNewSource
                                  }
                                  className="block w-full rounded-md px-3 py-2 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:text-gray-600"
                                  title={
                                    canCopyNewSource
                                      ? "Copy the new file contents"
                                      : "New file contents are unavailable"
                                  }
                                >
                                  {isLoadingFileDetails ? "Loading new file..." : "Copy new file"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    void copyFileText(fileId, file.diff);
                                    setOpenCopyMenuId(null);
                                  }}
                                  className="block w-full rounded-md px-3 py-2 text-left text-xs text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
                                  title="Copy the full file diff"
                                >
                                  Copy full diff
                                </button>
                              </div>
                            )}
                          </div>
                        </div>

                        {isExpanded && (
                          <DeferredDiff
                            fileId={fileId}
                            eagerOrder={fileIndex}
                            prioritize={shouldPrioritizeDiff}
                          >
                            <DiffView
                              file={file}
                              fileId={fileId}
                              segmentId={selectedSegment.id}
                              segmentLabel={getSegmentPanelTitle(selectedSegment)}
                              segmentCommitHash={selectedSegment.commitHash}
                              segmentCommitMessage={selectedSegment.commitMessage}
                              viewMode={diffViewMode}
                            />
                          </DeferredDiff>
                        )}
                      </div>
                    );
                  })}

                {selectedSegment && selectedSegment.files.length === 0 && (
                  <div className="rounded-lg border border-gray-800 bg-gray-950/70 p-6 text-sm text-gray-500">
                    No files in this segment.
                  </div>
                )}
              </div>
            </main>
          </div>

          <button
            type="button"
            onClick={() => setHotkeysOpen(true)}
            className="fixed bottom-4 right-4 z-40 h-10 w-10 rounded-full border border-gray-600 bg-gray-800 text-lg font-bold text-gray-200 transition-colors hover:bg-gray-700 hover:text-white"
            aria-label="Show keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
        </div>

        {hotkeysOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setHotkeysOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-gray-700 p-4">
                <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
                <button
                  type="button"
                  onClick={() => setHotkeysOpen(false)}
                  className="text-xl text-gray-400 hover:text-white"
                  aria-label="Close keyboard shortcuts"
                >
                  &times;
                </button>
              </div>
              <div className="p-4">
                <ul className="space-y-3">
                  {HOTKEYS.map((hotkey) => (
                    <li
                      key={hotkey.key}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-700 bg-gray-950/60 px-3 py-2"
                    >
                      <kbd className="rounded border border-gray-600 bg-gray-800 px-2 py-1 font-mono text-xs text-gray-200">
                        {hotkey.key}
                      </kbd>
                      <span className="text-right text-sm text-gray-300">
                        {hotkey.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {contextMenuSegment && segmentContextMenuStyle && (
          <div
            role="menu"
            data-segment-menu-root
            className="fixed z-50 w-52 rounded-lg border border-gray-700 bg-gray-950 p-1 shadow-2xl"
            style={segmentContextMenuStyle}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (contextMenuCommentCount === 0) return;
                if (!contextMenuExportActionId) return;
                void copySelectedComments(
                  getCommentsForSegment(contextMenuSegment.id),
                  contextMenuExportActionId
                );
              }}
              disabled={contextMenuCommentCount === 0}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:text-gray-600 ${
                contextMenuCommentsCopied
                  ? "bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              {contextMenuCommentsCopied ? "Copied comments" : "Export comments"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => clearSegmentComments(contextMenuSegment)}
              disabled={contextMenuCommentCount === 0}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-red-200 transition-colors hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:text-gray-600"
            >
              Clear comments
            </button>
          </div>
        )}
      </CommentsContext.Provider>
    </PayloadContext.Provider>
  );
}
