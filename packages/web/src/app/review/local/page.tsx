"use client";

import { useCallback, useEffect, useState } from "react";
import { ReviewLayout } from "@/components/ReviewLayout";
import {
  isAgentReplySegment,
  type AgentReplyResult,
  type RunAgentOptions,
} from "@/lib/comments/agent";
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
const LOCAL_AGENT_ENDPOINT = "/__agentreview__/agent";
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

  const runAgent = useCallback(
    async (prompt: string, options?: RunAgentOptions): Promise<AgentReplyResult> => {
      const response = await fetch(
        buildLocalEndpointUrl(LOCAL_AGENT_ENDPOINT, sessionId),
        {
          cache: "no-store",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            resumeSessionId: options?.resumeSessionId,
          }),
        }
      );

      if (!response.ok || !response.body) {
        let message = "The agent request failed.";
        try {
          const data = (await response.json()) as { error?: unknown };
          if (typeof data.error === "string") message = data.error;
        } catch {
          // not JSON; keep the generic message
        }
        throw new Error(message);
      }

      // The endpoint streams NDJSON: segment events, then one done/error line.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let result: AgentReplyResult | null = null;
      let streamError: string | null = null;

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: {
          type?: unknown;
          segment?: unknown;
          result?: unknown;
          error?: unknown;
        };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "segment" && isAgentReplySegment(event.segment)) {
          options?.onSegment?.(event.segment);
        } else if (event.type === "error") {
          streamError =
            typeof event.error === "string" ? event.error : "The agent run failed.";
        } else if (
          event.type === "done" &&
          event.result &&
          typeof event.result === "object"
        ) {
          const data = event.result as {
            response?: unknown;
            segments?: unknown;
            model?: unknown;
            durationMs?: unknown;
            costUsd?: unknown;
            sessionId?: unknown;
          };
          if (typeof data.response === "string") {
            result = {
              response: data.response,
              segments: Array.isArray(data.segments)
                ? data.segments.filter(isAgentReplySegment)
                : undefined,
              model: typeof data.model === "string" ? data.model : undefined,
              durationMs:
                typeof data.durationMs === "number" ? data.durationMs : undefined,
              costUsd: typeof data.costUsd === "number" ? data.costUsd : undefined,
              sessionId:
                typeof data.sessionId === "string" ? data.sessionId : undefined,
            };
          }
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      }
      handleLine(buffered);

      if (streamError) {
        throw new Error(streamError);
      }
      if (!result) {
        throw new Error("The agent stream ended without a result.");
      }
      return result;
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
      runAgent={runAgent}
      onRefresh={refreshReview}
      isRefreshing={isRefreshing}
      refreshError={refreshError}
    />
  );
}
