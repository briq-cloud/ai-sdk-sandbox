import {
  HarnessCapabilityUnsupportedError,
  HarnessSandboxAuthenticationError,
} from '@ai-sdk/harness';
import { describe, expect, it, vi } from 'vitest';
import {
  createBriqNetworkSandboxSession,
  createBriqSandbox,
  resumeBriqNetworkSandboxSession,
} from './briq-sandbox.js';

const IMAGE = 'ghcr.io/briq-cloud/sandbox:latest';
const MARKER = 'briq/ai-sdk-sandbox';

type Row = Record<string, unknown> & {
  id: string;
  state: string;
  ports: number[];
  endpoints: Array<{ port: number; mode: string; url: string; protocol?: string }>;
  labels: Record<string, string>;
};

type ApiBody = {
  stack?: string;
  port?: number;
  mode?: string;
  additional?: boolean;
  spec: Record<string, unknown> & { env: Record<string, { literal?: boolean; value?: string }> };
};

type Call = { method: string; path: string; query: URLSearchParams; body?: ApiBody };

/** A small fake of the briq API: one sandbox at a time, kept in `rows`. */
function api(options: { features?: Record<string, boolean>; authFails?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const calls: Call[] = [];
  let created = 0;
  const fetchFake = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const path = parsed.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, query: parsed.searchParams, body });
    if (options.authFails)
      return Response.json(
        { error: { code: 'unauthorized', message: 'bad key' } },
        { status: 401 },
      );
    if (path === '/v1/quota')
      return Response.json({
        features: { briqLabels: true, literalEnvSecrets: true, ...options.features },
        availableSizes: ['small', 'medium', 'large', 'xlarge'],
        team: { id: 'tm_owned' },
      });
    if (path === '/v1/briqs' && method === 'POST') {
      const id = `bq_${++created}`;
      const row: Row = {
        ...body.spec,
        id,
        teamId: 'tm_owned',
        state: 'running',
        endpoints: [],
        createdAt: '2026-11-06T00:00:00.000Z',
      };
      rows.set(id, row);
      return Response.json({ briqs: [row] });
    }
    if (path === '/v1/briqs' && method === 'GET') {
      return Response.json({ briqs: [...rows.values()], costLine: '' });
    }
    const match = /^\/v1\/briqs\/([^/]+)(?:\/(\w+))?$/.exec(path);
    const row = match?.[1] ? rows.get(match[1]) : undefined;
    if (!match || !row)
      return Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 });
    const action = match[2];
    if (method === 'DELETE') {
      row.state = 'destroyed';
      return Response.json({ briq: row });
    }
    if (action === 'stop') {
      row.state = 'stopped';
      return Response.json({ briq: row });
    }
    if (action === 'start') {
      row.state = 'starting';
      return Response.json({ briq: row });
    }
    if (action === 'expose') {
      const url = `https://${row.id}-${body.port}.briq.test/?briq_token=tok_${body.port}`;
      const endpoint = { port: body.port as number, mode: body.mode ?? 'private', url };
      row.endpoints = [...row.endpoints.filter((e) => e.port !== endpoint.port), endpoint];
      return Response.json({ id: `ep_${body.port}`, ...endpoint, hostname: 'x.briq.test' });
    }
    return Response.json({ briq: row, costLine: '' });
  });
  const settings = { apiKey: 'test-key', baseUrl: 'https://api.test', fetch: fetchFake };
  return {
    rows,
    calls,
    fetchFake,
    settings,
    paths: (method: string) => calls.filter((c) => c.method === method).map((c) => c.path),
  };
}

