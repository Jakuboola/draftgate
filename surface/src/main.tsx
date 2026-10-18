/**
 * Renderer entry point.
 *
 * The four destination stylesheets are all imported and scoped under `[data-destination="..."]`,
 * which `App` sets on the root element: one bundle, one editor. Importing them all costs a couple
 * of kilobytes and removes the only asynchronous step from window startup.
 */

import { createRoot } from 'react-dom/client';
import { App } from './App';

/*
 * The destination typefaces, self-hosted and declared in `styles/fonts.css`, served from
 * `draftgate://` (the CSP's `font-src 'self'` allows it; no network).
 *
 * Naming a face in a sheet does not make it resolve: without the files every pane renders in the
 * system face while `getComputedStyle`'s `font-family` still reports the declared list. The files
 * must be the vendor's own build -- Slack serves Lato 2.015 (not the 1.104 most packages carry),
 * Linear a variable Inter -- and `tokens.test.ts` checks each against the vendor's. GitHub draws
 * comments in the system font (its declared Mona Sans is never loaded) and Jira's Atlassian Sans is
 * proprietary, so those two get none.
 */

import './styles/index';

const host = document.getElementById('root');
if (!host) throw new Error('the review window has no #root to mount into');
createRoot(host).render(<App />);
