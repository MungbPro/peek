import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, 'src/renderer'),
  base: './',
  envDir: resolve(projectRoot, 'src/renderer'),
  envPrefix: 'PEEK_PUBLIC_',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: resolve(projectRoot, 'dist/renderer'), emptyOutDir: true,
    rolldownOptions: { input: { overlay: resolve(projectRoot, 'src/renderer/index.html'), setup: resolve(projectRoot, 'src/renderer/setup.html') } },
  },
});
