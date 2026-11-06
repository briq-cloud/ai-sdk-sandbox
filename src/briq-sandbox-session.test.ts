import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BriqOperationError } from '@briq-cloud/sdk';
import { describe, expect, it, vi } from 'vitest';
import { BriqSandboxSession } from './briq-sandbox-session.js';
import type { Connection } from './connection.js';

type Backend = Connection['backend'];
type RunInput = Parameters<Backend['run']>[1];
type RunResult = { exitCode: number | null; timedOut: boolean };

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hasPython = spawnSync('python3', ['--version']).status === 0;

function session(overrides: Partial<Record<'run' | 'read' | 'write' | 'mkdir', unknown>> = {}) {
  const backend = {
    run: vi.fn(
      async (_id: string, _input: RunInput): Promise<RunResult> => ({
        exitCode: 0,
        timedOut: false,
      }),
    ),
    files: {
      read: vi.fn(async () => new TextEncoder().encode('one\ntwo\nthree\n')),
      write: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    },
    ...overrides,
  };
  return {
    backend,
    session: new BriqSandboxSession({
      backend: backend as unknown as Backend,
      id: 'bq_one',
      workingDirectory: '/workspace',
      ports: [4000],
    }),
  };
}

describe('files', () => {
  it('resolves relative paths against the working directory', async () => {
    const { backend, session: s } = session();
    await s.readBinaryFile({ path: 'src/../a.txt' });
    expect(backend.files.read).toHaveBeenCalledWith('bq_one', '/workspace/a.txt');
    await s.readBinaryFile({ path: '/etc/hosts' });
    expect(backend.files.read).toHaveBeenLastCalledWith('bq_one', '/etc/hosts');
  });

  it('answers null for a missing file, and rethrows other failures', async () => {
    const missing = session({
      files: {
        read: async () => {
          throw new BriqOperationError('file_not_found', 'no such file');
        },
      },
    });
    expect(await missing.session.readBinaryFile({ path: 'a' })).toBeNull();
    expect(await missing.session.readFile({ path: 'a' })).toBeNull();
    expect(await missing.session.readTextFile({ path: 'a' })).toBeNull();
    const broken = session({
      files: {
        read: async () => {
          throw new BriqOperationError('unavailable', 'down');
        },
      },
    });
    await expect(broken.session.readBinaryFile({ path: 'a' })).rejects.toThrow('down');
  });

  it('streams a file and reads a line range of a text file', async () => {
    const { session: s } = session();
    const stream = await s.readFile({ path: 'a' });
    const reader = stream?.getReader();
    const first = await reader?.read();
    expect(text(first?.value as Uint8Array)).toBe('one\ntwo\nthree\n');
    expect((await reader?.read())?.done).toBe(true);
    expect(await s.readTextFile({ path: 'a' })).toBe('one\ntwo\nthree\n');
    const range = await s.readTextFile({ path: 'a', startLine: 2, endLine: 2 });
    expect(range).toContain('two');
    expect(range).not.toContain('three');
  });

  it('creates the parent directory before it writes', async () => {
    const { backend, session: s } = session();
    await s.writeTextFile({ path: 'deep/dir/a.txt', content: 'héllo' });
    expect(backend.files.mkdir).toHaveBeenCalledWith('bq_one', '/workspace/deep/dir');
    const [id, path, content] = backend.files.write.mock.calls[0] as unknown as [
      string,
      string,
      Uint8Array,
    ];
    expect([id, path, text(content)]).toEqual(['bq_one', '/workspace/deep/dir/a.txt', 'héllo']);
    const order = [
      backend.files.mkdir.mock.invocationCallOrder[0],
      backend.files.write.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1] as number);
  });

  it('collects a stream into one write', async () => {
    const { backend, session: s } = session();
    const encoder = new TextEncoder();
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('ab'));
        controller.enqueue(encoder.encode('cd'));
        controller.close();
      },
    });
    await s.writeFile({ path: 'x', content });
    const written = backend.files.write.mock.calls[0] as unknown as [string, string, Uint8Array];
    expect(text(written[2])).toBe('abcd');
  });

  it('refuses an unknown text encoding and honors an aborted signal', async () => {
    const { backend, session: s } = session();
    await expect(s.writeTextFile({ path: 'x', content: 'a', encoding: 'nope' })).rejects.toThrow(
      'Unsupported text encoding',
    );
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      s.writeBinaryFile({ path: 'x', content: new Uint8Array(), abortSignal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(backend.files.write).not.toHaveBeenCalled();
  });
});

