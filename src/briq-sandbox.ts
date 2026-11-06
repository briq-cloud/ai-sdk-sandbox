import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';
import type { SandboxSize } from '@briq-cloud/sdk';
import { BriqOperationError } from '@briq-cloud/sdk';
import { BriqNetworkSandboxSession } from './briq-network-sandbox-session.js';
import { BriqSandboxSession } from './briq-sandbox-session.js';
import {
  BRIQ_PROVIDER_ID,
  type BriqConnectionSettings,
  type Connection,
  DEFAULT_WORKING_DIRECTORY,
  connect,
  withBriqAuthentication,
} from './connection.js';

/** What a new sandbox is made of. */
export type BriqSandboxCreationSettings = BriqConnectionSettings & {
  /** Machine size: `small`, `medium`, `large` or `xlarge`. Anything else is refused. */
  size?: SandboxSize;
  /** Ports the harness reaches through `getPortEndpoint`. The first one is the bridge's. */
  ports?: number[];
  /** The sandbox's name: lowercase letters, digits and dashes, up to 32 characters. */
  name?: string;
  /**
   * Environment variables of the whole sandbox. The briq API must allow literal values
   * (`BRIQ_LITERAL_ENV_SECRETS_ENABLED`); without that the call fails as unsupported. Pass
   * per-command variables to `run` and `spawn` instead when you can.
   */
  env?: Record<string, string>;
  /** Labels shown on the briq. */
  labels?: Record<string, string>;
  /** The longest a `run` waits for a command, in milliseconds. Default: 600000 (ten minutes). */
  commandTimeoutMs?: number;
};

export type BriqNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<BriqSandboxCreationSettings> & {
    /** briq assigns the id of a sandbox, so a caller-chosen `sandboxId` is refused. */
    sandboxId?: never;
  };

export type BriqNetworkSandboxSessionResumeOptions = HarnessV1SandboxSessionResumeOptions<
  BriqConnectionSettings & { commandTimeoutMs?: number }
>;

const START_WAIT_MS = 60_000;
const START_POLL_MS = 500;

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

/**
 * Create a briq sandbox and return it as a harness network sandbox session.
 *
 * ```ts
 * const sandboxSession = await createBriqNetworkSandboxSession({
 *   ports: [4000],
 *   template: await agent.getSandboxTemplate(),
 * });
 * const session = await agent.createSession({ sandboxSession });
 * ```
 *
 * A `template` is prepared once on the new sandbox. briq does not keep a snapshot per template, so
 * every new sandbox runs the preparation again.
 */
