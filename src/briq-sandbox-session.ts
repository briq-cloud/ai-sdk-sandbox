import { posix } from 'node:path';
import {
  type Experimental_SandboxDeleteFileOptions as DeleteFileOptions,
  type Experimental_SandboxDirectoryEntry as DirectoryEntry,
  type Experimental_SandboxFileStat as FileStat,
  type Experimental_SandboxListDirectoryOptions as ListDirectoryOptions,
  type Experimental_SandboxReadBinaryFileOptions as ReadBinaryFileOptions,
  type Experimental_SandboxReadFileOptions as ReadFileOptions,
  type Experimental_SandboxReadTextFileOptions as ReadTextFileOptions,
  type Experimental_SandboxRunOptions as RunOptions,
  type Experimental_SandboxProcess as SandboxProcess,
  type Experimental_SandboxSession as SandboxSession,
  type Experimental_SandboxSpawnOptions as SpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin as SpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin as SpawnOptionsWithoutStdin,
  type Experimental_SandboxStatOptions as StatOptions,
  type Experimental_WritableSandboxProcess as WritableSandboxProcess,
  type Experimental_SandboxWriteBinaryFileOptions as WriteBinaryFileOptions,
  type Experimental_SandboxWriteFileOptions as WriteFileOptions,
  type Experimental_SandboxWriteTextFileOptions as WriteTextFileOptions,
  extractLines,
} from '@ai-sdk/provider-utils';
import { BriqOperationError } from '@briq-cloud/sdk';
import type { Connection } from './connection.js';

type Backend = Connection['backend'];

/** The longest a command runs on the stream; the API caps one command at an hour. */
const MAX_COMMAND_MS = 3_600_000;
/** The default limit of `run`. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
/** What a path operation may answer with: more is a directory too large to list. */
const METADATA_LIMIT_BYTES = 4 * 1024 * 1024;

// One-shot path operations. The path travels as JSON on stdin, never inside the script. `stat`
// follows symbolic links; `list` reports them as `symlink`; `delete` removes a link itself.
const PATH_SCRIPT = `
import json,os,stat,sys
r=json.load(sys.stdin)
p=r['path']
def kind(m):
 return 'file' if stat.S_ISREG(m) else 'directory' if stat.S_ISDIR(m) else 'other'
def out(v):
 print(json.dumps(v,ensure_ascii=True))
try:
 if r['op']=='stat':
  s=os.stat(p)
  out({'value':{'type':kind(s.st_mode),'size':s.st_size}})
 elif r['op']=='list':
  if not os.path.isdir(p):
   out({'error':'not_a_directory'})
  else:
   v=[]
   for n in os.listdir(p):
    m=os.lstat(os.path.join(p,n)).st_mode
    v.append({'name':n,'type':'symlink' if stat.S_ISLNK(m) else kind(m)})
   out({'value':v})
 elif r['op']=='delete':
  if os.path.isdir(p) and not os.path.islink(p):
   out({'error':'is_a_directory'})
  else:
   os.unlink(p)
   out({'value':True})
except (FileNotFoundError,NotADirectoryError):
 out({'value':None if r['op']!='delete' else False})
`;

export type BriqSandboxSessionInput = {
  backend: Backend;
  id: string;
  workingDirectory: string;
  ports?: ReadonlyArray<number>;
  commandTimeoutMs?: number;
};

type PathAnswer = { value?: unknown; error?: string };

/**
 * A briq sandbox as the AI SDK's tool-safe surface: files, `run` and `spawn`. It cannot stop the
 * sandbox or reach its ports, which is what `BriqNetworkSandboxSession.restricted()` relies on.
 */
export class BriqSandboxSession implements SandboxSession {
  protected readonly backend: Backend;
  protected readonly sandboxId: string;
  protected readonly workingDirectory: string;
  protected readonly commandTimeoutMs: number;
  protected readonly declaredPorts: ReadonlyArray<number>;

