import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await rm('.declarations', { recursive: true, force: true });
await mkdir('dist');
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@briq-cloud/sdk', '@ai-sdk/harness', '@ai-sdk/provider-utils'],
});
execFileSync('tsc', ['-p', 'tsconfig.json', '--emitDeclarationOnly'], { stdio: 'inherit' });
await cp('.declarations', 'dist', { recursive: true });
await rm('.declarations', { recursive: true, force: true });
