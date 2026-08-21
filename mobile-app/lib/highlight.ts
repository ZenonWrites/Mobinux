// A small, dependency-free syntax highlighter. Not a full parser — just
// enough to color keywords, strings, comments, numbers, and function
// names/calls so code is readable, VS Code Dark+ style.

export type Token = { text: string; color: string };

export const COLORS = {
  keyword: "#c586c0",
  string: "#ce9178",
  comment: "#6a9955",
  number: "#b5cea8",
  func: "#dcdcaa",
  punctuation: "#d4d4d4",
  default: "#d4d4d4",
};

const JS_KEYWORDS = [
  "function", "return", "if", "else", "for", "while", "import", "from",
  "export", "default", "const", "let", "var", "try", "catch", "finally",
  "new", "class", "extends", "this", "typeof", "instanceof", "in", "of",
  "null", "undefined", "true", "false", "async", "await", "switch",
  "case", "break", "continue", "throw", "static", "super", "yield",
];

const KEYWORDS: Record<string, Set<string>> = {
  py: new Set([
    "def", "class", "return", "if", "elif", "else", "for", "while",
    "import", "from", "as", "try", "except", "finally", "with", "in",
    "not", "and", "or", "is", "none", "true", "false", "pass", "break",
    "continue", "lambda", "yield", "global", "raise", "async", "await", "self",
  ]),
  js: new Set(JS_KEYWORDS),
  ts: new Set([
    ...JS_KEYWORDS,
    "interface", "type", "implements", "public", "private", "protected",
    "readonly", "enum", "namespace", "declare",
  ]),
  json: new Set(["true", "false", "null"]),
  sh: new Set([
    "if", "then", "else", "fi", "for", "do", "done", "while", "case",
    "esac", "function", "echo", "export", "local", "return", "in",
  ]),
  yaml: new Set(["true", "false", "null"]),
  default: new Set<string>(),
};

export function langForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "py") return "py";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (["ts", "tsx"].includes(ext)) return "ts";
  if (ext === "json") return "json";
  if (["sh", "bash"].includes(ext)) return "sh";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  return "default";
}

const TOKEN_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|\s+|[^\sA-Za-z0-9_"']+)/g;

export function tokenizeLine(line: string, lang: string): Token[] {
  const commentChar =
    lang === "py" || lang === "sh" || lang === "yaml"
      ? "#"
      : lang === "js" || lang === "ts"
      ? "//"
      : null;

  const keywordSet = KEYWORDS[lang] ?? KEYWORDS.default;

  let commentIdx = -1;
  if (commentChar) {
    // crude: doesn't account for '#'/'//'' inside strings, good enough
    // for a readable preview rather than a full parser.
    commentIdx = line.indexOf(commentChar);
  }
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : "";

  const words: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(codePart)) !== null) {
    words.push(m[0]);
    if (m[0].length === 0) TOKEN_RE.lastIndex++;
  }

  const tokens: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\s+$/.test(w)) {
      tokens.push({ text: w, color: COLORS.default });
    } else if (/^["']/.test(w)) {
      tokens.push({ text: w, color: COLORS.string });
    } else if (/^\d/.test(w)) {
      tokens.push({ text: w, color: COLORS.number });
    } else if (/^[A-Za-z_]/.test(w)) {
      const lower = w.toLowerCase();
      if (keywordSet.has(lower)) {
        tokens.push({ text: w, color: COLORS.keyword });
      } else {
        let next = i + 1;
        while (next < words.length && /^\s+$/.test(words[next])) next++;
        if (words[next] === "(") {
          tokens.push({ text: w, color: COLORS.func });
        } else {
          tokens.push({ text: w, color: COLORS.default });
        }
      }
    } else {
      tokens.push({ text: w, color: COLORS.punctuation });
    }
  }

  if (commentPart) {
    tokens.push({ text: commentPart, color: COLORS.comment });
  }

  return tokens;
}
