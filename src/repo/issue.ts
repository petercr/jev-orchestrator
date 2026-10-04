import { interruptible, throwIfInterrupted, type ExecutionOptions } from '../cancellation.js';
import { redactSensitiveText } from '../logging/trace.js';
import { truncateText } from '../limits.js';
import type { IssueContext } from '../types.js';
import { isValidationScript, validationRequirementsFromText } from './validation.js';

export const ISSUE_TIMEOUT_MS = 10_000;
export const MAX_ISSUE_RESPONSE_BYTES = 64 * 1024;
export const MAX_ISSUE_BODY_LENGTH = 4_000;

export type GitHubIssue = { url: string; owner: string; repo: string; number: number };

class IssueReadError extends Error {}

export function parseGitHubIssue(task: string): GitHubIssue | undefined {
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]{1,100})\/issues\/([1-9][0-9]{0,9})(?:[?#][^\s]*)?$/u.exec(task.trim());
  if (!match?.[1] || !match[2] || !match[3] || ['.', '..'].includes(match[2])) return undefined;
  const number = Number(match[3]);
  return { owner: match[1], repo: match[2], number, url: `https://github.com/${match[1]}/${match[2]}/issues/${number}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isIssueContext(value: unknown): value is IssueContext {
  return isRecord(value) && Object.keys(value).every((key) => ['url', 'title', 'body', 'requestedValidationScripts', 'validationRequirementsTruncated', 'truncated'].includes(key)) &&
    typeof value.url === 'string' && parseGitHubIssue(value.url)?.url === value.url &&
    typeof value.title === 'string' && value.title.length <= 300 &&
    typeof value.body === 'string' && value.body.length <= MAX_ISSUE_BODY_LENGTH &&
    typeof value.truncated === 'boolean' && Array.isArray(value.requestedValidationScripts) &&
    (value.validationRequirementsTruncated === undefined || typeof value.validationRequirementsTruncated === 'boolean') &&
    value.requestedValidationScripts.length <= 8 && value.requestedValidationScripts.every((script) =>
      typeof script === 'string' && isValidationScript(script));
}

export async function readGitHubIssue(url: string, options: ExecutionOptions = {}): Promise<IssueContext> {
  throwIfInterrupted(options.signal);
  const issue = parseGitHubIssue(url);
  if (!issue || issue.url !== url) throw new IssueReadError('Only a canonical GitHub issue URL can be read.');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ISSUE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    const response = await interruptible(() => fetch(
      `https://api.github.com/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal,
      },
    ).then((response) => {
      if (signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throwIfInterrupted(signal);
      }
      return response;
    }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new IssueReadError('Unable to read this public GitHub issue. Provide its context through ASK_USER.');
    }
    if (!response.body) throw new IssueReadError('GitHub returned an empty issue response.');
    const reader = response.body.getReader();
    const abort = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await interruptible(() => reader.read(), signal);
        throwIfInterrupted(signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ISSUE_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new IssueReadError('GitHub issue response exceeds the bounded read limit.');
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      throw new IssueReadError('GitHub returned invalid issue data.');
    }
    const returnedIssue = isRecord(data) && typeof data.html_url === 'string' ? parseGitHubIssue(data.html_url) : undefined;
    if (!isRecord(data) || returnedIssue?.owner.toLowerCase() !== issue.owner.toLowerCase() ||
      returnedIssue.repo.toLowerCase() !== issue.repo.toLowerCase() || returnedIssue.number !== issue.number ||
      data.number !== issue.number || data.pull_request !== undefined ||
      typeof data.title !== 'string' || (data.body !== null && typeof data.body !== 'string')) {
      throw new IssueReadError('GitHub returned invalid issue data.');
    }
    const title = redactSensitiveText(data.title);
    const body = redactSensitiveText(data.body ?? '');
    const requestedValidation = validationRequirementsFromText(`${title}\n${body}`);
    return {
      url,
      title: truncateText(title, 300),
      body: truncateText(body, MAX_ISSUE_BODY_LENGTH),
      requestedValidationScripts: requestedValidation.scripts,
      ...(requestedValidation.truncated ? { validationRequirementsTruncated: true } : {}),
      truncated: title.length > 300 || body.length > MAX_ISSUE_BODY_LENGTH,
    };
  } catch (error) {
    throwIfInterrupted(options.signal);
    if (deadline.signal.aborted) throw new IssueReadError('GitHub issue read timed out.');
    // Fetch failures can contain URLs or headers; retain only local safe errors.
    if (error instanceof IssueReadError) throw error;
    throw new IssueReadError('GitHub issue read failed. Provide its context through ASK_USER.');
  } finally {
    clearTimeout(timer);
  }
}
