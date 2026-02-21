export interface ReviewComment {
  id: string;
  filePath: string;
  lineNumber: number;
  lineContent: string;
  body: string;
  createdAt: string;
}
