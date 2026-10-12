import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRecipeDetailed, saveRecipe, unknownRecipeKeys, validateRecipe } from '../src/recipe.js';
import { prepareRecipeStartup } from '../src/recipe-startup.js';

const base = { name: 'Storage test', agent: { provider: 'mock', systemPrompt: 'offline' } };
let dir: string;
const originalFetch = globalThis.fetch;
const originalEnv = process.env;
beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, '.data-dir-'));
  process.env = { ...originalEnv, DATA_DIR_TEST_SECRET: 'synthetic-secret' };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});
function file(dataDir?: unknown) {
  const path = join(dir, 'recipe.json');
  writeFileSync(path, JSON.stringify({ ...base, ...(dataDir === undefined ? {} : { dataDir }) }));
  return path;
}

describe('recipe dataDir loader', () => {
  test('anchors to original file directory, including the persisted snapshot', async () => {
    const { recipe, persistable } = await loadRecipeDetailed(file('./state'));
    const expected = join(dir, 'state');
    expect(recipe.dataDir).toBe(expected);
    expect(persistable.dataDir).toBe(expected);
    saveRecipe(expected, persistable);
    expect((await loadRecipeDetailed(join(expected, '.recipe.json'))).recipe.dataDir).toBe(expected);
    expect(existsSync(join(expected, 'state'))).toBe(false);
  });

  test('absolute path passes through and missing field stays absent', async () => {
    expect((await loadRecipeDetailed(file(dir))).recipe.dataDir).toBe(dir);
    expect((await loadRecipeDetailed(file())).recipe.dataDir).toBeUndefined();
    expect(unknownRecipeKeys({ ...base, dataDir: dir })).toEqual([]);
  });

  test.each(['', '   ', null, 123, false, {}, []].map(value => [value]))('rejects invalid value %j', (dataDir) => {
    expect(() => validateRecipe({ ...base, dataDir })).toThrow(/dataDir.*nonempty string/);
  });

  test.each([undefined, '/absolute/local/state', 'relative/state'])('URL recipe dataDir %j', async (dataDir) => {
    globalThis.fetch = (async () => Response.json({ ...base, ...(dataDir === undefined ? {} : { dataDir }) })) as typeof fetch;
    const loaded = loadRecipeDetailed('https://example.invalid/recipe.json');
    if (dataDir === 'relative/state') await expect(loaded).rejects.toThrow(/dataDir.*relative.*URL/);
    else expect((await loaded).recipe.dataDir).toBe(dataDir);
  });

  test('snapshot anchors relative dataDir without substituting other secrets', async () => {
    const path = file('state');
    writeFileSync(path, JSON.stringify({ ...base, dataDir: 'state', description: '${DATA_DIR_TEST_SECRET}' }));
    const { recipe, persistable } = await loadRecipeDetailed(path);
    expect(recipe.description).toBe('synthetic-secret');
    saveRecipe(resolve(dir, 'state'), persistable);
    const snapshot = readFileSync(join(dir, 'state', '.recipe.json'), 'utf8');
    expect(snapshot).toContain('${DATA_DIR_TEST_SECRET}');
    expect(snapshot).not.toContain('synthetic-secret');
  });
});

