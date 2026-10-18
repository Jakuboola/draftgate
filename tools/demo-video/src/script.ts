/**
 * The demo's script: when each beat happens, in seconds of video, and what the reviewer types.
 *
 * One place, so a retimed beat moves everything keyed to it: the camera, the cursor, the edits and
 * the scene cuts all read these numbers. The storyboard it follows is on the issue that tracks the
 * video.
 */
import draft from '../draft.json';

export const FPS = 30;
export const DURATION = 32;

export const T = {
  // Terminal: the whole screen, then in on the prompt box; the prompt is typed and sent, the agent
  // answers, the review starts.
  zoomTerm: 1.2,
  zoomTermEnd: 2.2,
  typeStart: 2.4,
  typeEnd: 6.2,
  sent: 6.5,
  posting: 7.1,
  calling: 7.6,
  answered: 8.1,
  // The review window pops up over the terminal, and holds so the draft can be read.
  pop: 9.0,
  popEnd: 9.35,
  zoomIn: 10.5,
  zoomInEnd: 11.4,
  // Edit 1: select the three padding bullets and delete them.
  toBullets: 11.6,
  dragStart: 12.4,
  dragEnd: 13.2,
  deleteBullets: 13.6,
  // Edit 2: a greeting on a new first line.
  toTop: 14.0,
  clickTop: 14.7,
  newLine: 14.9,
  greetStart: 15.1,
  greetEnd: 17.6,
  // Edit 3: the last line.
  toLast: 18.0,
  selectHasStart: 18.6,
  selectHasEnd: 18.9,
  deleteHas: 19.1,
  toLineEnd: 19.3,
  clickLineEnd: 19.75,
  suffixStart: 19.85,
  suffixEnd: 21.1,
  // Approve.
  zoomOut: 21.8,
  zoomOutEnd: 22.6,
  toApprove: 22.4,
  click: 23.4,
  close: 23.7,
  closeEnd: 24.0,
  // Slide to the chat app's desktop.
  slide: 25.3,
  slideEnd: 26.2,
  chatZoom: 26.8,
  chatZoomEnd: 27.8,
  // The end card: the mark and the name.
  endCard: 29.2,
  endCardEnd: 29.9,
} as const;

export const GREETING = 'Hello my beautiful payments people, your HELP is NEEDED! 🆘';
/** Typed after the last line once its first word is gone. */
export const SUFFIX = ' 🙏 RCA according to 🤖';
/** The last line's first word and its space, selected and deleted. */
export const LAST_LINE_CUT = 'Has ';
/** The draft's bullets to delete, 0-based: the fourth to the sixth. */
export const PADDING = { first: 3, last: 5 };

/** What the operator types in the terminal, and the agent's first words back (`draft.json`). */
export const PROMPTS = draft.prompts;
export const REPLY = draft.reply;

/** The person who sent it, in the chat scene. Made up: a payments pun, and the debugging duck. */
export const SENDER = { name: 'Penny Ledger', avatar: '🦆', time: '14:31' };
export const CHANNEL = 'help-payments';
