"use client";

import { useCallback, useEffect, useState } from "react";
import { ReviewLayout } from "@/components/ReviewLayout";
import { type AgentReviewPayload } from "@/lib/payload/types";
import { asPayload } from "@/lib/payload/validate";

interface LocalReviewResponse {
  payload?: unknown;
  sessionId?: unknown;
  error?: unknown;
}

const LOCAL_PAYLOAD_ENDPOINT = "/__agentreview__/payload";
const LOCAL_FILE_ENDPOINT = "/__agentreview__/file";
const LOCAL_REFRESH_ENDPOINT = "/__agentreview__/refresh";
const LOCAL_SESSION_QUERY_KEY = "agentreviewSession";

interface LocalFileResponse {
  source?: unknown;
  oldSource?: unknown;
  error?: unknown;
}

type LocalReviewAction = "load" | "refresh";

function buildLocalEndpointUrl(
  pathname: string,
  sessionId?: string | null,
  params?: URLSearchParams
): string {
  const nextParams = new URLSearchParams(params?.toString() ?? "");

  const nextSessionId =
    sessionId ??
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get(LOCAL_SESSION_QUERY_KEY)
      : null);

  if (nextSessionId) {
    nextParams.set(LOCAL_SESSION_QUERY_KEY, nextSessionId);
  }

  const query = nextParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function replaceLocationSessionId(sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set(LOCAL_SESSION_QUERY_KEY, sessionId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

async function fetchLocalReview(
  action: LocalReviewAction,
  sessionId?: string | null
): Promise<{
  payload: AgentReviewPayload;
  sessionId: string;
}> {
  const response = await fetch(
    buildLocalEndpointUrl(
      action === "refresh" ? LOCAL_REFRESH_ENDPOINT : LOCAL_PAYLOAD_ENDPOINT,
      sessionId
    ),
    {
      cache: "no-store",
      method: action === "refresh" ? "POST" : "GET",
    }
  );
  const data = (await response.json()) as LocalReviewResponse;

  if (!response.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : action === "refresh"
          ? "Failed to refresh the local review payload"
          : "Failed to load the local review payload"
    );
  }

  if (!data || typeof data !== "object") {
    throw new Error("The local review response was invalid.");
  }

  if (typeof data.sessionId !== "string" || !data.sessionId) {
    throw new Error("The local review response is missing a session ID.");
  }

  return {
    payload: asPayload(data.payload),
    sessionId: data.sessionId,
  };
}

export default function LocalReviewPage() {
  const [payload, setPayload] = useState<AgentReviewPayload | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const applyLocalReview = useCallback(
    (nextReview: { payload: AgentReviewPayload; sessionId: string }) => {
      setPayload(nextReview.payload);
      setSessionId(nextReview.sessionId);
      setError(null);
      setRefreshError(null);
      replaceLocationSessionId(nextReview.sessionId);
    },
    []
  );

  const loadFileDetails = useCallback(
    async (segmentId: string, filePath: string) => {
      const params = new URLSearchParams({
        segmentId,
        path: filePath,
      });
      const response = await fetch(
        buildLocalEndpointUrl(LOCAL_FILE_ENDPOINT, sessionId, params),
        {
          cache: "no-store",
        }
      );
      const data = (await response.json()) as LocalFileResponse;

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Failed to load local file contents"
        );
      }

      const details: { source?: string; oldSource?: string } = {};
      if (typeof data.source === "string") {
        details.source = data.source;
      }
      if (typeof data.oldSource === "string") {
        details.oldSource = data.oldSource;
      }
      return details;
    },
    [sessionId]
  );

  useEffect(() => {
    let cancelled = false;

    async function loadLocalReview() {
      try {
        const nextReview = await fetchLocalReview("load");
        if (cancelled) return;
        applyLocalReview(nextReview);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : "Failed to load the local review payload"
        );
      }
    }

    void loadLocalReview();

    return () => {
      cancelled = true;
    };
  }, [applyLocalReview]);

  const refreshReview = useCallback(async () => {
    setRefreshError(null);
    setIsRefreshing(true);
    try {
      const nextReview = await fetchLocalReview("refresh", sessionId);
      applyLocalReview(nextReview);
    } catch (e) {
      setRefreshError(
        e instanceof Error ? e.message : "Failed to refresh the local review payload"
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [applyLocalReview, sessionId]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="mb-4 text-red-400">{error}</p>
          <a href="/review/local" className="text-blue-400 hover:underline">
            Retry
          </a>
        </div>
      </div>
    );
  }

  if (!payload || !sessionId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <ReviewLayout
      payload={payload}
      sessionId={sessionId}
      loadFileDetails={loadFileDetails}
      onRefresh={refreshReview}
      isRefreshing={isRefreshing}
      refreshError={refreshError}
    />
  );
}
