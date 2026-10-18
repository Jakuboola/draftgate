import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { fileURLToPath } from 'node:url';

/**
 * Vite config for the jira-ruler's editor-core build.
 *
 * The aliases work around upstream atlaskit packaging bugs: each subpath is declared in its
 * package's `exports` map but the file is not shipped, so every bundler fails to resolve it. See
 * stubs/. A further 548 unresolvable paths are per-locale i18n files, loaded dynamically, which do
 * not block a build for a single locale.
 */
export default {
  // atlaskit's editor plugins import Node builtins ('events' for EventEmitter, and iconv-lite
  // pulls 'string_decoder'/'buffer') directly in browser code. Vite externalises those, so the
  // named imports fail. Electron could enable nodeIntegration instead, but polyfilling keeps the
  // renderer sandboxed.
  plugins: [react(), nodePolyfills({ include: ['events', 'buffer', 'string_decoder', 'process', 'util', 'stream'] })],
  base: './',
  resolve: {
    alias: {
      '@atlaskit/editor-plugin-toolbar-lists-indentation/src/ui/toolbar-components/TaskListMenuItem': fileURLToPath(new URL('./stubs/editor-plugin-toolbar-lists-indentation__src__ui__toolbar-components__TaskListMenuItem.ts', import.meta.url)),
      '@atlaskit/feature-gate-js-client/persistent-override-adapter': fileURLToPath(new URL('./stubs/feature-gate-js-client__persistent-override-adapter.ts', import.meta.url)),
      '@atlaskit/media-client/test-helpers': fileURLToPath(new URL('./stubs/media-client__test-helpers.ts', import.meta.url)),
      '@atlaskit/media-svg/media-svg-error': fileURLToPath(new URL('./stubs/media-svg__media-svg-error.ts', import.meta.url)),
      '@atlaskit/popper/src/popper': fileURLToPath(new URL('./stubs/popper__src__popper.ts', import.meta.url)),
      '@atlaskit/react-ufo/use-error-handler': fileURLToPath(new URL('./stubs/react-ufo__use-error-handler.ts', import.meta.url)),
      '@atlaskit/theme/typography': fileURLToPath(new URL('./stubs/theme__typography.ts', import.meta.url)),
      '@atlaskit/user-picker/option-to-selectable-option': fileURLToPath(new URL('./stubs/user-picker__option-to-selectable-option.ts', import.meta.url)),
    },
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 20000 },
};
