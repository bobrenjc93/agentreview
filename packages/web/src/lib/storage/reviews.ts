const REVIEW_STORAGE_INDEX_KEY = "agentreview:review-index"
const REVIEW_COMMENTS_STORAGE_KEY_PREFIX = "agentreview:comments"
const REVIEW_COLLAPSED_FILES_STORAGE_KEY_PREFIX = "agentreview:collapsed-files"

export const REVIEW_PAYLOAD_STORAGE_KEY = "agentreview:payload"
export const REVIEW_SESSION_ID_STORAGE_KEY = "agentreview:sessionId"

type ReviewStorageIndex = Record<string, number>

interface ActiveReviewSession {
  payload: unknown
  sessionId: string
}

interface StorageQuotaRetryOptions {
  excludeSessionIds?: string[]
}

let activeReviewSession: ActiveReviewSession | null = null

export function getReviewCommentsStorageKey(sessionId: string): string {
  return `${REVIEW_COMMENTS_STORAGE_KEY_PREFIX}:${sessionId}`
}

function getCollapsedFilesStorageKey(repo: string): string | null {
  const normalizedRepo = repo.trim()
  if (!normalizedRepo) return null
  return `${REVIEW_COLLAPSED_FILES_STORAGE_KEY_PREFIX}:${encodeURIComponent(
    normalizedRepo
  )}`
}

export function loadCollapsedReviewFilePaths(repo: string): string[] {
  if (typeof window === "undefined") return []

  const storageKey = getCollapsedFilesStorageKey(repo)
  if (!storageKey) return []

  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return Array.from(
      new Set(
        parsed.filter(
          (filePath): filePath is string =>
            typeof filePath === "string" && filePath.trim().length > 0
        )
      )
    ).sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

export function saveCollapsedReviewFilePaths(
  repo: string,
  filePaths: Iterable<string>
): void {
  if (typeof window === "undefined") return

  const storageKey = getCollapsedFilesStorageKey(repo)
  if (!storageKey) return

  const normalizedPaths = Array.from(
    new Set(
      Array.from(filePaths)
        .filter((filePath): filePath is string => typeof filePath === "string")
        .map((filePath) => filePath.trim())
        .filter((filePath) => filePath.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right))

  try {
    if (normalizedPaths.length === 0) {
      localStorage.removeItem(storageKey)
      return
    }

    localStorage.setItem(storageKey, JSON.stringify(normalizedPaths))
  } catch {
    // Ignore best-effort preference write failures.
  }
}

function readReviewStorageIndex(): ReviewStorageIndex {
  try {
    const raw = localStorage.getItem(REVIEW_STORAGE_INDEX_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }

    return Object.entries(parsed).reduce<ReviewStorageIndex>(
      (index, [sessionId, lastAccessedAt]) => {
        if (
          sessionId.length > 0 &&
          typeof lastAccessedAt === "number" &&
          Number.isFinite(lastAccessedAt)
        ) {
          index[sessionId] = lastAccessedAt
        }
        return index
      },
      {}
    )
  } catch {
    return {}
  }
}

function writeReviewStorageIndex(index: ReviewStorageIndex): void {
  try {
    if (Object.keys(index).length === 0) {
      localStorage.removeItem(REVIEW_STORAGE_INDEX_KEY)
      return
    }
    localStorage.setItem(REVIEW_STORAGE_INDEX_KEY, JSON.stringify(index))
  } catch {
    // Ignore index write failures and keep best-effort eviction metadata.
  }
}

function listStoredReviewSessions(): Array<{
  sessionId: string
  lastAccessedAt: number
}> {
  const index = readReviewStorageIndex()
  const sessionIds = new Set(Object.keys(index))

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key?.startsWith(`${REVIEW_COMMENTS_STORAGE_KEY_PREFIX}:`)) continue
    sessionIds.add(key.slice(REVIEW_COMMENTS_STORAGE_KEY_PREFIX.length + 1))
  }

  return Array.from(sessionIds)
    .map((sessionId) => ({
      sessionId,
      lastAccessedAt: index[sessionId] ?? 0,
    }))
    .sort(
      (a, b) =>
        a.lastAccessedAt - b.lastAccessedAt || a.sessionId.localeCompare(b.sessionId)
    )
}

function evictLeastRecentlyUsedReview(excludeSessionIds: Set<string>): boolean {
  const sessions = listStoredReviewSessions()
  const nextSession = sessions.find(
    ({ sessionId }) => !excludeSessionIds.has(sessionId)
  )

  if (!nextSession) return false
  clearStoredReview(nextSession.sessionId)
  return true
}

export function isStorageQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false

  const maybeQuotaError = error as {
    name?: unknown
    code?: unknown
  }

  return (
    maybeQuotaError.name === "QuotaExceededError" ||
    maybeQuotaError.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    maybeQuotaError.code === 22 ||
    maybeQuotaError.code === 1014
  )
}

export function withReviewStorageQuotaRetry<T>(
  write: () => T,
  options: StorageQuotaRetryOptions = {}
): T {
  const excludeSessionIds = new Set(options.excludeSessionIds ?? [])

  try {
    return write()
  } catch (error) {
    if (!isStorageQuotaExceededError(error)) {
      throw error
    }

    let lastError = error
    while (evictLeastRecentlyUsedReview(excludeSessionIds)) {
      try {
        return write()
      } catch (retryError) {
        if (!isStorageQuotaExceededError(retryError)) {
          throw retryError
        }
        lastError = retryError
      }
    }

    throw lastError
  }
}

export function touchStoredReview(sessionId: string): void {
  if (typeof window === "undefined") return
  if (!sessionId) return

  const index = readReviewStorageIndex()
  index[sessionId] = Date.now()
  writeReviewStorageIndex(index)
}

export function clearStoredReview(sessionId: string): void {
  if (typeof window === "undefined") return
  if (!sessionId) return

  localStorage.removeItem(getReviewCommentsStorageKey(sessionId))

  const index = readReviewStorageIndex()
  if (!(sessionId in index)) return

  delete index[sessionId]
  writeReviewStorageIndex(index)
}

export function storeReviewPayloadInSession(
  payload: unknown,
  sessionId: string
): void {
  activeReviewSession = { payload, sessionId }

  try {
    withReviewStorageQuotaRetry(() => {
      sessionStorage.setItem(REVIEW_PAYLOAD_STORAGE_KEY, JSON.stringify(payload))
      sessionStorage.setItem(REVIEW_SESSION_ID_STORAGE_KEY, sessionId)
    })
  } catch (error) {
    if (!isStorageQuotaExceededError(error)) {
      throw error
    }
  }
}

export function loadReviewPayloadFromSession(): ActiveReviewSession | null {
  if (activeReviewSession) {
    return activeReviewSession
  }

  if (typeof window === "undefined") {
    return activeReviewSession
  }

  try {
    const raw = sessionStorage.getItem(REVIEW_PAYLOAD_STORAGE_KEY)
    const sessionId = sessionStorage.getItem(REVIEW_SESSION_ID_STORAGE_KEY)

    if (raw && sessionId) {
      const payload = JSON.parse(raw)
      activeReviewSession = {
        payload,
        sessionId,
      }
      return activeReviewSession
    }
  } catch {
    // Fall through to the in-memory session if storage is unavailable or corrupt.
  }

  return activeReviewSession
}
