/**
 * Switch the preview between the OS theme, light and dark. There is no single destination theme (a
 * Jira comment is read in many), so the default is `system`: how the reviewer will see it. They can
 * check the other, because the recipient may be in it. The choice persists through the CLI
 * (`cli/src/themePreference.ts`).
 *
 * It goes through `resolveTheme`, never straight to `data-theme`: a choice is intersected with the
 * destination's measured palettes (all four declare both today, so a no-op for now). `App` owns the
 * intersection; this component owns the choice.
 */

import { memo } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { themeChoices, type SupportedThemes, type ThemeChoice } from '../../core/src/index';
import { ico } from './controls';

const FACE: Record<ThemeChoice, { icon: typeof Sun; label: string }> = {
  system: { icon: Monitor, label: 'following the system theme' },
  light: { icon: Sun, label: 'light' },
  dark: { icon: Moon, label: 'dark' },
};

interface ThemeToggleProps {
  value: ThemeChoice;
  /** From the profile, and read through `core` -- see `themeChoices`. */
  supported: SupportedThemes;
  onChange(next: ThemeChoice): void;
}

/*
 * `memo`: all three props are referentially stable for the life of the window (`supported` is the
 * profile's `as const` array, `onChange` a `useCallback([])`) while the header re-renders on every
 * keystroke. Same for `DestinationMark`.
 */
export const ThemeToggle = memo(function ThemeToggle({
  value,
  supported,
  onChange,
}: ThemeToggleProps) {
  // The offer rule lives in `core`, beside the clamp that uses the same field. Nothing to switch
  // between means nothing is drawn.
  const cycle = themeChoices(supported);
  if (cycle.length < 2) return null;

  const next = cycle[(cycle.indexOf(value) + 1) % cycle.length]!;
  const Icon = FACE[value].icon;

  return (
    <button
      type="button"
      className="dg-theme-toggle"
      // State and action, because a sun alone could mean "you are in light" or "switch to light".
      aria-label={`Preview theme: ${FACE[value].label}. Switch to ${FACE[next].label}.`}
      title={`Preview theme: ${FACE[value].label}. Click for ${FACE[next].label}.`}
      onClick={() => onChange(next)}
    >
      {ico(Icon, 15)}
    </button>
  );
});