export async function createBriqNetworkSandboxSession(
  options: BriqNetworkSandboxSessionCreateOptions = {},
): Promise<HarnessV1NetworkSandboxSession> {
  const {
    template,
    abortSignal,
    sandboxId,
    size,
    ports,
    name,
    env,
    labels,
    commandTimeoutMs,
    ...connection
  } = options;
  if (sandboxId !== undefined) {
    throw new Error(
      'createBriqNetworkSandboxSession: briq assigns the sandbox id. Use `name` to name it.',
    );
  }
  abortSignal?.throwIfAborted();
  const { backend, client } = await withBriqAuthentication(() => connect(connection));
  const created = await withBriqAuthentication(() =>
    backend.create({
      name: name ?? `aisdk-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      labels: labels ?? {},
      ports: ports ?? [],
      ...(size !== undefined ? { size } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(abortSignal ? { signal: abortSignal } : {}),
    }),
  );
  const session = new BriqNetworkSandboxSession({
    backend,
    client,
    id: created.id,
    workingDirectory: DEFAULT_WORKING_DIRECTORY,
    ports: ports ?? [],
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
  });
  if (template !== undefined) {
    try {
      await template.prepare({
        session: plainSession({ backend, id: created.id, commandTimeoutMs }),
        ...(abortSignal ? { abortSignal } : {}),
      });
    } catch (error) {
      await session.destroy().catch(() => {});
      throw error;
    }
  }
  return session;
}

/**
 * Reattach to a sandbox made by `createBriqNetworkSandboxSession`. A stopped sandbox is started;
 * a sleeping one wakes on its first command. Fails with `not_found` for an id this package did
 * not create or that is gone.
 */
export async function resumeBriqNetworkSandboxSession(
  options: BriqNetworkSandboxSessionResumeOptions,
): Promise<HarnessV1NetworkSandboxSession> {
  const { sandboxId, abortSignal, commandTimeoutMs, ...connection } = options;
  abortSignal?.throwIfAborted();
  const { backend, client } = await withBriqAuthentication(() => connect(connection));
  // Refuses a briq this package did not make, and one that is destroyed.
  await withBriqAuthentication(() => backend.connect(sandboxId));
  let { briq } = await withBriqAuthentication(() => client.status(sandboxId));
  if (briq.state === 'stopped') {
    briq = (await withBriqAuthentication(() => client.start(sandboxId))).briq;
  }
  const until = Date.now() + START_WAIT_MS;
  while (briq.state === 'starting' || briq.state === 'creating') {
    if (Date.now() >= until) throw new Error(`The sandbox ${sandboxId} did not start in time.`);
    await wait(START_POLL_MS, abortSignal);
    briq = (await withBriqAuthentication(() => client.status(sandboxId))).briq;
  }
  if (briq.state === 'error') {
    throw new BriqOperationError('unavailable', `The sandbox ${sandboxId} is in an error state.`);
  }
  return new BriqNetworkSandboxSession({
    backend,
    client,
    id: briq.id,
    workingDirectory: DEFAULT_WORKING_DIRECTORY,
    ports: briq.ports,
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
  });
}

function plainSession(input: {
  backend: Connection['backend'];
  id: string;
  commandTimeoutMs: number | undefined;
}): BriqSandboxSession {
  return new BriqSandboxSession({
    backend: input.backend,
    id: input.id,
    workingDirectory: DEFAULT_WORKING_DIRECTORY,
    ...(input.commandTimeoutMs !== undefined ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
  });
}

/** The label that lets `resumeSession` find the sandbox of a harness session. */
const SESSION_LABEL = 'ai-sdk-session';

/** Settings of `createBriqSandbox`: how to reach briq and what to create. */
export type BriqSandboxSettings = BriqSandboxCreationSettings;

/**
 * The `HarnessV1SandboxProvider` form, for `HarnessAgent({ sandbox })`. The harness marks that
 * setting as deprecated in favor of passing a sandbox session to `createSession`; prefer
 * `createBriqNetworkSandboxSession`.
 */
export function createBriqSandbox(settings: BriqSandboxSettings = {}): HarnessV1SandboxProvider {
  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: BRIQ_PROVIDER_ID,
    createSession: async (options) => {
      const session = await createBriqNetworkSandboxSession({
        ...settings,
        labels: {
          ...settings.labels,
          ...(options?.sessionId ? { [SESSION_LABEL]: options.sessionId } : {}),
        },
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      if (options?.onFirstCreate) {
        try {
          await options.onFirstCreate(session.restricted(), {
            ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
          });
        } catch (error) {
          await Promise.resolve(session.destroy()).catch(() => {});
          throw error;
        }
      }
      return session;
    },
    resumeSession: async ({ sessionId, abortSignal }) => {
      const { backend } = await withBriqAuthentication(() => connect(settings));
      const [found] = await withBriqAuthentication(() =>
        backend.list({ [SESSION_LABEL]: sessionId }),
      );
      if (!found) throw new Error(`No briq sandbox for session ${sessionId}.`);
      return resumeBriqNetworkSandboxSession({
        ...settings,
        sandboxId: found.id,
        ...(abortSignal ? { abortSignal } : {}),
      });
    },
  };
}
