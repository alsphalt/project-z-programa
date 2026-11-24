import * as acorn from "acorn";
import * as walk from "acorn-walk";

export type ParsedCommand = {
  name: string;
  kind: "case" | "function" | "default";
  line: number;
  endLine: number;
  signature?: string;
  aliases?: string[];
};

export type CaseBlock = {
  name: string;
  filePath: string;
  line: number;
  endLine: number;
  /** Absolute character range of the whole `case ...:` block. */
  start: number;
  end: number;
  /** Range of the statements inside the case. */
  bodyStart: number;
  bodyEnd: number;
  switchStart: number;
  switchEnd: number;
  index: number;
  hasBreak: boolean;
  isLast: boolean;
  source: string;
};

export type ParseIssue = { line: number; column: number; message: string };

export type ParseOutcome = { ok: boolean; errors: ParseIssue[]; usedFallback: boolean };

const PARSE_OPTIONS: acorn.Options = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowImportExportEverywhere: true,
  locations: true,
};

function tryParse(code: string): acorn.Node | null {
  try {
    return acorn.parse(code, PARSE_OPTIONS);
  } catch {
    try {
      return acorn.parse(code, { ...PARSE_OPTIONS, sourceType: "module" });
    } catch {
      return null;
    }
  }
}

/** Structural validation used before any save/replace operation. */
export function validateJavaScript(code: string): ParseOutcome {
  try {
    acorn.parse(code, PARSE_OPTIONS);
    return { ok: true, errors: [], usedFallback: false };
  } catch (moduleError) {
    try {
      acorn.parse(code, { ...PARSE_OPTIONS, sourceType: "module" });
      return { ok: true, errors: [], usedFallback: false };
    } catch (error) {
      const err = error as SyntaxError & { loc?: { line: number; column: number } };
      return {
        ok: false,
        errors: [
          {
            line: err.loc?.line ?? 0,
            column: err.loc?.column ?? 0,
            message: err.message.replace(/\s*\(\d+:\d+\)$/, ""),
          },
        ],
        usedFallback: true,
      };
    }
  }
}

/** Brace/paren balance — a cheap second opinion when the parser rejects TS/JSX. */
export function balanceCheck(code: string): ParseIssue[] {
  const issues: ParseIssue[] = [];
  const stack: Array<{ char: string; line: number }> = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  let line = 1;
  let inLineComment = false;
  let inBlockComment = false;
  let quote: string | null = null;

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "\n") {
      line += 1;
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (pairs[ch]) stack.push({ char: ch, line });
    else if ([")", "]", "}"].includes(ch)) {
      const top = stack.pop();
      if (!top || pairs[top.char] !== ch) {
        issues.push({ line, column: i, message: `Unbalanced closing ${ch}` });
        if (issues.length > 5) return issues;
      }
    }
  }
  for (const open of stack.slice(0, 5)) {
    issues.push({ line: open.line, column: 0, message: `Unclosed ${open.char}` });
  }
  return issues;
}

type AnyNode = acorn.Node & Record<string, any>;

/** Extracts `switch (x) { case 'cmd': ... }` blocks with exact source ranges. */
export function extractCases(filePath: string, code: string): CaseBlock[] {
  const ast = tryParse(code);
  if (!ast) return [];

  const blocks: CaseBlock[] = [];

  walk.simple(ast as unknown as acorn.Node, {
    SwitchStatement(node: AnyNode) {
      const cases: AnyNode[] = node.cases ?? [];
      cases.forEach((caseNode, index) => {
        const test = caseNode.test as AnyNode | null;
        if (!test || test.type !== "Literal" || typeof test.value !== "string") return;

        const next = cases[index + 1];
        const start = caseNode.start as number;
        const end = next ? (next.start as number) : (node.end as number) - 1;
        const consequent: AnyNode[] = caseNode.consequent ?? [];
        const bodyStart = consequent.length > 0 ? (consequent[0].start as number) : (caseNode.colon as number) + 1;
        const bodyEnd = consequent.length > 0 ? (consequent[consequent.length - 1].end as number) : bodyStart;
        const hasBreak = consequent.some(
          (stmt) => stmt.type === "BreakStatement" || stmt.type === "ReturnStatement" || stmt.type === "ThrowStatement",
        );

        blocks.push({
          name: test.value,
          filePath,
          line: caseNode.loc?.start.line ?? 0,
          endLine: (next?.loc?.start.line ?? caseNode.loc?.end.line ?? 0) - (next ? 1 : 0),
          start,
          end,
          bodyStart,
          bodyEnd,
          switchStart: node.start as number,
          switchEnd: node.end as number,
          index,
          hasBreak,
          isLast: index === cases.length - 1,
          source: code.slice(start, end),
        });
      });
    },
  });

  return blocks.sort((a, b) => a.start - b.start);
}

