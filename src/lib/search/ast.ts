import * as acorn from 'acorn';

export type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

export interface CaseInfo {
  name: string;
  aliases: string[];
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
  switchIndex: number;
  caseIndex: number;
  isLast: boolean;
}

export interface FunctionInfo {
  name: string;
  kind: 'function' | 'arrow' | 'method' | 'export';
  lineStart: number;
  lineEnd: number;
  charStart: number;
  charEnd: number;
  params: string[];
  async: boolean;
}

export interface ImportInfo {
  source: string;
  names: string[];
  kind: 'require' | 'import';
  line: number;
}

export interface AstSummary {
  ok: boolean;
  error?: string;
  cases: CaseInfo[];
  functions: FunctionInfo[];
  imports: ImportInfo[];
  variables: string[];
}

function parse(source: string): { ast: AstNode | null; error?: string } {
  const common: acorn.Options = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    locations: true,
  };
  try {
    return { ast: acorn.parse(source, { ...common, sourceType: 'script' }) as unknown as AstNode };
  } catch (scriptError) {
    try {
      return { ast: acorn.parse(source, { ...common, sourceType: 'module' }) as unknown as AstNode };
    } catch (moduleError) {
      const err = moduleError as Error & { loc?: { line: number; column: number } };
      const where = err.loc ? ` (line ${err.loc.line}, column ${err.loc.column + 1})` : '';
      void scriptError;
      return { ast: null, error: `${err.message}${where}` };
    }
  }
}

export function walkAst(node: AstNode | null | undefined, visit: (node: AstNode, parent: AstNode | null) => void): void {
  if (!node || typeof node.type !== 'string') return;
  const stack: Array<{ node: AstNode; parent: AstNode | null }> = [{ node, parent: null }];
  while (stack.length) {
    const current = stack.pop()!;
    visit(current.node, current.parent);
    for (const key of Object.keys(current.node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
      const value = current.node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && typeof (item as AstNode).type === 'string') {
            stack.push({ node: item as AstNode, parent: current.node });
          }
        }
      } else if (value && typeof value === 'object' && typeof (value as AstNode).type === 'string') {
        stack.push({ node: value as AstNode, parent: current.node });
      }
    }
  }
}

function lineMap(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function labelText(node: AstNode | null | undefined, source: string): string {
  if (!node) return 'default';
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as Array<{ value: { cooked: string } }>;
    if (quasis.length === 1) return quasis[0].value.cooked;
  }
  return source.slice(node.start, node.end).trim();
}

function propertyName(node: AstNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return String(node.name);
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'PrivateIdentifier') return `#${String(node.name)}`;
  return null;
}

