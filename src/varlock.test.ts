import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const temporaryDirectories: string[] = [];
const varlock = path.resolve('node_modules/varlock/bin/cli.js');
const cli = path.resolve('src/cli.ts');
const configurationModule = pathToFileURL(path.resolve('src/config.ts')).href;
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const credentialNames = ['AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTE_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_AI_API_KEY'];

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (credentialNames.includes(key) || ['JEV_PROVIDER', 'ROUTER_MODEL', 'OPENROUTE_MODEL'].includes(key) ||
      /^_*VARLOCK/u.test(key)) delete environment[key];
  }
  return { ...environment, VARLOCK_TELEMETRY_DISABLED: 'true' };
}

async function fixture(values = ''): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-varlock-'));
  temporaryDirectories.push(directory);
  await copyFile('.env.schema', path.join(directory, '.env.schema'));
  await mkdir(path.join(directory, '.varlock'));
  await copyFile('.varlock/config.json', path.join(directory, '.varlock/config.json'));
  // Synthetic values only; never read the checkout's local credential files.
  await writeFile(path.join(directory, '.env.local'), values);
  await writeFile(path.join(directory, 'package.json'), '{"name":"varlock-fixture"}');
  return directory;
}

async function invoke(directory: string, args: string[], environment = isolatedEnvironment()) {
  return run(process.execPath, [varlock, ...args], {
    cwd: directory, env: environment, timeout: 10_000, maxBuffer: 64 * 1024,
  }).then((result) => ({ ...result, exitCode: 0 }))
    .catch((error: { code: number; stdout: string; stderr: string }) => ({
      stdout: error.stdout, stderr: error.stderr, exitCode: error.code,
    }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Varlock environment tooling', () => {
  it('validates the schema without requiring credentials or loading local overrides', async () => {
    const directory = await fixture('JEV_PROVIDER=invalid-local-selector\n');
    const result = await invoke(directory, ['load', '--agent', '--path', '.env.schema']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ JEV_PROVIDER: 'typesafe' });
  });

  it('redacts every canonical credential and compatibility alias in diagnostics and child output', async () => {
    const secrets = credentialNames.map((_, index) => `synthetic-credential-${index}-never-log`);
    const directory = await fixture(credentialNames.map((key, index) => `${key}=${secrets[index]}`).join('\n'));
    const diagnostics = await invoke(directory, ['load', '--agent']);
    const child = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath, '-e',
      `for (const key of ${JSON.stringify(credentialNames)}) { console.log(process.env[key]); console.error(process.env[key]); }`,
    ]);
    expect(diagnostics.exitCode).toBe(0);
    expect(child.exitCode).toBe(0);
    for (const secret of secrets) {
      expect(diagnostics.stdout + diagnostics.stderr + child.stdout + child.stderr).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(diagnostics.stdout))).toEqual(expect.arrayContaining(credentialNames));
  });

  it.each([
    ['vercel', 'AI_GATEWAY_API_KEY', 'typesafe-ai/jev'],
    ['openrouter', 'OPENROUTER_API_KEY', 'typesafe/jev-1.13'],
    ['openrouter', 'OPENROUTE_API_KEY', 'typesafe/jev-1.13'],
    ['typesafe', 'TYPESAFE_API_KEY', 'jev-latest'],
    ['typesafe', 'TYPESAFE_AI_API_KEY', 'jev-latest'],
  ])('loads only a supplied %s credential through %s without a metadata blob', async (provider, key, model) => {
    const secret = 'synthetic-selected-credential';
    const directory = await fixture(`JEV_PROVIDER=${provider}\n${key}=${secret}\n`);
    const result = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath,
      '--import', tsxLoader, '--input-type=module', '-e',
      `const { resolveJevConfiguration } = await import(${JSON.stringify(configurationModule)});
const selected = resolveJevConfiguration();
console.log(JSON.stringify({ provider: selected.provider, model: selected.model,
  credentialMatches: selected.apiKey === ${JSON.stringify(secret)}, blobPresent: '__VARLOCK_ENV' in process.env }));`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ provider, model, credentialMatches: true, blobPresent: false });
    expect(result.stdout + result.stderr).not.toContain(secret);
  });

  it('lets process overrides win while preserving canonical-key and model precedence', async () => {
    const directory = await fixture('JEV_PROVIDER=typesafe\nOPENROUTE_API_KEY=synthetic-alias-key\nOPENROUTE_MODEL=typesafe/alias\n');
    const environment = { ...isolatedEnvironment(), JEV_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'synthetic-canonical-key', ROUTER_MODEL: 'typesafe/pinned' };
    const result = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath,
      '--import', tsxLoader, '--input-type=module', '-e',
      `const { resolveJevConfiguration } = await import(${JSON.stringify(configurationModule)});
const selected = resolveJevConfiguration();
console.log(JSON.stringify({ provider: selected.provider, model: selected.model,
  canonicalKey: selected.apiKey === 'synthetic-canonical-key' }));`,
    ], environment);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ provider: 'openrouter', model: 'typesafe/pinned', canonicalKey: true });
  });

  it.each([
    ['an unknown selector', 'JEV_PROVIDER=unknown'],
    ['an empty selector', 'JEV_PROVIDER=""'],
    ['an oversized model', `ROUTER_MODEL=${'x'.repeat(257)}`],
  ])('blocks child execution for %s', async (_name, values) => {
    const directory = await fixture(`${values}\n`);
    const marker = path.join(directory, 'executed');
    const result = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution');`,
    ]);
    expect(result.exitCode).not.toBe(0);
    await expect(access(marker)).rejects.toThrow();
  });

  it('runs a keyless offline mock through the environment wrapper', async () => {
    const directory = await fixture();
    const result = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath,
      '--import', tsxLoader, cli, directory, 'Inspect the synthetic fixture', '--mock', '--no-trace', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unexecuted', mode: 'mock', provider: 'mock' });
  });

  it('retains the selected-credential preflight for a keyless live invocation', async () => {
    const directory = await fixture();
    const result = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath,
      '--import', tsxLoader, cli, directory, 'Inspect the synthetic fixture', '--no-trace',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('TYPESAFE_API_KEY is required');
  });

  it('preserves nonzero child exit status', async () => {
    const directory = await fixture();
    const result = await invoke(directory, ['run', '--inject', 'vars', '--', process.execPath, '-e', 'process.exit(7);']);
    expect(result.exitCode).toBe(7);
  });
});