  constructor(input: BriqSandboxSessionInput) {
    this.backend = input.backend;
    this.sandboxId = input.id;
    this.workingDirectory = input.workingDirectory;
    this.declaredPorts = input.ports ?? [];
    this.commandTimeoutMs = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  get description(): string {
    return [
      `briq sandbox (id: ${this.sandboxId}).`,
      `Working directory: ${this.workingDirectory}.`,
      'Files and installed packages stay while the sandbox exists, including after it stops and resumes.',
      this.declaredPorts.length > 0
        ? `Exposed ports: ${this.declaredPorts.join(', ')}.`
        : 'No ports are exposed.',
    ].join('\n');
  }

  protected resolvePath(path: string): string {
    return posix.resolve(this.workingDirectory, path);
  }

  async readFile({
    path,
    abortSignal,
  }: ReadFileOptions): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile({ path, ...(abortSignal ? { abortSignal } : {}) });
    if (bytes === null) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async readBinaryFile({ path, abortSignal }: ReadBinaryFileOptions): Promise<Uint8Array | null> {
    abortSignal?.throwIfAborted();
    try {
      return await this.backend.files.read(this.sandboxId, this.resolvePath(path));
    } catch (error) {
      if (error instanceof BriqOperationError && error.code === 'file_not_found') return null;
      throw error;
    }
  }

  async readTextFile({
    path,
    encoding = 'utf-8',
    startLine,
    endLine,
    abortSignal,
  }: ReadTextFileOptions): Promise<string | null> {
    const bytes = await this.readBinaryFile({ path, ...(abortSignal ? { abortSignal } : {}) });
    if (bytes === null) return null;
    const text = new TextDecoder(encoding).decode(bytes);
    return extractLines({
      text,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    });
  }

  async writeFile({ path, content, abortSignal }: WriteFileOptions): Promise<void> {
    // The API takes a file whole, so the stream is collected first.
    const chunks: Uint8Array[] = [];
    const reader = content.getReader();
    for (;;) {
      abortSignal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await this.writeBinaryFile({
      path,
      content: Buffer.concat(chunks),
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  async writeBinaryFile({ path, content, abortSignal }: WriteBinaryFileOptions): Promise<void> {
    abortSignal?.throwIfAborted();
    const target = this.resolvePath(path);
    // Parent directories are created, as the interface requires.
    await this.backend.files.mkdir(this.sandboxId, posix.dirname(target));
    abortSignal?.throwIfAborted();
    await this.backend.files.write(this.sandboxId, target, content);
  }

  async writeTextFile({
    path,
    content,
    encoding = 'utf-8',
    abortSignal,
  }: WriteTextFileOptions): Promise<void> {
    if (!Buffer.isEncoding(encoding)) {
      throw new Error(`Unsupported text encoding: ${encoding}`);
    }
    await this.writeBinaryFile({
      path,
      content: Buffer.from(content, encoding),
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  async stat({ path, abortSignal }: StatOptions): Promise<FileStat | null> {
    const answer = await this.pathOperation('stat', path, abortSignal);
    return (answer.value as FileStat | null | undefined) ?? null;
  }

  async listDirectory({
    path,
    abortSignal,
  }: ListDirectoryOptions): Promise<Array<DirectoryEntry> | null> {
    const answer = await this.pathOperation('list', path, abortSignal);
    if (answer.error === 'not_a_directory') {
      // A missing path is `null`; an existing file is an error.
      if ((await this.stat({ path, ...(abortSignal ? { abortSignal } : {}) })) === null) {
        return null;
      }
      throw new Error(`Not a directory: ${path}`);
    }
    return (answer.value as Array<DirectoryEntry> | null | undefined) ?? null;
  }

  async deleteFile({ path, abortSignal }: DeleteFileOptions): Promise<boolean> {
    const answer = await this.pathOperation('delete', path, abortSignal);
    if (answer.error === 'is_a_directory') throw new Error(`Is a directory: ${path}`);
    return answer.value === true;
  }

  private async pathOperation(
    op: 'stat' | 'list' | 'delete',
    path: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<PathAnswer> {
    abortSignal?.throwIfAborted();
    let output = '';
    let stderr = '';
    const result = await this.backend.run(this.sandboxId, {
      cmd: ['python3', '-I', '-c', PATH_SCRIPT],
      cwd: '/',
      env: {},
      stdin: JSON.stringify({ op, path: this.resolvePath(path) }),
      timeoutMs: 30_000,
      live: false,
      ...(abortSignal ? { signal: abortSignal } : {}),
      onChunk: (chunk) => {
        if (chunk.stream === 'stderr') {
          stderr += chunk.text;
        } else {
          if (Buffer.byteLength(output) + Buffer.byteLength(chunk.text) > METADATA_LIMIT_BYTES) {
            throw new Error('The directory listing is too large');
          }
          output += chunk.text;
        }
      },
    });
    abortSignal?.throwIfAborted();
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`briq could not ${op} ${path}: ${stderr.trim().split('\n').pop() ?? ''}`);
    }
    return JSON.parse(output) as PathAnswer;
  }

  async run({ command, workingDirectory, env, abortSignal }: RunOptions): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    abortSignal?.throwIfAborted();
    let stdout = '';
    let stderr = '';
    const result = await this.backend.run(this.sandboxId, {
      cmd: ['bash', '-c', command],
      cwd: this.resolveDirectory(workingDirectory),
      env: env ?? {},
      timeoutMs: this.commandTimeoutMs,
      live: false,
      ...(abortSignal ? { signal: abortSignal } : {}),
      onChunk: (chunk) => {
        if (chunk.stream === 'stdout') stdout += chunk.text;
        else stderr += chunk.text;
      },
    });
    abortSignal?.throwIfAborted();
    if (result.timedOut || result.exitCode === null) {
      throw new Error(`The command did not finish within ${this.commandTimeoutMs} ms.`);
    }
    return { exitCode: result.exitCode, stdout, stderr };
  }

  spawn(options: SpawnOptionsWithStdin): Promise<WritableSandboxProcess>;
  spawn(options: SpawnOptionsWithoutStdin): Promise<SandboxProcess>;
  spawn(options: SpawnOptions): Promise<SandboxProcess | WritableSandboxProcess>;
  async spawn({
    command,
    workingDirectory,
    env,
    stdin,
    abortSignal,
  }: SpawnOptions): Promise<SandboxProcess | WritableSandboxProcess> {
    abortSignal?.throwIfAborted();
    if (stdin === true) {
      throw new Error(
        'briq sandboxes do not support writable stdin. Write a file and read it in the command.',
      );
    }
    const killer = new AbortController();
    const signal = abortSignal ? AbortSignal.any([abortSignal, killer.signal]) : killer.signal;
    const encoder = new TextEncoder();
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stdoutController = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stderrController = controller;
      },
    });
    const cwd = this.resolveDirectory(workingDirectory);
    let killed = false;
    const finished = this.backend
      .run(this.sandboxId, {
        cmd: ['bash', '-c', command],
        cwd,
        env: env ?? {},
        timeoutMs: MAX_COMMAND_MS,
        signal,
        onChunk: (chunk) => {
          const target = chunk.stream === 'stdout' ? stdoutController : stderrController;
          target.enqueue(encoder.encode(chunk.text));
        },
      })
      .then(
        (result) => {
          stdoutController.close();
          stderrController.close();
          return result;
        },
        (error) => {
          stdoutController.error(error);
          stderrController.error(error);
          throw error;
        },
      );
    const wait = finished.then((result) => {
      if (abortSignal?.aborted) throw abortSignal.reason;
      if (killed) return { exitCode: result.exitCode ?? 137 };
      if (result.timedOut || result.exitCode === null) {
        throw new Error('The process was stopped after the one-hour limit on a command.');
      }
      return { exitCode: result.exitCode };
    });
    // A process nobody waits on must not end the host with an unhandled rejection.
    wait.catch(() => {});
    return {
      stdout,
      stderr,
      wait: () => wait,
      kill: async () => {
        killed = true;
        killer.abort();
        await wait.catch(() => {});
      },
    };
  }

  private resolveDirectory(workingDirectory: string | undefined): string {
    return workingDirectory === undefined
      ? this.workingDirectory
      : this.resolvePath(workingDirectory);
  }
}
