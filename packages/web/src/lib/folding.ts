export interface FoldRange {
  start: number;
  end: number;
}

type OpenBracket = "{" | "[" | "(";
type CloseBracket = "}" | "]" | ")";
type QuoteChar = "\"" | "'" | "`";

interface StringState {
  quote: QuoteChar;
  triple: boolean;
}

const CLOSE_TO_OPEN: Record<CloseBracket, OpenBracket> = {
  "}": "{",
  "]": "[",
  ")": "(",
};

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function getIndentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width += 1;
      continue;
    }
    if (char === "\t") {
      width += 2;
      continue;
    }
    break;
  }
  return width;
}

function buildIndentRanges(lines: string[]): FoldRange[] {
  const ranges: FoldRange[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    if (isBlank(lines[i])) continue;

    const baseIndent = getIndentWidth(lines[i]);
    let nextLine = i + 1;

    while (nextLine < lines.length && isBlank(lines[nextLine])) {
      nextLine += 1;
    }

    if (nextLine >= lines.length) continue;

    const nextIndent = getIndentWidth(lines[nextLine]);
    if (nextIndent <= baseIndent) continue;

    let end = nextLine;
    for (let j = nextLine + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      if (getIndentWidth(lines[j]) <= baseIndent) break;
      end = j;
    }

    if (end > i) {
      ranges.push({ start: i, end });
    }
  }

  return ranges;
}

function buildBracketRanges(lines: string[], language?: string): FoldRange[] {
  const ranges: FoldRange[] = [];
  const stack: Array<{ char: OpenBracket; line: number }> = [];
  const supportsPythonTripleQuotes = language === "python";
  let inBlockComment = false;
  let inString: StringState | null = null;
  let escaped = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const next = i + 1 < line.length ? line[i + 1] : "";
      const third = i + 2 < line.length ? line[i + 2] : "";

      if (inString) {
        if (inString.triple) {
          if (
            char === inString.quote &&
            next === inString.quote &&
            third === inString.quote
          ) {
            inString = null;
            i += 2;
          }
          continue;
        }

        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === inString.quote) {
          inString = null;
        }
        continue;
      }

      if (inBlockComment) {
        if (char === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }

      if (language === "python" && char === "#") {
        break;
      }
      if (char === "/" && next === "/") {
        break;
      }
      if (char === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }

      if (char === "\"" || char === "'" || char === "`") {
        if (
          supportsPythonTripleQuotes &&
          char !== "`" &&
          next === char &&
          third === char
        ) {
          inString = { quote: char, triple: true };
          escaped = false;
          i += 2;
          continue;
        }

        inString = { quote: char, triple: false };
        escaped = false;
        continue;
      }

      if (char === "{" || char === "[" || char === "(") {
        stack.push({ char, line: lineIndex });
        continue;
      }

      if (char === "}" || char === "]" || char === ")") {
        const expected = CLOSE_TO_OPEN[char];
        const top = stack[stack.length - 1];
        if (!top || top.char !== expected) continue;

        stack.pop();
        if (top.line < lineIndex) {
          ranges.push({ start: top.line, end: lineIndex });
        }
      }
    }

    escaped = false;
  }

  return ranges;
}

export function buildFoldRanges(lines: string[], language?: string): FoldRange[] {
  const candidates = [...buildBracketRanges(lines, language), ...buildIndentRanges(lines)];
  const byStart = new Map<number, FoldRange>();

  for (const range of candidates) {
    if (range.end <= range.start) continue;
    const existing = byStart.get(range.start);
    if (!existing || range.end > existing.end) {
      byStart.set(range.start, range);
    }
  }

  return [...byStart.values()].sort((a, b) => a.start - b.start);
}
