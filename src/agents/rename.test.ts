import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RENAME_FILE_BYTES, renameRepositoryFile } from './rename.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-rename-'));
  roots.push(root);
  await writeFile(path.join(root, 'vitest.config.ts'), 'export default {};\n', { mode: 0o640 });
  return root;
}

describe('repository file rename', () => {
  it('moves an existing regular file without changing its content or permissions', async () => {
    const root = await fixture();
    const original = await stat(path.join(root, 'vitest.config.ts'));
    expect(await renameRepositoryFile(root, { source: 'vitest.config.ts', destination: 'vitest.config.mts' }))
      .toEqual({ source: 'vitest.config.ts', destination: 'vitest.config.mts' });
    await expect(stat(path.join(root, 'vitest.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'vitest.config.mts'), 'utf8')).toBe('export default {};\n');
    expect((await stat(path.join(root, 'vitest.config.mts'))).mode).toBe(original.mode);
  });

  it('supports nested paths and filenames containing spaces', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'src'));
    await renameRepositoryFile(root, { source: 'vitest.config.ts', destination: 'src/test config.mts' });
    expect(await readFile(path.join(root, 'src/test config.mts'), 'utf8')).toBe('export default {};\n');
  });

  it.each([
    '../outside.ts', '/tmp/outside.ts', 'src/../../outside.ts', './new.ts', 'src//new.ts',
    'src/../new.ts', 'C:\\outside.ts', 'src\\new.ts', 'new\nfile.ts', '', 'x'.repeat(501),
    '.git/config', '.claude/settings.json', '.mcp.json', '.env', 'src/.env.local',
    'src/credentials.json', 'secrets/private.ts', 'server.key', 'server.pem',
    'node_modules/file.ts', 'dist/file.ts', 'traces/file.ts', 'CLAUDE.md', 'AGENTS.md',
  ])('rejects unsafe source or destination %j without changing the source', async (unsafePath) => {
    const root = await fixture();
    for (const input of [
      { source: 'vitest.config.ts', destination: unsafePath },
      { source: unsafePath, destination: 'new.ts' },
    ]) await expect(renameRepositoryFile(root, input)).rejects.toThrow();
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });

  it('refuses to overwrite another file or move a directory', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'existing.ts'), 'keep me');
    await mkdir(path.join(root, 'src'));
    await expect(renameRepositoryFile(root, { source: 'vitest.config.ts', destination: 'existing.ts' })).rejects.toThrow('exists');
    await expect(renameRepositoryFile(root, { source: 'vitest.config.ts', destination: 'src' })).rejects.toThrow('exists');
    await expect(renameRepositoryFile(root, { source: 'src', destination: 'new.ts' })).rejects.toThrow('regular file');
    expect(await readFile(path.join(root, 'existing.ts'), 'utf8')).toBe('keep me');
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });

  it.skipIf(process.platform === 'win32')('rejects symlink files and parent directories, including links within the repository', async () => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(path.join(root, 'src'));
    await symlink(path.join(root, 'vitest.config.ts'), path.join(root, 'linked.ts'));
    await symlink(path.join(root, 'src'), path.join(root, 'linked-dir'));
    await symlink(outside, path.join(root, 'outside'));
    await expect(renameRepositoryFile(root, { source: 'linked.ts', destination: 'new.ts' })).rejects.toThrow('regular file');
    for (const destination of ['linked.ts', 'linked-dir/new.ts', 'outside/new.ts']) {
      await expect(renameRepositoryFile(root, { source: 'vitest.config.ts', destination })).rejects.toThrow();
    }
    await expect(renameRepositoryFile(root, { source: 'outside/vitest.config.ts', destination: 'new.ts' })).rejects.toThrow();
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
    expect(await readFile(path.join(outside, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });

  it('refuses missing files, missing parents, identical paths and oversized files', async () => {
    const root = await fixture();
    await expect(renameRepositoryFile(root, { source: 'missing.ts', destination: 'new.ts' })).rejects.toThrow();
    await expect(renameRepositoryFile(root, { source: 'vitest.config.ts', destination: 'missing/new.ts' })).rejects.toThrow();
    await expect(renameRepositoryFile(root, { source: 'vitest.config.ts', destination: 'vitest.config.ts' })).rejects.toThrow();
    await writeFile(path.join(root, 'large.ts'), Buffer.alloc(MAX_RENAME_FILE_BYTES + 1));
    await expect(renameRepositoryFile(root, { source: 'large.ts', destination: 'new.ts' })).rejects.toThrow('size limit');
  });

  it('refuses hard-linked sources and preserves files when renames compete for a destination', async () => {
    const root = await fixture();
    await link(path.join(root, 'vitest.config.ts'), path.join(root, 'alias.ts'));
    await expect(renameRepositoryFile(root, { source: 'alias.ts', destination: 'new.ts' })).rejects.toThrow('hard links');
    await writeFile(path.join(root, 'first.ts'), 'first');
    await writeFile(path.join(root, 'second.ts'), 'second');
    const results = await Promise.allSettled(['first.ts', 'second.ts'].map((source) =>
      renameRepositoryFile(root, { source, destination: 'new.ts' })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const moved = await readFile(path.join(root, 'new.ts'), 'utf8');
    const remaining = moved === 'first' ? 'second.ts' : 'first.ts';
    expect(await readFile(path.join(root, remaining), 'utf8')).toBe(moved === 'first' ? 'second' : 'first');
  });

  it('checks actual arguments instead of trusting the advertised tool schema', async () => {
    const root = await fixture();
    for (const input of [null, [], {}, { source: 42, destination: 'new.ts' },
      { source: 'vitest.config.ts', destination: 'new.ts', root: '/tmp' },
      { source: 'vitest.config.ts', destination: 'new.ts', command: 'rm' }]) {
      await expect(renameRepositoryFile(root, input)).rejects.toThrow('source and destination');
    }
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });
});
