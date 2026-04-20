"use client";

import { createContext, useContext } from "react";
import { type AgentReviewPayload } from "@/lib/payload/types";

export const PayloadContext = createContext<AgentReviewPayload | null>(null);

export function usePayload(): AgentReviewPayload {
  const ctx = useContext(PayloadContext);
  if (!ctx) {
    throw new Error("usePayload must be used within a PayloadContext provider");
  }
  return ctx;
}
