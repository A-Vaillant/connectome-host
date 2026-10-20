import { expect, test } from 'bun:test';
import { previewPyreplCall } from '../src/pyrepl-preview.js';

const preview = (code: string) => previewPyreplCall('mcpl--pyrepl--exec', { session: 'audit', code })!;

test('renders imports, assignments, and actual call syntax without invented intent', () => {
  expect(preview('from pathlib import Path\np = Path("notes.md")\nprint(p.read_text())')).toEqual({
    title: 'pyrepl exec · audit',
    lines: ['from pathlib import Path', 'set p = Path("notes.md")', 'call print(p.read_text())'],
  });
  expect(preview('subprocess.run(["git", "status"], check=True)').lines).toEqual(['call subprocess.run(["git", "status"], check=True)']);
});

test('preserves blocks, branches and ordering rather than flattening conditional effects', () => {
  expect(preview('for f in files:\n    text = f.read_text()\n    print(text)').lines).toEqual([
    'for f in files:', '  set text = f.read_text()', '  call print(text)',
  ]);
  expect(preview('if ready:\n    save()\nelse:\n    fail()').lines).toEqual([
    'if ready:', '  call save()', 'else:', '  call fail()',
  ]);
  expect(preview('with open("x") as f:\n    print(f.read())').lines).toEqual(['with open("x") as f:', '  call print(f.read())']);
  expect(preview('def remove(path):\n    path.unlink()').lines).toEqual(['def remove(path):', '  call path.unlink()']);
  expect(preview('@wrap\ndef f():\n    run()').lines).toEqual(['@wrap', 'def f():', '  call run()']);
  expect(preview('match x:\n    case 1:\n        y()').lines).toEqual(['match x:', '  case 1:', '    call y()']);
});

test('semicolon in a literal is not another statement; dynamic calls remain literal', () => {
  expect(preview('x = "a;b"; print(x)').lines).toEqual(['set x = "a;b"', 'call print(x)']);
  expect(preview('getattr(obj, name)(value)').lines).toEqual(['call getattr(obj, name)(value)']);
  expect(preview('exec("do_something()")').lines).toEqual(['call exec("do_something()")']);
});

test('does not parse partial, invalid, oversized, or missing source as an honest complete tree', () => {
  expect(preview('def bad(').notice).toContain('syntax not recognized');
  expect(preview('def bad(').lines).toEqual([]);
  expect(preview('x'.repeat(65537)).notice).toContain('64 KiB');
  expect(preview('#' + '💜'.repeat(17000)).notice).toContain('64 KiB');
  expect(previewPyreplCall('mcpl--pyrepl--exec', { session: 'x', code: 'okay()' }, true)?.notice).toContain('truncated');
  expect(previewPyreplCall('mcpl--pyrepl--exec', {})?.notice).toContain('unavailable');
  expect(preview(' \n').notice).toContain('empty');
});

test('bounds rows, depth and width and explicitly marks omissions', () => {
  const many = preview(Array.from({ length: 12 }, (_, i) => `x${i} = ${i}`).join('\n'));
  expect(many.lines).toHaveLength(8);
  expect(many.notice).toContain('4 more');
  const wide = preview('print("' + 'x'.repeat(300) + '")');
  expect(wide.lines[0].length).toBeLessThanOrEqual(180);
  expect(wide.notice).toContain('shortened');
  const deep = preview(Array.from({ length: 9 }, (_, i) => '  '.repeat(i) + 'if ready:').join('\n') + '\n' + '  '.repeat(9) + 'run()');
  expect(deep.notice).toContain('nested blocks collapsed');
});

test('tool controls show operation/session; terminal controls cannot escape into rendered output', () => {
  expect(previewPyreplCall('mcpl--pyrepl--wait', { session: 'work', timeout: 10 })).toEqual({ title: 'pyrepl wait · work', lines: ['requested timeout: 10s'] });
  expect(previewPyreplCall('mcpl--pyrepl--sessions', {})).toEqual({ title: 'pyrepl sessions', lines: [] });
  const unsafe = previewPyreplCall('mcpl--pyrepl--exec', { session: '\x1b]52;c;secret\x07', code: '#\x1b[2J\npass' })!;
  expect(unsafe.title).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(unsafe.title).toContain('\\u001b'); // visible backslash-u text
  expect(unsafe.lines.join('')).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});

test('does not intercept unrelated tools or execute Python', () => {
  expect(previewPyreplCall('workspace--read', {})).toBeUndefined();
  expect(previewPyreplCall('mcpl--other--exec', {})).toBeUndefined();
  expect(preview('raise RuntimeError("not executed")').lines).toEqual(['raise RuntimeError("not executed")']);
});
