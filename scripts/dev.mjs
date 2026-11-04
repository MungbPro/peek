import { context } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
let child;
let closing = false;
let restarting = false;
let restartTimer;
function launch() {
  child = spawn(electron, ['.'], {
    stdio: 'inherit', env: { ...process.env, PEEK_DEV_URL: 'http://127.0.0.1:5173' },
  });
  child.on('exit', () => { if (!closing && !restarting) void close(); });
}
function restart() {
  if (closing) return;
  if (!child || child.exitCode !== null) { launch(); return; }
  restarting = true;
  child.once('exit', () => { restarting = false; if (!closing) launch(); });
  child.kill();
}
const ctx = await context({
  entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts', 'setup-preload': 'src/main/setup-preload.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'koffi'],
  sourcemap: true,
  plugins: [{ name: 'restart-electron', setup(build) {
    build.onEnd(result => {
      if (!result.errors.length) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(restart, 120);
      }
    });
  } }],
});
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(restartTimer);
  child?.kill();
  await ctx.dispose();
  await server.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await ctx.watch();
console.log('Peek: renderer hot reload enabled; main/preload edits restart Electron.');
