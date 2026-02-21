"use client";

import { useEffect, useState } from "react";
import { type AgentReviewPayload } from "@/lib/payload/types";
import { asPayload } from "@/lib/payload/validate";
import { ReviewLayout } from "@/components/ReviewLayout";

export default function ReviewPage() {
  const [payload, setPayload] = useState<AgentReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("agentreview:payload");
      if (!raw) {
        setError("No payload found. Please go back and paste one.");
        return;
      }
      const data = JSON.parse(raw);
      setPayload(asPayload(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load payload");
    }
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <a href="/" className="text-blue-400 hover:underline">
            Go back
          </a>
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return <ReviewLayout payload={payload} />;
}
