import parseDiff from "parse-diff";

export type ParsedFile = parseDiff.File;
export type ParsedChunk = parseDiff.Chunk;
export type ParsedChange = parseDiff.Change;

export function parseDiffString(diff: string): ParsedFile[] {
  return parseDiff(diff);
}
