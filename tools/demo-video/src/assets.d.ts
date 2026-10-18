/** Remotion's bundler serves an imported SVG as a URL. */
declare module '*.svg' {
  const url: string;
  export default url;
}
