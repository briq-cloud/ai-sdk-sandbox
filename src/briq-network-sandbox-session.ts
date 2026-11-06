import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1PortEndpoint,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import type { Briq } from '@briq-cloud/sdk';
import { BriqSandboxSession, type BriqSandboxSessionInput } from './briq-sandbox-session.js';
import { BRIQ_PROVIDER_ID } from './connection.js';

type Protocol = 'http' | 'https' | 'ws';

/** States in which the sandbox already answers, or wakes on the next command or visit. */
const IDLE_STATES = new Set(['stopped', 'stopping', 'sleeping', 'destroying', 'destroyed']);

/**
 * A briq sandbox as the harness's network sandbox session: the tool-safe surface plus its id,
 * ports, and lifecycle. The harness keeps one for the lifetime of a session.
 */
export class BriqNetworkSandboxSession
  extends BriqSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;
  readonly #client: Briq;
  readonly #input: BriqSandboxSessionInput;

  constructor(input: BriqSandboxSessionInput & { client: Briq }) {
    super(input);
    const { client, ...rest } = input;
    this.#client = client;
    this.#input = rest;
    this.id = input.id;
    this.defaultWorkingDirectory = input.workingDirectory;
    this.ports = input.ports ?? [];
  }

  restricted(): SandboxSession {
    return new BriqSandboxSession({ ...this.#input, ports: [] });
  }

  /**
   * The URL of an exposed port, from the sandbox's private URL. The token that guards it travels
   * in `headers`, so the URL stays clean. briq serves HTTPS only: `http` and `https` both give an
   * `https` URL, `ws` gives `wss`.
   */
  getPortEndpoint = async (options: {
    port: number;
    protocol?: Protocol;
  }): Promise<HarnessV1PortEndpoint> => {
    if (!this.ports.includes(options.port)) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: BRIQ_PROVIDER_ID,
        message: `Port ${options.port} is not exposed on this sandbox. Exposed ports: [${this.ports.join(', ')}]. Pass it in \`ports\` when you create the sandbox.`,
      });
    }
    const url = new URL(await this.privateUrl(options.port));
    const token = url.searchParams.get('briq_token');
    url.searchParams.delete('briq_token');
    url.protocol = options.protocol === 'ws' ? 'wss:' : 'https:';
    return {
      url: url.toString(),
      ...(token ? { headers: { cookie: `briq_token=${token}` } } : {}),
    };
  };

  /** @deprecated Use `getPortEndpoint`. The token stays in the URL's query. */
  getPortUrl = async (options: { port: number; protocol?: Protocol }): Promise<string> => {
    const url = new URL(await this.privateUrl(options.port));
    url.protocol = options.protocol === 'ws' ? 'wss:' : 'https:';
    return url.toString();
  };

  stop = async (): Promise<void> => {
    const { briq } = await this.#client.status(this.id);
    if (IDLE_STATES.has(briq.state)) return;
    await this.#client.stop(this.id);
  };

  destroy = async (): Promise<void> => {
    await this.backend.destroy(this.id);
  };

  /**
   * The URL of a port with its token. The first URL of a briq is its front door; the next ports
   * get their own (`additional`), so exposing one never moves another or restarts the machine.
   * Asking again for a port that has a URL keeps it, token included.
   */
  private async privateUrl(port: number): Promise<string> {
    const { briq } = await this.#client.status(this.id);
    const http = briq.endpoints.filter((endpoint) => (endpoint.protocol ?? 'http') === 'http');
    const existing = http.find((endpoint) => endpoint.port === port);
    if (
      existing &&
      (existing.mode === 'public' || new URL(existing.url).searchParams.has('briq_token'))
    ) {
      return existing.url;
    }
    const exposed = await this.#client.expose(
      this.id,
      port,
      existing?.mode ?? 'private',
      http.length > 0 ? { additional: true } : {},
    );
    return exposed.url;
  }
}
