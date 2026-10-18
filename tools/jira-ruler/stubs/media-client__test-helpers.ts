/**
 * Stub for `@atlaskit/media-client/test-helpers`.
 *
 * The owning package's `exports` map lists this subpath but the file is absent, so every bundler
 * (esbuild, Rollup, Rolldown) fails to resolve it. Upstream packaging bug.
 *
 * The named exports are the ones the atlaskit tree imports from this path (grep the tree for
 * imports of it when atlaskit is upgraded).
 */
const Noop = () => null;
const noop = () => undefined;
export const createEmptyFileItem = noop;
export const createErrorFileState = noop;
export const createFileState = noop;
export const createMockedMediaApi = noop;
export const createProcessingFileItem = noop;
export const createUploadingFileState = noop;
export default Noop;
