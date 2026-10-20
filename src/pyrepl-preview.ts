import { parser } from '@lezer/python';

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];
export interface PyreplPreview {
  title: string;
  lines: string[];
  notice?: string;
}

/** Present the model-facing calls carried by inference:tool_calls_yielded.
 * MCP lifecycle traces are a different shape: bare tool names, and no owner.
 * Do not wait for those traces to render the user's tool-call message. */
export function presentToolCallBatch(calls: ReadonlyArray<{ name: string; input?: unknown }>, expanded = false): { label: string; rows: string[] } {
  const previews = calls.map(call => previewPyreplCall(call.name, call.input));
  const rows: string[] = [];
  for (const view of previews) {
    if (!view) continue;
    if (calls.length > 1) rows.push(view.title);
    rows.push(...view.lines.map(line => `  ${line}`));
    if (view.notice) rows.push(`  ${view.notice}`);
  }
  return { label: calls.map((call, i) => previews[i]?.title ?? call.name).join(', '), rows: expanded ? rows : [] };
}

const MAX_BYTES = 64 * 1024;
const MAX_ROWS = 8;
const MAX_DEPTH = 4;

/** Text only: never allow source/session strings to emit terminal controls. */
function visible(text: string, limit = 180): string {
  const clean = text.replace(/\r/g, '\\r').replace(/\n/g, ' ↵ ').replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return clean.length <= limit ? clean : clean.slice(0, limit - 1) + '…';
}

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

/** A syntactic projection, not inferred intent, effect tracking, or execution.
 * Lezer produces a concrete syntax tree; this view keeps statements and block
 * structure. Raw input remains authoritative and is rendered separately. */
export function previewPyreplCall(name: string, input: unknown, truncated = false): PyreplPreview | undefined {
  const operation = /^mcpl--pyrepl--(exec|wait|interrupt|kill|sessions)$/.exec(name)?.[1];
  if (!operation) return undefined;
  const args = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const session = typeof args.session === 'string' ? visible(args.session, 64) : undefined;
  const result: PyreplPreview = { title: `pyrepl ${operation}${session ? ` · ${session}` : ''}`, lines: [] };
  if (truncated) return { ...result, notice: 'input truncated; open raw input — no syntax preview' };
  if (operation !== 'exec') {
    if (typeof args.timeout === 'number' && Number.isFinite(args.timeout)) result.lines.push(`requested timeout: ${args.timeout}s`);
    return result;
  }
  if (typeof args.code !== 'string') return { ...result, notice: 'Python source unavailable; open raw input' };
  const code = args.code;
  if (code.length > MAX_BYTES || new TextEncoder().encode(code).byteLength > MAX_BYTES) return { ...result, notice: 'Python exceeds 64 KiB; open raw input — no syntax preview' };
  if (!code.trim()) return { ...result, notice: 'empty Python source' };
  if (typeof args.python === 'string') result.lines.push(`new-session interpreter: ${visible(args.python)}`);

  let tree: ReturnType<typeof parser.parse>;
  try { tree = parser.parse(code); }
  catch { return { ...result, lines: [], notice: 'Python parser failed; open raw input' }; }
  let errorAt: number | undefined;
  tree.iterate({ enter(node) { if (node.type.isError && errorAt === undefined) errorAt = node.from; } });
  if (errorAt !== undefined) {
    const line = code.slice(0, errorAt).split('\n').length;
    return { ...result, lines: [], notice: `Python syntax not recognized near line ${line}; open raw input` };
  }

  let omitted = 0;
  let depthLimited = false;
  const emit = (text: string, depth: number) => {
    if (result.lines.length < MAX_ROWS) result.lines.push('  '.repeat(depth) + visible(text.trim()));
    else omitted++;
  };
  const render = (node: SyntaxNode, depth: number) => {
    const parts = children(node);
    if (node.name === 'StatementGroup' || node.name === 'DecoratedStatement') {
      for (const part of parts) if (part.name !== ';') render(part, depth);
      return;
    }
    const bodies = parts.filter(child => child.name === 'Body' || child.name === 'MatchBody');
    if (bodies.length) {
      let from = node.from;
      for (const body of bodies) {
        // Body includes the ':' token; keep that delimiter with the header.
        emit(code.slice(from, body.firstChild?.name === ':' ? body.firstChild.to : body.from), depth);
        if (depth >= MAX_DEPTH) {
          emit('… nested block; open raw input', depth);
          depthLimited = true;
        } else {
          for (const child of children(body)) if (child.name !== ':') render(child, depth + 1);
        }
        from = body.to;
      }
      return;
    }
    const source = code.slice(node.from, node.to);
    const prefix = node.name === 'AssignStatement' ? 'set ' :
      node.name === 'UpdateStatement' ? 'update ' :
      node.name === 'ExpressionStatement' && parts[0]?.name === 'CallExpression' ? 'call ' : '';
    emit(prefix + source, depth);
  };
  for (const node of children(tree.topNode)) render(node, 0);
  const notes: string[] = [];
  if (omitted) notes.push(`${omitted} more preview rows; open raw input`);
  if (depthLimited) notes.push('nested blocks collapsed');
  if (result.lines.some(line => line.endsWith('…'))) notes.push('long rows shortened');
  if (notes.length) result.notice = notes.join(' · ');
  return result;
}