describe('startup storage selection', () => {
  test.each([undefined, '', 'override'])('precedence with env %j', async (env) => {
    const override = env ? join(dir, env) : env;
    const chosen = join(dir, 'state');
    const result = await prepareRecipeStartup({ source: file('state'), noRecipe: false, envDataDir: override });
    expect(result.dataDir).toBe(override || chosen);
    expect(existsSync(join(result.dataDir, '.recipe.json'))).toBe(true);
    if (override) expect(existsSync(chosen)).toBe(false);
    expect(existsSync(join(dir, 'data', '.recipe.json'))).toBe(false);
  });

  test('missing field / empty env uses cwd data; resume and reset cannot redirect it', async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const initial = await prepareRecipeStartup({ source: file(), noRecipe: false, envDataDir: '' });
      expect(initial.dataDir).toBe('./data');
      expect(existsSync(join(dir, 'data', '.recipe.json'))).toBe(true);
      saveRecipe('./data', { ...base, dataDir: join(dir, 'must-not-create') });
      const resumed = await prepareRecipeStartup({ source: null, noRecipe: false, envDataDir: '' });
      expect(resumed.mode).toBe('resumed');
      expect(resumed.dataDir).toBe('./data');
      expect(existsSync(join(dir, 'must-not-create'))).toBe(false);
      const reset = await prepareRecipeStartup({ source: file('ignored'), noRecipe: true });
      expect(reset.dataDir).toBe('./data');
      expect(existsSync(join(dir, 'data', '.recipe.json'))).toBe(false);
      expect(existsSync(join(dir, 'ignored'))).toBe(false);
      expect((await prepareRecipeStartup({ source: null, noRecipe: false })).mode).toBe('default');
    } finally { process.chdir(cwd); }
  });

  test('env selects explicit storage even when recipe field is absent', async () => {
    const root = join(dir, 'override');
    const result = await prepareRecipeStartup({ source: file(), noRecipe: false, envDataDir: root });
    expect(result.dataDir).toBe(root);
    expect(existsSync(join(root, '.recipe.json'))).toBe(true);
  });

  test('fleet-style env root wins on resume too', async () => {
    const root = join(dir, 'child');
    saveRecipe(root, { ...base, dataDir: join(dir, 'other') });
    const result = await prepareRecipeStartup({ source: null, noRecipe: false, envDataDir: root });
    expect(result.mode).toBe('resumed');
    expect(result.dataDir).toBe(root);
    expect(existsSync(join(dir, 'other'))).toBe(false);
  });

  test('invalid recipe fails before creating storage', async () => {
    const path = file('state');
    writeFileSync(path, JSON.stringify({ ...base, dataDir: '', description: 'invalid' }));
    await expect(prepareRecipeStartup({ source: path, noRecipe: false, envDataDir: join(dir, 'override') })).rejects.toThrow(/dataDir/);
    expect(existsSync(join(dir, 'override'))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)('unwritable selected root fails without fallback', async () => {
    const root = join(dir, 'locked');
    mkdirSync(root);
    chmodSync(root, 0o500);
    try {
      await expect(prepareRecipeStartup({ source: file(root), noRecipe: false })).rejects.toThrow(/EACCES|EPERM/);
      expect(existsSync(join(dir, 'data'))).toBe(false);
    } finally { chmodSync(root, 0o700); }
  });

  test('file in place of selected directory fails without fallback', async () => {
    writeFileSync(join(dir, 'state'), 'not a directory');
    await expect(prepareRecipeStartup({ source: file('state'), noRecipe: false })).rejects.toThrow();
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });
});

test('real entrypoint: offline mock batch startup keeps snapshot, logs and sessions in recipe root', async () => {
  const cwd = join(dir, 'launch');
  mkdirSync(cwd);
  const path = file('state');
  writeFileSync(path, JSON.stringify({
    ...base, dataDir: 'state', description: '${DATA_DIR_TEST_SECRET}',
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
  }));
  // Deliberately no inherited credentials or host-config overrides. No .env
  // or MCPL configuration is present in this disposable cwd.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/index.ts'), path], {
    cwd, env: { PATH: process.env.PATH, DATA_DIR: '', DATA_DIR_TEST_SECRET: 'synthetic-secret' },
    stdin: new Blob(['hello\n']), stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Mock startup exited ${code}:\n${stdout}\n${stderr}`);
    expect(code).toBe(0);
    expect(stdout).toContain('Done.');
    const root = join(dir, 'state');
    expect(existsSync(join(cwd, 'data'))).toBe(false);
    const snapshot = readFileSync(join(root, '.recipe.json'), 'utf8');
    expect(JSON.parse(snapshot).dataDir).toBe(root);
    expect(snapshot).not.toContain('synthetic-secret');
    expect(snapshot).toContain('${DATA_DIR_TEST_SECRET}');
    const entries = readdirSync(root);
    expect(entries).toContain('sessions.json');
    expect(readdirSync(join(root, 'sessions')).length).toBeGreaterThan(0);
    expect(entries.some(name => name.startsWith('llm-calls.') && name.endsWith('.jsonl'))).toBe(true);
  } finally { clearTimeout(timer); child.kill(); await child.exited; }
}, 30_000);
