import { Composition } from 'remotion';
import { Demo } from './Demo';
import { DURATION, FPS } from './script';

/** 1920x1080: the size a README video is usually cut at, and the display `request.ts` sizes for. */
export const Root = () => (
  <Composition id="Demo" component={Demo} width={1920} height={1080} fps={FPS} durationInFrames={DURATION * FPS} />
);
