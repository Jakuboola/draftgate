/**
 * The destination's logo, top-left in the header: recognition before reading. All four are the
 * vendors' own artwork, unmodified (nominative use; a modified or redrawn mark is what causes
 * trouble), each with its own viewBox so nothing is rescaled.
 *
 *  - Jira and Linear: the official glyphs from `simple-icons` (CC0-1.0), verbatim, in each brand's colour.
 *  - GitHub: the `mark-github` Octicon, lifted verbatim off a served github.com page, keeping its own
 *    `currentColor` fill (see its entry).
 *  - Slack: the four-colour mark from Slack's Brand Center (`SLA-Slack-icon-RGB.svg`), eight paths on
 *    a 400x400 viewBox with the four colours inlined from the file's `<style>` block. Slack is absent
 *    from `simple-icons`, and its media kit permission is revocable, so this is the vendor's file.
 */

import { memo } from 'react';
import type { DestinationName } from '../../core/src/index';

interface Mark {
  /** The artwork's own coordinate system, not normalised. */
  viewBox: string;
  /** One entry per path. Multi-colour marks (Slack) carry a fill each. */
  paths: { d: string; fill: string }[];
}

const MARKS: Record<DestinationName, Mark> = {
  // simple-icons `jira.svg`, verbatim, in Atlassian blue.
  jira: {
    viewBox: '0 0 24 24',
    paths: [
      { fill: '#0052CC', d: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z' },
    ],
  },
  // simple-icons `linear.svg`, verbatim.
  linear: {
    viewBox: '0 0 24 24',
    paths: [
      { fill: '#5E6AD2', d: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z' },
    ],
  },
  // GitHub's `mark-github` Octicon, read off a served github.com page. `currentColor` is GitHub's own
  // fill and the only honest one: the mark is monochrome (black or white to suit the background), and
  // a fixed `#181717` would vanish in the dark palette.
  github: {
    viewBox: '0 0 24 24',
    paths: [
      { fill: 'currentColor', d: 'M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943' },
    ],
  },
  // Slack's official RGB icon, from their Brand Center. Four brand colours, eight paths.
  slack: {
    viewBox: '0 0 400 400',
    paths: [
      { fill: '#e3066a', d: 'M84.039,252.769c0,23.127-18.893,42.02-42.02,42.02S0,275.896,0,252.769s18.893-42.02,42.02-42.02h42.02v42.02Z' },
      { fill: '#e3066a', d: 'M105.212,252.769c0-23.127,18.893-42.02,42.02-42.02s42.02,18.893,42.02,42.02v105.212c0,23.127-18.893,42.02-42.02,42.02s-42.02-18.893-42.02-42.02c0,0,0-105.212,0-105.212Z' },
      { fill: '#00b3ff', d: 'M147.231,84.039c-23.127,0-42.02-18.893-42.02-42.02S124.104,0,147.231,0s42.02,18.893,42.02,42.02v42.02h-42.02Z' },
      { fill: '#00b3ff', d: 'M147.231,105.212c23.127,0,42.02,18.893,42.02,42.02s-18.893,42.02-42.02,42.02H42.02c-23.127,0-42.02-18.893-42.02-42.02s18.893-42.02,42.02-42.02c0,0,105.212,0,105.212,0Z' },
      { fill: '#41b658', d: 'M315.961,147.231c0-23.127,18.893-42.02,42.02-42.02s42.02,18.893,42.02,42.02-18.893,42.02-42.02,42.02h-42.02v-42.02Z' },
      { fill: '#41b658', d: 'M294.788,147.231c0,23.127-18.893,42.02-42.02,42.02s-42.02-18.893-42.02-42.02V42.02c0-23.127,18.893-42.02,42.02-42.02s42.02,18.893,42.02,42.02v105.212Z' },
      { fill: '#fcc003', d: 'M252.769,315.961c23.127,0,42.02,18.893,42.02,42.02s-18.893,42.02-42.02,42.02-42.02-18.893-42.02-42.02v-42.02h42.02Z' },
      { fill: '#fcc003', d: 'M252.769,294.788c-23.127,0-42.02-18.893-42.02-42.02s18.893-42.02,42.02-42.02h105.212c23.127,0,42.02,18.893,42.02,42.02s-18.893,42.02-42.02,42.02h-105.212Z' },
    ],
  },
};

/*
 * `memo` because the prop cannot change for the life of the window, while the component's parent
 * re-renders on every keystroke -- so Slack's eight-path pinwheel would be rebuilt and diffed to
 * no DOM change, per character typed.
 */
export const DestinationMark = memo(function DestinationMark({
  destination,
}: {
  destination: DestinationName;
}) {
  const mark = MARKS[destination];
  return (
    <svg
      className="dg-mark"
      viewBox={mark.viewBox}
      width="15"
      height="15"
      aria-hidden="true"
      focusable="false"
    >
      {mark.paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.fill} />
      ))}
    </svg>
  );
});
