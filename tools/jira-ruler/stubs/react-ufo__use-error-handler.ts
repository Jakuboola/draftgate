/**
 * Stub for `@atlaskit/react-ufo/use-error-handler`.
 *
 * The owning package's `exports` map lists this subpath but the file is absent, so every bundler
 * (esbuild, Rollup, Rolldown) fails to resolve it. Upstream packaging bug.
 *
 * The named exports are the ones the atlaskit tree imports from this path (grep the tree for
 * imports of it when atlaskit is upgraded).
 */
const Noop = () => null;
const noop = () => undefined;
export const useUFOReportError = noop;
export default Noop;