export function summarizeJavaScript(source: string): AstSummary {
  const { ast, error } = parse(source);
  if (!ast) return { ok: false, error, cases: [], functions: [], imports: [], variables: [] };
  const starts = lineMap(source);
  const cases: CaseInfo[] = [];
  const functions: FunctionInfo[] = [];
  const imports: ImportInfo[] = [];
  const variables = new Set<string>();

  let switchIndex = 0;
  walkAst(ast, (node, parent) => {
    if (node.type === 'SwitchStatement') {
      const currentSwitch = switchIndex++;
      const caseList = (node.cases as AstNode[]) ?? [];
      let i = 0;
      while (i < caseList.length) {
        const first = caseList[i];
        const startNode = first;
        const aliases: string[] = [labelText(first.test as AstNode, source)];
        let j = i;
        while (
          j + 1 < caseList.length &&
          ((caseList[j].consequent as AstNode[]) ?? []).length === 0
        ) {
          j += 1;
          aliases.push(labelText(caseList[j].test as AstNode, source));
        }
        const body = (caseList[j].consequent as AstNode[]) ?? [];
        const endOffset = body.length ? body[body.length - 1].end : caseList[j].end;
        cases.push({
          name: aliases[0],
          aliases: aliases.slice(1),
          lineStart: lineAt(starts, startNode.start),
          lineEnd: lineAt(starts, endOffset),
          charStart: startNode.start,
          charEnd: endOffset,
          switchIndex: currentSwitch,
          caseIndex: i,
          isLast: j === caseList.length - 1,
        });
        i = j + 1;
      }
    }

    if (node.type === 'FunctionDeclaration' && (node.id as AstNode | null)?.name) {
      functions.push(mkFunction(String((node.id as AstNode).name), 'function', node, source, starts));
    }
    if (node.type === 'VariableDeclarator') {
      const id = node.id as AstNode;
      if (id?.type === 'Identifier') variables.add(String(id.name));
      const init = node.init as AstNode | null;
      if (init) {
        const fnTypes = ['FunctionExpression', 'ArrowFunctionExpression'];
        if (fnTypes.includes(init.type) && id?.type === 'Identifier') {
          const fn = mkFunction(String(id.name), init.type === 'ArrowFunctionExpression' ? 'arrow' : 'function', init, source, starts);
          fn.charStart = node.start;
          functions.push(fn);
        }
      }
    }
    if (node.type === 'AssignmentExpression') {
      const left = node.left as AstNode;
      const right = node.right as AstNode;
      if (
        left?.type === 'MemberExpression' &&
        right &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(right.type)
      ) {
        const name = propertyName(left.property as AstNode);
        if (name) {
          functions.push(mkFunction(name, 'export', node, source, starts));
        }
      }
    }
    if (node.type === 'MethodDefinition' || (node.type === 'Property' && parent && ['ObjectExpression', 'ClassBody'].includes(parent.type))) {
      const value = node.value as AstNode | null;
      if (value && ['FunctionExpression', 'ArrowFunctionExpression'].includes(value.type)) {
        const name = propertyName((node.key as AstNode) ?? null);
        if (name) functions.push(mkFunction(name, 'method', value, source, starts));
      }
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode;
      if (callee?.type === 'Identifier' && callee.name === 'require') {
        const args = node.arguments as AstNode[];
        if (args?.[0]?.type === 'Literal') {
          imports.push({
            source: String(args[0].value),
            names: [],
            kind: 'require',
            line: lineAt(starts, node.start),
          });
        }
      }
    }
    if (node.type === 'ImportDeclaration') {
      const names = ((node.specifiers as AstNode[]) ?? []).map((spec) => {
        if (spec.type === 'ImportDefaultSpecifier') return 'default';
        if (spec.type === 'ImportNamespaceSpecifier') return '*';
        return String((spec.imported as AstNode)?.name ?? '');
      });
      imports.push({
        source: String((node.source as AstNode)?.value ?? ''),
        names,
        kind: 'import',
        line: lineAt(starts, node.start),
      });
    }
  });

  return { ok: true, cases, functions, imports, variables: [...variables] };
}

function mkFunction(
  name: string,
  kind: FunctionInfo['kind'],
  node: AstNode,
  source: string,
  starts: number[],
): FunctionInfo {
  const params = ((node.params as AstNode[]) ?? []).map((param) => source.slice(param.start, param.end));
  return {
    name,
    kind,
    lineStart: lineAt(starts, node.start),
    lineEnd: lineAt(starts, node.end),
    charStart: node.start,
    charEnd: node.end,
    params,
    async: Boolean(node.async),
  };
}

export interface TextMatch {
  line: number;
  column: number;
  lineText: string;
  before: string[];
  after: string[];
}

export function findTextMatches(
  source: string,
  pattern: RegExp,
  contextLines = 2,
  maxMatches = 200,
): TextMatch[] {
  const lines = source.split('\n');
  const matches: TextMatch[] = [];
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  // Line-by-line so snippets and line numbers stay exact.
  for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
    const line = lines[i];
    const re = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      matches.push({
        line: i + 1,
        column: match.index + 1,
        lineText: line,
        before: lines.slice(Math.max(0, i - contextLines), i),
        after: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)),
        });
      if (match[0] === '') re.lastIndex += 1;
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Line numbers are 1-based everywhere in this application. */
export function offsetToLine(source: string, offset: number): number {
  return lineAt(lineMap(source), offset);
}

export function lineRangeOf(source: string, startLine: number, endLine: number): { start: number; end: number } {
  const lines = source.split('\n');
  const clampStart = Math.max(0, Math.min(startLine - 1, lines.length - 1));
  const clampEnd = Math.max(clampStart, Math.min(endLine - 1, lines.length - 1));
  let start = 0;
  for (let i = 0; i < clampStart; i += 1) start += lines[i].length + 1;
  let end = start;
  for (let i = clampStart; i <= clampEnd; i += 1) {
    end += lines[i].length + (i < clampEnd ? 1 : 0);
  }
  return { start, end };
}
