/**
 * The message where it landed: a plain chat window, dark, with no vendor's logo or branding.
 *
 * The posted message is the editor's own final document, set inside a `.ProseMirror` box, so
 * draftgate's Slack stylesheet draws it exactly as the review window's preview did: the same Lato,
 * sizes, spacing and code style. "Sent using @Claude" uses the stylesheet's mention chip
 * (`.dg-mtok`). The frame around it (sidebar, header, composer) and the earlier messages, which are
 * blurred, are stand-ins.
 */
import type { CSSProperties } from 'react';
import { CHANNEL, SENDER } from './script';
import { TrafficLights } from './overlays';

export const CHAT_SIZE = { width: 1600, height: 920 };
const SIDEBAR = 250;
const TITLE_BAR = 36;

const ink = {
  pry: 'var(--dt_color-content-pry)',
  sec: 'var(--dt_color-content-sec)',
  ter: 'var(--dt_color-content-ter)',
  base: 'var(--dt_color-base-pry)',
  rule: 'rgba(232, 232, 232, 0.13)',
};
const sans: CSSProperties = { fontFamily: 'var(--sl-sans)', WebkitFontSmoothing: 'antialiased' };

/** Earlier messages: made up, and blurred so they read as a channel without being read. */
const EARLIER = [
  { name: 'Priya Nair', initials: 'PN', hue: 200, time: '13:52', lines: ['Card auth is back to normal on our side, thanks all'] },
  { name: 'Tom Becker', initials: 'TB', hue: 30, time: '14:05', lines: ['Seeing a spike of 500s on checkout, anyone else?', 'Started a couple of minutes ago'] },
  { name: 'Lena Ortiz', initials: 'LO', hue: 140, time: '14:12', lines: ['Yep, looking into it now'] },
];

/** Initials on a colour, or an emoji on a light tile. */
const Avatar = ({ initials, emoji, hue }: { initials?: string; emoji?: string; hue: number }) => (
  <div
    style={{
      width: 36,
      height: 36,
      borderRadius: 8,
      flex: 'none',
      background: emoji ? `hsl(${hue} 85% 82%)` : `hsl(${hue} 45% 42%)`,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: emoji ? '24px/1 sans-serif' : '700 14px var(--sl-sans)',
    }}
  >
    {emoji ?? initials}
  </div>
);

const Header = ({ name, time }: { name: string; time: string }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, ...sans }}>
    <span style={{ font: '900 15px var(--sl-sans)', color: ink.pry }}>{name}</span>
    <span style={{ fontSize: 12, color: ink.ter }}>{time}</span>
  </div>
);

interface ChatProps {
  /** The posted message's HTML: the review editor's final document. */
  html: string;
  style?: CSSProperties;
  /** Receives the posted message's box, for the camera. */
  messageRef?: (el: HTMLDivElement | null) => void;
}

export const Chat = ({ html, style, messageRef }: ChatProps) => (
  <div
    style={{
      ...CHAT_SIZE,
      borderRadius: 12,
      overflow: 'hidden',
      background: ink.base,
      boxShadow: '0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08)',
      display: 'flex',
      flexDirection: 'column',
      ...style,
    }}
  >
    <div style={{ height: TITLE_BAR, flex: 'none', background: '#141518', display: 'flex', alignItems: 'center', position: 'relative' }}>
      <TrafficLights left={14} />
    </div>
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ width: SIDEBAR, flex: 'none', background: '#141518', padding: '18px 12px', ...sans, color: ink.sec, fontSize: 15 }}>
        <div style={{ font: '900 18px var(--sl-sans)', color: ink.pry, padding: '0 10px 18px', filter: 'blur(5px)' }}>Example Shop</div>
        {['general', 'deploys', CHANNEL, 'incidents', 'random'].map((c) => (
          <div
            key={c}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              background: c === CHANNEL ? 'rgba(255,255,255,0.12)' : undefined,
              color: c === CHANNEL ? ink.pry : ink.sec,
              fontWeight: c === CHANNEL ? 700 : 400,
              filter: c === CHANNEL ? undefined : 'blur(4px)',
            }}
          >
            # {c}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ height: 52, flex: 'none', borderBottom: `1px solid ${ink.rule}`, display: 'flex', alignItems: 'center', padding: '0 20px', ...sans }}>
          <span style={{ font: '900 18px var(--sl-sans)', color: ink.pry }}># {CHANNEL}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 0 12px' }}>
          {EARLIER.map((m) => (
            <div key={m.name} style={{ display: 'flex', gap: 10, padding: '8px 20px', filter: 'blur(6px)', opacity: 0.7 }}>
              <Avatar initials={m.initials} hue={m.hue} />
              <div>
                <Header name={m.name} time={m.time} />
                <div className="ProseMirror">
                  {m.lines.map((l) => (
                    <p key={l}>{l}</p>
                  ))}
                </div>
              </div>
            </div>
          ))}
          <div ref={messageRef} style={{ display: 'flex', gap: 10, padding: '8px 20px' }}>
            <Avatar emoji={SENDER.avatar} hue={48} />
            <div style={{ minWidth: 0 }}>
              <Header name={SENDER.name} time={SENDER.time} />
              <div className="ProseMirror" dangerouslySetInnerHTML={{ __html: html }} />
              <div className="ProseMirror">
                <p>
                  <strong style={{ color: ink.sec }}>Sent using</strong> <span className="dg-mtok">@Claude</span>
                </p>
              </div>
            </div>
          </div>
        </div>
        <div style={{ flex: 'none', margin: '0 20px 20px', border: `1px solid ${ink.rule}`, borderRadius: 8, height: 86, padding: '12px 14px', ...sans, color: ink.ter, fontSize: 15 }}>
          Message #{CHANNEL}
        </div>
      </div>
    </div>
  </div>
);
