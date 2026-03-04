import { type AgentReviewPayload } from "@/lib/payload/types";

export function generateExportDiff(payload: AgentReviewPayload): string {
  const chunks = payload.files
    .map((file) => file.diff.trimEnd())
    .filter((chunk) => chunk.length > 0);

  if (chunks.length === 0) {
    return "No diff to export.";
  }

  return `${chunks.join("\n\n")}\n`;
}