describe('path operations', () => {
  const answerWithPython = async (_id: string, input: RunInput): Promise<RunResult> => {
    const result = spawnSync(input.cmd[0] as string, input.cmd.slice(1), {
      input: input.stdin,
      encoding: 'utf8',
    });
    if (result.stdout) input.onChunk({ stream: 'stdout', text: result.stdout });
    if (result.stderr) input.onChunk({ stream: 'stderr', text: result.stderr });
    return { exitCode: result.status, timedOut: false };
  };

  it('asks for the path in JSON on stdin, never in the script', async () => {
    const { backend, session: s } = session({
      run: vi.fn(async (_id: string, input: RunInput): Promise<RunResult> => {
        input.onChunk({ stream: 'stdout', text: '{"value":{"type":"file","size":3}}\n' });
        return { exitCode: 0, timedOut: false };
      }),
    });
    expect(await s.stat({ path: "it's $(bad).txt" })).toEqual({ type: 'file', size: 3 });
    const input = (backend.run.mock.calls[0] as unknown as [string, RunInput])[1];
    expect(JSON.parse(input.stdin as string)).toEqual({
      op: 'stat',
      path: "/workspace/it's $(bad).txt",
    });
    expect(input.cmd.join(' ')).not.toContain('bad');
    expect(input.live).toBe(false);
  });

  it.skipIf(!hasPython)('stats, lists and deletes on a real file system', async () => {
    const root = mkdtempSync(join(tmpdir(), 'briq-ai-sdk-'));
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'a.txt'), 'abc');
    symlinkSync(join(root, 'a.txt'), join(root, 'link'));
    const { session: s } = session({ run: vi.fn(answerWithPython) });
    const at = (name: string) => join(root, name);

    expect(await s.stat({ path: at('a.txt') })).toEqual({ type: 'file', size: 3 });
    expect(await s.stat({ path: at('dir') })).toMatchObject({ type: 'directory' });
    expect(await s.stat({ path: at('link') })).toEqual({ type: 'file', size: 3 });
    expect(await s.stat({ path: at('missing') })).toBeNull();

    const entries = await s.listDirectory({ path: root });
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'a.txt', type: 'file' },
        { name: 'dir', type: 'directory' },
        { name: 'link', type: 'symlink' },
      ]),
    );
    expect(await s.listDirectory({ path: at('missing') })).toBeNull();
    await expect(s.listDirectory({ path: at('a.txt') })).rejects.toThrow('Not a directory');

    await expect(s.deleteFile({ path: at('dir') })).rejects.toThrow('Is a directory');
    expect(await s.deleteFile({ path: at('link') })).toBe(true);
    expect(await s.stat({ path: at('a.txt') })).not.toBeNull();
    expect(await s.deleteFile({ path: at('a.txt') })).toBe(true);
    expect(await s.deleteFile({ path: at('a.txt') })).toBe(false);
  });

  it('reports a failed script with its last stderr line', async () => {
    const { session: s } = session({
      run: vi.fn(async (_id: string, input: RunInput): Promise<RunResult> => {
        input.onChunk({ stream: 'stderr', text: 'trace\npython3: not found\n' });
        return { exitCode: 127, timedOut: false };
      }),
    });
    await expect(s.stat({ path: 'a' })).rejects.toThrow('could not stat a: python3: not found');
  });
});

