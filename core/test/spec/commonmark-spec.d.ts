/** `commonmark-spec` ships no types. The two exports it has, as `index.js` builds them. */
declare module 'commonmark-spec' {
  const spec: {
    readonly text: string;
    readonly tests: readonly { markdown: string; html: string; section: string; number: number }[];
  };
  export default spec;
}