/** Commands = string switch cases plus named functions, used for search + case manager. */
export function extractCommands(filePath: string, code: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  const ast = tryParse(code);

  if (!ast) {
    // Fallback: regex scan so an unparseable file still contributes command metadata.
    const re = /\bcase\s+(['"])([^'"]+)\1\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      const line = code.slice(0, match.index).split("\n").length;
      commands.push({ name: match[2], kind: "case", line, endLine: line });
    }
    return dedupe(commands);
  }

  walk.simple(ast as unknown as acorn.Node, {
    SwitchStatement(node: AnyNode) {
      for (const caseNode of (node.cases ?? []) as AnyNode[]) {
        const test = caseNode.test as AnyNode | null;
        if (!test) {
          commands.push({
            name: "default",
            kind: "default",
            line: caseNode.loc?.start.line ?? 0,
            endLine: caseNode.loc?.end.line ?? 0,
          });
          continue;
        }
        if (test.type === "Literal" && typeof test.value === "string") {
          commands.push({
            name: test.value,
            kind: "case",
            line: caseNode.loc?.start.line ?? 0,
            endLine: caseNode.loc?.end.line ?? 0,
          });
        }
      }
    },
    FunctionDeclaration(node: AnyNode) {
      if (!node.id?.name) return;
      const params = (node.params ?? [])
        .map((p: AnyNode) => p.name ?? p.left?.name ?? "...")
        .join(", ");
      commands.push({
        name: node.id.name,
        kind: "function",
        line: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
        signature: `function ${node.id.name}(${params})`,
      });
    },
    VariableDeclarator(node: AnyNode) {
      const name = node.id?.name;
      const init = node.init as AnyNode | null;
      if (!name || !init) return;
      if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") return;
      const params = (init.params ?? []).map((p: AnyNode) => p.name ?? "...").join(", ");
      commands.push({
        name,
        kind: "function",
        line: node.loc?.start.line ?? 0,
        endLine: node.loc?.end.line ?? 0,
        signature: `const ${name} = (${params}) =>`,
      });
    },
  });

  return dedupe(commands);
}

function dedupe(list: ParsedCommand[]): ParsedCommand[] {
  const seen = new Set<string>();
  return list.filter((cmd) => {
    const key = `${cmd.kind}:${cmd.name}:${cmd.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Alias map from the bot's own config.json (`cmdAliases`), so the case manager
 * shows the aliases that actually dispatch to a command.
 */
export function buildAliasMap(configText: string | null): Record<string, string[]> {
  if (!configText) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return {};
  }
  const raw = (parsed as { cmdAliases?: unknown })?.cmdAliases;
  if (!raw || typeof raw !== "object") return {};

  const result: Record<string, string[]> = {};
  const add = (alias: string, target: string) => {
    if (!result[target]) result[target] = [];
    if (!result[target].includes(alias)) result[target].push(alias);
  };

  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    for (const [alias, target] of Object.entries(value as Record<string, unknown>)) {
      if (typeof target === "string") add(alias, target);
    }
  }
  return result;
}

export type CaseOp =
  | { action: "replace"; range: [number, number]; code: string }
  | { action: "delete"; start: number; end: number }
  | { action: "insert"; at: number; code: string }
  | { action: "duplicate"; block: CaseBlock; newName: string };

/**
 * Applies a structural edit and returns the new file text plus validation.
 * Ranges come from the AST, so brackets and neighbouring cases stay intact.
 */
export function applyCaseOp(filePath: string, original: string, op: CaseOp): {
  content: string;
  validation: ParseOutcome;
  balance: ParseIssue[];
  affected: { start: number; end: number };
} {
  let content = original;
  let affected = { start: 0, end: 0 };

  if (op.action === "replace") {
    content = original.slice(0, op.range[0]) + op.code + original.slice(op.range[1]);
    affected = { start: op.range[0], end: op.range[0] + op.code.length };
  } else if (op.action === "delete") {
    let start = op.start;
    let end = op.end;
    // Consume the line indentation before the block so no blank gap is left behind.
    while (start > 0 && (original[start - 1] === " " || original[start - 1] === "\t")) start -= 1;
    if (original[end] === "\n") end += 1;
    content = original.slice(0, start) + original.slice(end);
    affected = { start, end: start };
  } else if (op.action === "insert") {
    content = original.slice(0, op.at) + op.code + original.slice(op.at);
    affected = { start: op.at, end: op.at + op.code.length };
  } else {
    const block = op.block;
    const duplicate = block.source.replace(
      new RegExp(`(case\\s*)(['"])${escapeRegExp(block.name)}\\2`),
      `$1$2${op.newName}$2`,
    );
    const insertAt = block.end;
    const separator = duplicate.startsWith("\n") ? "" : "\n";
    content = `${original.slice(0, insertAt)}${separator}${duplicate}${original.slice(insertAt)}`;
    affected = { start: insertAt, end: insertAt + duplicate.length };
  }

  const validation = validateJavaScript(content);
  const balance = validation.ok ? [] : balanceCheck(content);
  return { content, validation, balance, affected };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds the case block for a named command in a file. */
export function findCase(filePath: string, code: string, name: string): CaseBlock | null {
  return extractCases(filePath, code).find((block) => block.name === name) ?? null;
}
