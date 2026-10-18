/**
 * Stub for `@atlaskit/media-svg/media-svg-error`.
 *
 * `@atlaskit/media-card` imports this subpath, but `@atlaskit/media-svg` does not expose it in its
 * `exports` map, so every bundler (esbuild, Rollup, Rolldown) fails to resolve it. Upstream
 * packaging bug.
 *
 * It renders an error placeholder for media that failed to load. draftgate never uploads media
 * through the editor, so a null component is enough. Both spellings, `MediaSVGError` and
 * `MediaSvgError`, are exported so an upstream rename does not break the build.
 */
const Noop = () => null;
export const MediaSVGError = Noop;
export const MediaSvgError = Noop;
export default Noop;
