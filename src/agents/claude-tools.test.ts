import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeToolsConfig } from './claude.js';
import {
  createClaudeToolHandler,
  MAX_CLAUDE_RENAMES,
  MAX_TOOL_MESSAGE_BYTES,
  serveClaudeTools,
} from './claude-tools.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-claude-tools-'));
  roots.push(root);
  await writeFile(path.join(root, 'vitest.config.ts'), 'export default {};\n');
  return root;
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const rename = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
  name: 'rename_file', arguments: { source: 'vitest.config.ts', destination: 'vitest.config.mts' },
} };

describe('Claude private rename tool', () => {
  it('requires initialization, advertises only rename, and executes an initialized call', async () => {
    const root = await fixture();
    const handle = await createClaudeToolHandler(root);
    expect(await handle({ jsonrpc: '2.0', id: 0, method: 'server/discover' })).toMatchObject({ error: { code: -32601 } });
    expect(await handle(rename)).toMatchObject({ error: { code: -32002 } });
    expect(await handle(initialize)).toMatchObject({ id: 1, result: {
      protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'jev-files' },
    } });
    expect(await handle(initialized)).toBeUndefined();
    const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed?.result).toMatchObject({ tools: [{ name: 'rename_file', inputSchema: { additionalProperties: false } }] });
    expect((listed?.result as { tools: unknown[] }).tools).toHaveLength(1);
    expect(await handle(rename)).toMatchObject({ id: 3, result: { isError: false, content: [{ type: 'text' }] } });
    await expect(readFile(path.join(root, 'vitest.config.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'vitest.config.mts'), 'utf8')).toBe('export default {};\n');
  });

  it('returns bounded errors for unknown methods, tools and malformed arguments without executing', async () => {
    const root = await fixture();
    const handle = await createClaudeToolHandler(root);
    await handle(initialize);
    await handle(initialized);
    expect(await handle({ jsonrpc: '2.0', id: 4, method: 'shell', params: { command: 'rm' } })).toMatchObject({ error: { code: -32601 } });
    expect(await handle({ ...rename, params: { name: 'delete_file', arguments: {} } })).toMatchObject({ error: { code: -32602 } });
    expect(await handle({ ...rename, params: { name: 'rename_file', arguments: { ...rename.params.arguments, root: '/tmp' } } }))
      .toMatchObject({ result: { isError: true } });
    expect(await handle({ ...rename, params: { name: 'rename_file', arguments: { source: '.env', destination: 'new.ts' } } }))
      .toMatchObject({ result: { isError: true } });
    expect(await handle({ method: 'tools/call', id: 5 })).toMatchObject({ error: { code: -32600 } });
    expect(await handle({ ...rename, id: { injection: 'not an id' } })).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handle({ ...rename, id: undefined })).toBeUndefined();
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });

  it('retains a finite rename-attempt budget, including rejected requests', async () => {
    const handle = await createClaudeToolHandler(await fixture());
    await handle(initialize);
    await handle(initialized);
    const invalid = { ...rename, params: { name: 'rename_file', arguments: { source: '../outside', destination: 'new.ts' } } };
    for (let attempt = 0; attempt < MAX_CLAUDE_RENAMES; attempt += 1) {
      expect(await handle(invalid)).toMatchObject({ result: { isError: true } });
    }
    expect(await handle(rename)).toMatchObject({ result: { isError: true, content: [{ text: 'The rename-attempt limit has been reached.' }] } });
  });

  it('handles fragmented newline JSON and closes cleanly on stdin EOF', async () => {
    const root = await fixture();
    const frames = [initialize, initialized, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, rename];
    const wire = frames.map((frame) => JSON.stringify(frame) + '\n').join('');
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => { written += chunk.toString(); });
    await serveClaudeTools(root, Readable.from([wire.slice(0, 17), wire.slice(17, 101), wire.slice(101)]), output);
    const messages = written.trim().split('\n').map((line) => JSON.parse(line) as { id: number });
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(await readFile(path.join(root, 'vitest.config.mts'), 'utf8')).toBe('export default {};\n');
  });

  it('starts the generated development configuration from a different repository directory', async () => {
    const root = await fixture();
    const config = JSON.parse(buildClaudeToolsConfig(root)) as {
      mcpServers: { jev_files: { command: string; args: string[] } };
    };
    const server = config.mcpServers.jev_files;
    const result = spawnSync(server.command, server.args, {
      cwd: root,
      input: [initialize, initialized, rename].map((frame) => JSON.stringify(frame) + '\n').join(''),
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ id: 3, result: { isError: false } });
    expect(await readFile(path.join(root, 'vitest.config.mts'), 'utf8')).toBe('export default {};\n');
  });

  it('keeps initialization from resetting budgets and bounds malformed JSON and request counts', async () => {
    const root = await fixture();
    const handle = await createClaudeToolHandler(root);
    await handle(initialize);
    await handle(initialized);
    expect(await handle(initialize)).toMatchObject({ error: { code: -32600 } });
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => { written += chunk.toString(); });
    await serveClaudeTools(root, Readable.from(['{invalid json}\n']), output);
    expect(JSON.parse(written)).toMatchObject({ id: null, error: { code: -32700 } });
    const pings = Array.from({ length: 65 }, () => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n').join('');
    await expect(serveClaudeTools(root, Readable.from([pings]), new PassThrough())).rejects.toThrow('message limit');
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });

  it('rejects oversized frames and truncated requests without making edits', async () => {
    const root = await fixture();
    await expect(serveClaudeTools(root, Readable.from(['x'.repeat(MAX_TOOL_MESSAGE_BYTES + 1)]), new PassThrough())).rejects.toThrow('size limit');
    await expect(serveClaudeTools(root, Readable.from([JSON.stringify(initialize) + '\n', JSON.stringify(initialized) + '\n', JSON.stringify(rename)]), new PassThrough()))
      .rejects.toThrow('Incomplete');
    expect(await readFile(path.join(root, 'vitest.config.ts'), 'utf8')).toBe('export default {};\n');
  });
});
