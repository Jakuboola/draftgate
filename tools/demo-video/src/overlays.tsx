/**
 * What the demo draws on top of the real surfaces: the mouse pointer, the text caret, the click
 * ripple. Stand-ins for the operating system's own, drawn in screen pixels.
 */
export interface Point {
  x: number;
  y: number;
}

/** The macOS arrow, its hotspot at the tip; or the I-beam over text, its hotspot at the centre. */
export const Pointer = ({ at, kind, pressed }: { at: Point; kind: 'arrow' | 'ibeam'; pressed: boolean }) =>
  kind === 'arrow' ? (
    <svg
      width={28}
      height={40}
      viewBox="0 0 14 20"
      style={{ position: 'absolute', left: at.x - 2, top: at.y - 2, transform: pressed ? 'scale(0.9)' : undefined, transformOrigin: '2px 2px', filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))' }}
    >
      <path d="M1 1 L1 16 L4.6 12.6 L7.2 18.6 L9.6 17.6 L7.1 11.8 L12 11.8 Z" fill="#000" stroke="#fff" strokeWidth={1.1} strokeLinejoin="round" />
    </svg>
  ) : (
    <svg
      width={14}
      height={34}
      viewBox="0 0 7 17"
      style={{ position: 'absolute', left: at.x - 7, top: at.y - 17, filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.9))' }}
    >
      <path d="M1 1 Q3.5 1 3.5 3 L3.5 14 Q3.5 16 1 16 M6 1 Q3.5 1 3.5 3 M3.5 14 Q3.5 16 6 16" fill="none" stroke="#fff" strokeWidth={1.2} />
    </svg>
  );

export const Ripple = ({ at, progress }: { at: Point; progress: number }) =>
  progress <= 0 || progress >= 1 ? null : (
    <div
      style={{
        position: 'absolute',
        left: at.x - 22,
        top: at.y - 22,
        width: 44,
        height: 44,
        borderRadius: 22,
        border: '3px solid rgba(255,255,255,0.85)',
        transform: `scale(${0.4 + progress})`,
        opacity: 1 - progress,
      }}
    />
  );

export const Caret = ({ top, bottom, x, visible }: { top: number; bottom: number; x: number; visible: boolean }) =>
  visible ? <div style={{ position: 'absolute', left: x - 1, top, width: 2, height: bottom - top, background: '#f8f8f8' }} /> : null;

/** A macOS window's close, minimise and zoom buttons, from the window's left edge. */
export const TrafficLights = ({ left }: { left: number }) => (
  <div style={{ position: 'absolute', left, display: 'flex', gap: 8 }}>
    {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
      <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
    ))}
  </div>
);