describe('createBriqNetworkSandboxSession', () => {
  it('creates one labeled briq in the ai-sdk stack without any other request', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession({
      ...fake.settings,
      ports: [4000],
      size: 'medium',
      name: 'my-agent',
      labels: { team: 'x' },
    });
    expect(session.id).toBe('bq_1');
    expect(session.ports).toEqual([4000]);
    expect(session.defaultWorkingDirectory).toBe('/workspace');
    const post = fake.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/v1/briqs');
    expect(post?.body.stack).toBe('ai-sdk');
    expect(post?.body.spec).toMatchObject({
      name: 'my-agent',
      image: IMAGE,
      size: 'medium',
      ports: [4000],
      env: {},
      labels: { team: 'x', [MARKER]: '1' },
    });
    // No quota read, no readiness command: `create` is the request alone.
    expect(fake.calls.map((c) => c.path)).toEqual(['/v1/briqs']);
  });

  it('gives a generated name when none is passed', async () => {
    const fake = api();
    await createBriqNetworkSandboxSession(fake.settings);
    expect(fake.calls[0]?.body.spec.name).toMatch(/^aisdk-[0-9a-f]{20}$/);
  });

  it('refuses a caller-chosen sandbox id before any request', async () => {
    const fake = api();
    await expect(
      createBriqNetworkSandboxSession({ ...fake.settings, sandboxId: 'mine' } as never),
    ).rejects.toThrow('assigns the sandbox id');
    expect(fake.fetchFake).not.toHaveBeenCalled();
  });

  it('refuses a size that briq does not have before any request', async () => {
    const fake = api();
    await expect(
      createBriqNetworkSandboxSession({ ...fake.settings, size: 'tiny' as never }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(fake.fetchFake).not.toHaveBeenCalled();
  });

  it('sends environment variables only when the server allows them', async () => {
    const allowed = api();
    await createBriqNetworkSandboxSession({ ...allowed.settings, env: { A: '1' } });
    expect(allowed.calls.find((c) => c.method === 'POST')?.body.spec.env.A).toMatchObject({
      literal: true,
      value: '1',
    });

    const refused = api({ features: { literalEnvSecrets: false } });
    await expect(
      createBriqNetworkSandboxSession({ ...refused.settings, env: { A: '1' } }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(refused.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('maps a rejected key to the harness authentication error', async () => {
    const fake = api({ authFails: true });
    await expect(createBriqNetworkSandboxSession(fake.settings)).rejects.toBeInstanceOf(
      HarnessSandboxAuthenticationError,
    );
  });

  it('prepares the template on the new sandbox and destroys it when that fails', async () => {
    const ok = api();
    const prepare = vi.fn(async () => {});
    await createBriqNetworkSandboxSession({
      ...ok.settings,
      template: { identity: 'tpl', prepare },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    const prepared = (prepare.mock.calls[0] as unknown as [{ session: Record<string, unknown> }])[0]
      .session;
    // The template sees the tool-safe surface, not the lifecycle.
    expect(typeof prepared.run).toBe('function');
    expect(prepared.destroy).toBeUndefined();
    expect(prepared.getPortEndpoint).toBeUndefined();

    const bad = api();
    await expect(
      createBriqNetworkSandboxSession({
        ...bad.settings,
        template: {
          identity: 'tpl',
          prepare: async () => {
            throw new Error('prepare failed');
          },
        },
      }),
    ).rejects.toThrow('prepare failed');
    expect(bad.paths('DELETE')).toEqual(['/v1/briqs/bq_1']);
    expect(bad.rows.get('bq_1')?.state).toBe('destroyed');
  });
});

describe('getPortEndpoint', () => {
  it('moves the token from the URL to a cookie header', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession({ ...fake.settings, ports: [4000] });
    const endpoint = await session.getPortEndpoint({ port: 4000 });
    expect(endpoint).toEqual({
      url: 'https://bq_1-4000.briq.test/',
      headers: { cookie: 'briq_token=tok_4000' },
    });
    const socket = await session.getPortEndpoint({ port: 4000, protocol: 'ws' });
    expect(socket.url).toBe('wss://bq_1-4000.briq.test/');
  });

  it('keeps the token in the query of the deprecated getPortUrl', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession({ ...fake.settings, ports: [4000] });
    expect(await session.getPortUrl?.({ port: 4000 })).toBe(
      'https://bq_1-4000.briq.test/?briq_token=tok_4000',
    );
  });

  it('refuses a port that was not declared', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession({ ...fake.settings, ports: [4000] });
    await expect(session.getPortEndpoint({ port: 5000 })).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
    expect(fake.paths('POST').filter((p) => p.endsWith('/expose'))).toEqual([]);
  });

  it('adds the next port as an additional URL and reuses one that exists', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession({
      ...fake.settings,
      ports: [4000, 4001],
    });
    await session.getPortEndpoint({ port: 4000 });
    await session.getPortEndpoint({ port: 4001 });
    await session.getPortEndpoint({ port: 4000 });
    const exposes = fake.calls.filter((c) => c.path.endsWith('/expose'));
    expect(exposes.map((c) => c.body)).toEqual([
      { port: 4000, mode: 'private' },
      { port: 4001, mode: 'private', additional: true },
    ]);
  });
});

describe('lifecycle', () => {
  it('stops a running sandbox once and leaves a stopped one alone', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession(fake.settings);
    await session.stop?.();
    await session.stop?.();
    expect(fake.paths('POST').filter((p) => p.endsWith('/stop'))).toHaveLength(1);
  });

  it('destroys the briq', async () => {
    const fake = api();
    const session = await createBriqNetworkSandboxSession(fake.settings);
    await session.destroy?.();
    expect(fake.rows.get('bq_1')?.state).toBe('destroyed');
  });
});

describe('resumeBriqNetworkSandboxSession', () => {
  it('reattaches to a running sandbox with its ports', async () => {
    const fake = api();
    await createBriqNetworkSandboxSession({ ...fake.settings, ports: [4000] });
    const resumed = await resumeBriqNetworkSandboxSession({ ...fake.settings, sandboxId: 'bq_1' });
    expect(resumed.id).toBe('bq_1');
    expect(resumed.ports).toEqual([4000]);
    expect(fake.paths('POST').filter((p) => p.endsWith('/start'))).toEqual([]);
  });

  it('starts a stopped sandbox and waits until it runs', async () => {
    vi.useFakeTimers();
    try {
      const fake = api();
      const session = await createBriqNetworkSandboxSession(fake.settings);
      await session.stop?.();
      const resumed = resumeBriqNetworkSandboxSession({ ...fake.settings, sandboxId: 'bq_1' });
      await vi.advanceTimersByTimeAsync(0);
      fake.rows.get('bq_1')!.state = 'running';
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await resumed).id).toBe('bq_1');
      expect(fake.paths('POST').filter((p) => p.endsWith('/start'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a briq this package did not create, and a destroyed one', async () => {
    const fake = api();
    fake.rows.set('bq_other', {
      id: 'bq_other',
      state: 'running',
      image: IMAGE,
      labels: {},
      ports: [],
      endpoints: [],
      createdAt: '2026-11-06T00:00:00.000Z',
    });
    await expect(
      resumeBriqNetworkSandboxSession({ ...fake.settings, sandboxId: 'bq_other' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const session = await createBriqNetworkSandboxSession(fake.settings);
    await session.destroy?.();
    await expect(
      resumeBriqNetworkSandboxSession({ ...fake.settings, sandboxId: session.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails for a sandbox in an error state', async () => {
    const fake = api();
    await createBriqNetworkSandboxSession(fake.settings);
    fake.rows.get('bq_1')!.state = 'error';
    await expect(
      resumeBriqNetworkSandboxSession({ ...fake.settings, sandboxId: 'bq_1' }),
    ).rejects.toThrow('error state');
  });
});

describe('createBriqSandbox (the provider form)', () => {
  it('creates a labeled sandbox, runs onFirstCreate on a restricted session, then resumes by session id', async () => {
    const fake = api();
    const provider = createBriqSandbox({ ...fake.settings, ports: [4000] });
    expect(provider.providerId).toBe('briq');
    const onFirstCreate = vi.fn(async () => {});
    const session = await provider.createSession({ sessionId: 'sess-1', onFirstCreate });
    expect(fake.calls.find((c) => c.method === 'POST')?.body.spec.labels).toMatchObject({
      'ai-sdk-session': 'sess-1',
    });
    const restricted = (onFirstCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(typeof restricted.run).toBe('function');
    expect(restricted.getPortEndpoint).toBeUndefined();

    const resumed = await provider.resumeSession({ sessionId: 'sess-1' });
    expect(resumed.id).toBe(session.id);
    await expect(provider.resumeSession({ sessionId: 'unknown' })).rejects.toThrow(
      'No briq sandbox for session unknown',
    );
  });

  it('destroys the sandbox when onFirstCreate fails', async () => {
    const fake = api();
    const provider = createBriqSandbox(fake.settings);
    await expect(
      provider.createSession({
        sessionId: 's',
        onFirstCreate: async () => {
          throw new Error('setup failed');
        },
      }),
    ).rejects.toThrow('setup failed');
    expect(fake.rows.get('bq_1')?.state).toBe('destroyed');
  });
});
