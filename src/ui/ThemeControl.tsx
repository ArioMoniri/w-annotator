import { Monitor, Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { THEME_MODES, theme, type ThemeMode } from '../state/theme';

const ICONS: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const TIPS: Record<ThemeMode, string> = {
  light: 'Light appearance',
  dark: 'Dark appearance',
  system: 'Match system appearance',
};

/** Light, dark or system. `compact` shows icons only, for places where it should stay out of the way. */
export function ThemeControl({ compact = false }: { compact?: boolean }) {
  const mode = useSyncExternalStore(theme.subscribe, theme.mode);
  return (
    <div className="seg-control" role="group" aria-label="Appearance" data-compact={compact || undefined}>
      {THEME_MODES.map((o) => {
        const Icon = ICONS[o.value];
        return (
          <button
            key={o.value}
            aria-pressed={o.value === mode}
            aria-label={compact ? TIPS[o.value] : undefined}
            data-tip={compact ? TIPS[o.value] : undefined}
            data-tip-side={compact ? 'top' : undefined}
            data-tip-align={compact ? 'end' : undefined}
            data-theme-mode={o.value}
            onClick={() => theme.setMode(o.value)}
          >
            {compact ? <Icon size={14} aria-hidden /> : o.label}
          </button>
        );
      })}
    </div>
  );
}
