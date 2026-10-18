/**
 * The last frames: draftgate's mark and its name, on black.
 *
 * The mark is the app icon itself (`surface/icon/draftgate.svg`), so there is one logo file. The
 * name is set in Inter, the review window's own UI face (`surface/src/styles/fonts.css`), so it
 * needs no font of its own.
 */
import { Easing, Img, interpolate } from 'remotion';
import { clamp } from './motion';
import logo from '../../../surface/icon/draftgate.svg';

export const EndCard = ({ t, start, end }: { t: number; start: number; end: number }) => {
  if (t < start) return null;
  const fade = interpolate(t, [start, end], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  // Black first, then the mark, then the name a beat after it.
  const mark = interpolate(t, [end, end + 0.5], [0, 1], { ...clamp, easing: Easing.out(Easing.back(1.5)) });
  const name = interpolate(t, [end + 0.35, end + 0.85], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#0b0b0c',
        opacity: fade,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 36,
      }}
    >
      <Img src={logo} style={{ width: 300, height: 300, transform: `scale(${0.85 + 0.15 * mark})`, opacity: mark }} />
      <div
        style={{
          font: "700 84px/1 'Inter Variable', sans-serif",
          letterSpacing: '-0.03em',
          color: '#f5f5f4',
          opacity: name,
          transform: `translateY(${(1 - name) * 16}px)`,
        }}
      >
        draftgate
      </div>
    </div>
  );
};
