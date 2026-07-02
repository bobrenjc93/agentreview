"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type CommentAgentSegment } from "@/lib/comments/types";

export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-markdown text-sm text-gray-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:text-blue-300 underline"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function AgentToolCall({ segment }: { segment: CommentAgentSegment }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 rounded border border-gray-700/80 bg-gray-900/60 px-2 py-1 font-mono text-xs">
      <span className="shrink-0 text-gray-500">⚙</span>
      <span className="shrink-0 font-medium text-cyan-300/90">{segment.name}</span>
      {segment.detail ? (
        <span className="truncate text-gray-400" title={segment.detail}>
          {segment.detail}
        </span>
      ) : null}
    </div>
  );
}

export function AgentReplyBody({
  segments,
  fallbackText,
}: {
  segments?: CommentAgentSegment[];
  fallbackText?: string;
}) {
  if (!segments || segments.length === 0) {
    return fallbackText ? <AgentMarkdown text={fallbackText} /> : null;
  }

  return (
    <div className="flex flex-col gap-2">
      {segments.map((segment, index) =>
        segment.type === "tool" ? (
          <AgentToolCall key={index} segment={segment} />
        ) : segment.text ? (
          <AgentMarkdown key={index} text={segment.text} />
        ) : null
      )}
    </div>
  );
}
