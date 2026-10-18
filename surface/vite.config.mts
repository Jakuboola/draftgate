import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds the review window into `surface/dist`, served by the host (`surface/host/draftgate.m`)
 * over the `draftgate://` scheme.
 *
 * `base: '/'` because the scheme's handler maps the URL path onto `dist`. Sourcemaps are off: they
 * would ship the whole of `core` as readable text into a window that renders untrusted content, and
 * they are not needed for a bundle that is rebuilt from source on demand.
 *
 * There is no dev server. Vite's dev mode serves modules that need `unsafe-eval`, and the window's
 * CSP does not grant it -- correctly. Iterate with `bun run build:surface`, which takes ~1s.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // One file each, so the scheme handler serves two assets and the CSP stays simple.
    modulePreload: false,
  },
  logLevel: 'warn',
});
