import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';

await bundle({
  entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', target: 'node20', format: 'cjs',
  external: ['electron', 'koffi'], sourcemap: true,
});
await viteBuild();
