# @briq-cloud/ai-sdk-sandbox

[![npm](https://img.shields.io/npm/v/@briq-cloud/ai-sdk-sandbox)](https://www.npmjs.com/package/@briq-cloud/ai-sdk-sandbox) [![ci](https://github.com/briq-cloud/ai-sdk-sandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/briq-cloud/ai-sdk-sandbox/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@briq-cloud/ai-sdk-sandbox)](LICENSE)

[briq](https://briq.cloud) sandboxes for the [AI SDK](https://ai-sdk.dev) harness. Each harness session runs its tools in its own briq sandbox: a microVM with a disk that stays while the sandbox exists.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { claudeCode } from '@ai-sdk/harness-claude-code';
import { createBriqNetworkSandboxSession } from '@briq-cloud/ai-sdk-sandbox';

const agent = new HarnessAgent({ harness: claudeCode, model: 'claude-sonnet-4-6' });

const sandboxSession = await createBriqNetworkSandboxSession({
  ports: [4000], // the port the harness's bridge listens on
  template: await agent.getSandboxTemplate(),
});
const session = await agent.createSession({ sandboxSession });
try {
  const { text } = await agent.generate({ session, prompt: 'Inspect this project.' });
  console.log(text);
} finally {
  await session.destroy();
  await sandboxSession.destroy();
}
```

The harness package, here `@ai-sdk/harness-claude-code`, says which ports it needs.

## Install

```sh
pnpm add @briq-cloud/ai-sdk-sandbox @ai-sdk/harness
```

## Sign in

Create an API key in the [briq dashboard](https://app.briq.cloud) and set it:

```sh
export BRIQ_API_KEY=...
```

Or pass `apiKey`. `BRIQ_API_URL` (or `baseUrl`) points at another briq API. A rejected key throws the harness's `HarnessSandboxAuthenticationError`.

## Create a sandbox

`createBriqNetworkSandboxSession(settings)` creates a sandbox and returns a network sandbox session.

| Setting | Default | |
| --- | --- | --- |
| `template` | none | A harness sandbox template. It runs once on the new sandbox. If it throws, the sandbox is destroyed. |
| `ports` | none | Ports the harness reaches. Declare each one here. |
| `size` | account default | `small`, `medium`, `large` or `xlarge`. Any other value throws `unsupported` before a request. |
| `name` | generated | Lowercase letters, digits and dashes, up to 32 characters. |
| `env` | none | Variables of the whole sandbox. See below. |
| `labels` | none | Labels shown on the sandbox in briq. |
| `commandTimeoutMs` | `600000` | The longest `run` waits for a command. |
| `apiKey`, `baseUrl` | environment | How to reach briq. |
| `stack` | `ai-sdk` | The briq stack the sandboxes live in. |
| `image` | the supported sandbox image | A custom image needs `bash` and `python3`. |
| `fetch` | global `fetch` | For tests or a proxy. |

Commands run in `/workspace`.

### Environment variables

`env` sets variables for the whole sandbox. briq stores them as encrypted values, and the API must allow that (`BRIQ_LITERAL_ENV_SECRETS_ENABLED` on the server). When it does not, the call throws `unsupported`. It never drops a variable silently. Pass `env` to `run` or `spawn` for one command instead when you can.

## Resume

```ts
import { resumeBriqNetworkSandboxSession } from '@briq-cloud/ai-sdk-sandbox';

const sandboxSession = await resumeBriqNetworkSandboxSession({ sandboxId: id });
```

A stopped sandbox is started. A sleeping one wakes on its first command. An id this package did not create, or a destroyed sandbox, fails with `not_found`.

`session.stop()` stops the sandbox and keeps its disk. `session.destroy()` deletes it. Destroy a sandbox when you are done: a sandbox that exists keeps its disk.

## Ports

`getPortEndpoint({ port })` returns the sandbox's private URL for a declared port. The access token is not in the URL. It is in `headers` as a `cookie`, which is how a harness opens a WebSocket (`protocol: 'ws'` gives a `wss` URL). briq serves HTTPS only. A port you did not declare throws `HarnessCapabilityUnsupportedError`.

## The provider form

`createBriqSandbox(settings)` returns a `HarnessV1SandboxProvider` for `HarnessAgent({ sandbox })`. The harness deprecates that setting. Prefer `createBriqNetworkSandboxSession`. The provider labels each sandbox with its harness session id, so `resumeSession` finds it.

## Supported

- Files: read, write, stat, list and delete, text and binary. Writing creates parent directories.
- `run` and `spawn` through `bash`, with a working directory and environment per command. `spawn` streams stdout and stderr, and `kill` stops the command.
- Ports through `getPortEndpoint`.
- Create, resume, stop and destroy.

## Not supported

- Network policy (`setNetworkPolicy`). A sandbox can reach the internet.
- Request transformations and `setPorts`. Declare ports when you create the sandbox.
- A caller-chosen sandbox id. briq assigns it. Use `name`.
- Writable stdin on `spawn`. Write a file and read it in the command.
- A snapshot per template. Each new sandbox runs the template again.
- Binary output from `run` and `spawn`. Output is text (UTF-8).
- A command of more than 128 KB, or an argument of more than 32 KB.
- A `spawn` that runs longer than one hour.

## Development

```sh
git clone https://github.com/briq-cloud/ai-sdk-sandbox
cd ai-sdk-sandbox
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

The tests mock the briq API and need no key.

Issues and pull requests: <https://github.com/briq-cloud/ai-sdk-sandbox/issues>.

## License

MIT
