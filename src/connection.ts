import { HarnessSandboxAuthenticationError } from '@ai-sdk/harness';
import { Briq, BriqApiError, BriqOperationError, nativeSandbox } from '@briq-cloud/sdk';

export const BRIQ_PROVIDER_ID = 'briq';

/** The working directory of the default sandbox image. */
export const DEFAULT_WORKING_DIRECTORY = '/workspace';

/** How to reach briq. Every field is optional: the environment fills in what is missing. */
export type BriqConnectionSettings = {
  /** A briq API key. Default: `BRIQ_API_KEY`. */
  apiKey?: string;
  /** The API origin. Default: `BRIQ_API_URL`, else `https://api.briq.cloud`. */
  baseUrl?: string;
  /** The briq stack the sandboxes live in. Default: `ai-sdk`. */
  stack?: string;
  /**
   * The sandbox image. Default: the image `@briq-cloud/sdk` supports. A custom image needs `bash`
   * and `python3`.
   */
  image?: string;
  /** A custom `fetch`, for tests or a proxy. */
  fetch?: typeof fetch;
};

export type Connection = {
  backend: ReturnType<typeof nativeSandbox>;
  client: Briq;
};

const AUTH_MESSAGE =
  'briq rejected the API key or none was given. Pass `apiKey` or set BRIQ_API_KEY ' +
  '(a key from the briq dashboard).';

export function isAuthFailure(error: unknown): boolean {
  return (
    (error instanceof BriqOperationError && error.code === 'auth') ||
    (error instanceof BriqApiError && (error.status === 401 || error.status === 403))
  );
}

/** Turn a credentials failure into the error the harness expects; pass everything else through. */
export async function withBriqAuthentication<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isAuthFailure(error)) {
      throw new HarnessSandboxAuthenticationError({
        message: AUTH_MESSAGE,
        sandboxProviderId: BRIQ_PROVIDER_ID,
        cause: error,
      });
    }
    throw error;
  }
}

export function connect(settings: BriqConnectionSettings = {}): Connection {
  const apiKey = settings.apiKey ?? process.env.BRIQ_API_KEY ?? '';
  const baseUrl = settings.baseUrl ?? process.env.BRIQ_API_URL;
  const backend = nativeSandbox({
    apiKey,
    stack: settings.stack ?? 'ai-sdk',
    marker: 'briq/ai-sdk-sandbox',
    // `create` is the request alone; the first command is the harness's own.
    eagerChecks: false,
    ...(baseUrl ? { baseUrl } : {}),
    ...(settings.image ? { image: settings.image } : {}),
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
  });
  const client = new Briq(apiKey, {
    ...(baseUrl ? { baseUrl } : {}),
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
  });
  return { backend, client };
}
