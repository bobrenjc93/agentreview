import { type ReviewComment } from "./types";

const STORAGE_KEY_PREFIX = "agentreview:comments";

function getStorageKey(sessionId: string): string {
  return `${STORAGE_KEY_PREFIX}:${sessionId}`;
}

export function loadComments(sessionId: string): ReviewComment[] {
  if (typeof window === "undefined") return [];
  if (!sessionId) return [];
  try {
    const raw = localStorage.getItem(getStorageKey(sessionId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveComments(sessionId: string, comments: ReviewComment[]): void {
  if (typeof window === "undefined") return;
  if (!sessionId) return;
  localStorage.setItem(getStorageKey(sessionId), JSON.stringify(comments));
}

export function clearComments(sessionId: string): void {
  if (typeof window === "undefined") return;
  if (!sessionId) return;
  localStorage.removeItem(getStorageKey(sessionId));
}