describe('run', () => {
  it('runs through bash in the working directory and returns the output', async () => {
    const { backend, session: s } = session({
      run: vi.fn(async (_id: string, input: RunInput): Promise<RunResult> => {
        input.onChunk({ stream: 'stdout', text: 'out' });
        input.onChunk({ stream: 'stderr', text: 'err' });
        return { exitCode: 3, timedOut: false };
      }),
    });
    const result = await s.run({ command: 'echo "$A"', env: { A: '1' }, workingDirectory: 'sub' });
    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
    const input = (backend.run.mock.calls[0] as unknown as [string, RunInput])[1];
    expect(input).toMatchObject({
      cmd: ['bash', '-c', 'echo "$A"'],
      cwd: '/workspace/sub',
      env: { A: '1' },
      timeoutMs: 600_000,
      live: false,
    });
  });

  it('throws when the command times out', async () => {
    const { session: s } = session({
      run: vi.fn(async (): Promise<RunResult> => ({ exitCode: null, timedOut: true })),
    });
    await expect(s.run({ command: 'sleep 9' })).rejects.toThrow('did not finish');
  });
});

describe('spawn', () => {
  async function drain(stream: ReadableStream<Uint8Array>) {
    let out = '';
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out += text(value);
    }
  }

  it('streams stdout and stderr and resolves with the exit code', async () => {
    const { session: s } = session({
      run: vi.fn(async (_id: string, input: RunInput): Promise<RunResult> => {
        input.onChunk({ stream: 'stdout', text: 'a' });
        input.onChunk({ stream: 'stderr', text: 'b' });
        input.onChunk({ stream: 'stdout', text: 'c' });
        return { exitCode: 0, timedOut: false };
      }),
    });
    const process = await s.spawn({ command: 'x' });
    expect(await process.wait()).toEqual({ exitCode: 0 });
    expect(await drain(process.stdout)).toBe('ac');
    expect(await drain(process.stderr)).toBe('b');
  });

  it('kills the process through the signal and answers 137', async () => {
    const { session: s } = session({
      run: vi.fn(
        (_id: string, input: RunInput) =>
          new Promise<RunResult>((resolve) => {
            input.signal?.addEventListener('abort', () =>
              resolve({ exitCode: null, timedOut: false }),
            );
          }),
      ),
    });
    const process = await s.spawn({ command: 'sleep 99' });
    await process.kill();
    expect(await process.wait()).toEqual({ exitCode: 137 });
  });

  it('rejects wait with the reason of the caller abort', async () => {
    const { session: s } = session({
      run: vi.fn(
        (_id: string, input: RunInput) =>
          new Promise<RunResult>((resolve) => {
            input.signal?.addEventListener('abort', () =>
              resolve({ exitCode: null, timedOut: false }),
            );
          }),
      ),
    });
    const controller = new AbortController();
    const process = await s.spawn({ command: 'sleep 99', abortSignal: controller.signal });
    controller.abort(new Error('user stop'));
    await expect(process.wait()).rejects.toThrow('user stop');
  });

  it('errors both streams and wait when the command cannot run', async () => {
    const { session: s } = session({
      run: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    });
    const process = await s.spawn({ command: 'x' });
    await expect(process.wait()).rejects.toThrow('connection lost');
    await expect(drain(process.stdout)).rejects.toThrow('connection lost');
  });

  it('refuses a writable stdin before it starts anything', async () => {
    const { backend, session: s } = session();
    await expect(s.spawn({ command: 'cat', stdin: true })).rejects.toThrow('writable stdin');
    expect(backend.run).not.toHaveBeenCalled();
  });
});

describe('description', () => {
  it('names the sandbox, the directory and the ports', () => {
    const { session: s } = session();
    expect(s.description).toContain('bq_one');
    expect(s.description).toContain('/workspace');
    expect(s.description).toContain('4000');
  });
});
