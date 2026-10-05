import { realpath, stat } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { MAX_RENAME_PATH_LENGTH, RenameFileError, renameRepositoryFile } from './rename.js';

export const MAX_CLAUDE_RENAMES = 8;
export const MAX_TOOL_MESSAGE_BYTES = 16 * 1024;
const MAX_TOOL_MESSAGES = 64;
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

type JsonRpcId = string | number | null;
type ToolResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(id: JsonRpcId, code: number, message: string): ToolResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(id: JsonRpcId, text: string, isError: boolean): ToolResponse {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

export async function createClaudeToolHandler(root: string): Promise<(message: unknown) => Promise<ToolResponse | undefined>> {
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('The repository must be a directory.');
  let phase: 'new' | 'initializing' | 'ready' = 'new';
  let renameAttempts = 0;

  return async (message) => {
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return failure(null, -32600, 'Invalid request.');
    }
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      return undefined; // Notifications cannot execute tools.
    }
    if (!(typeof message.id === 'string' && message.id.length <= 100) &&
      !(typeof message.id === 'number' && Number.isSafeInteger(message.id))) {
      return failure(null, -32600, 'Invalid request id.');
    }
    const id = message.id;
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'initialize') {
      if (phase !== 'new') return failure(id, -32600, 'Already initialized.');
      if (typeof params.protocolVersion !== 'string') return failure(id, -32602, 'Missing protocol version.');
      phase = 'initializing';
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'jev-files', version: '1.0.0' },
      } };
    }
    if (message.method !== 'tools/list' && message.method !== 'tools/call') return failure(id, -32601, 'Unknown method.');
    if (phase !== 'ready') return failure(id, -32002, 'Initialize the tool connection first.');
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: [{
        name: 'rename_file',
        description: 'Rename one regular file within the approved repository. Supply source and destination paths relative to the repository. Existing destinations, symlinks, protected paths, directories and files over 1 MiB are refused. Use this instead of copying a file to simulate a rename.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', minLength: 1, maxLength: MAX_RENAME_PATH_LENGTH },
            destination: { type: 'string', minLength: 1, maxLength: MAX_RENAME_PATH_LENGTH },
          },
          required: ['source', 'destination'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      }] } };
    }
    if (params.name !== 'rename_file') return failure(id, -32602, 'Unknown tool.');
    if (renameAttempts >= MAX_CLAUDE_RENAMES) return toolResult(id, 'The rename-attempt limit has been reached.', true);
    renameAttempts += 1;
    try {
      const renamed = await renameRepositoryFile(canonicalRoot, params.arguments);
      return toolResult(id, JSON.stringify(renamed), false);
    } catch (error) {
      return toolResult(id, error instanceof RenameFileError ? error.message : 'The rename failed.', true);
    }
  };
}

/** A private stdio MCP endpoint: no listener, shell, file contents, or other tools. */
export async function serveClaudeTools(root: string, input: Readable, output: Writable): Promise<void> {
  const handle = await createClaudeToolHandler(root);
  let pending = Buffer.alloc(0);
  let messages = 0;
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline > MAX_TOOL_MESSAGE_BYTES) throw new Error('Tool message size limit exceeded.');
      const frame = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      if (frame.trim() === '') continue;
      messages += 1;
      if (messages > MAX_TOOL_MESSAGES) throw new Error('Tool message limit exceeded.');
      let response: ToolResponse | undefined;
      try {
        const message: unknown = JSON.parse(frame);
        response = await handle(message);
      } catch {
        response = failure(null, -32700, 'Invalid JSON.');
      }
      if (response && !output.write(`${JSON.stringify(response)}\n`)) await once(output, 'drain');
    }
    if (pending.length > MAX_TOOL_MESSAGE_BYTES) throw new Error('Tool message size limit exceeded.');
  }
  if (pending.length !== 0) throw new Error('Incomplete tool message.');
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) {
    process.stderr.write('The rename tool requires one approved repository root.\n');
    process.exitCode = 1;
  } else {
    void serveClaudeTools(root, process.stdin, process.stdout).catch(() => {
      process.stderr.write('The rename tool stopped after invalid input or a filesystem error.\n');
      process.exitCode = 1;
    });
  }
}
