import type { JSX } from 'react';
import { Check, Minus } from 'lucide-react';

/**
 * Project-styled checkbox. Native `<input type="checkbox">` is themed
 * via accent-color on most browsers but renders inconsistently on iOS
 * Safari (square OS box, no ink/border tone match). This component
 * paints a custom box that mirrors the rest of the UI's chrome:
 * border-border on idle, accent-on-accent when checked, with a Lucide
 * `Check` glyph in the panel color so it reads at every theme.
 *
 * Supports an `indeterminate` state for the table's master-select
 * header — operator can tell at a glance whether SOME / ALL / NONE of
 * the visible rows are picked. The Lucide `Minus` glyph renders the
 * tri-state mark.
 */
interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Stops the click from bubbling to the row's onClick handler. */
  stopPropagation?: boolean;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  disabled = false,
  stopPropagation = false,
  ariaLabel,
  size = 'sm',
}: CheckboxProps): JSX.Element {
  const dims = size === 'md' ? 'w-4 h-4' : 'w-[14px] h-[14px]';
  const iconSize = size === 'md' ? 12 : 10;
  const active = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={
        'inline-flex items-center justify-center rounded-[3px] border transition-colors shrink-0 ' +
        dims +
        ' ' +
        (active
          ? 'border-accent bg-accent text-panel'
          : 'border-border bg-panel text-transparent hover:border-ink/60') +
        (disabled ? ' opacity-40 cursor-not-allowed' : ' cursor-pointer')
      }
    >
      {indeterminate ? <Minus size={iconSize} strokeWidth={3} /> : checked ? <Check size={iconSize} strokeWidth={3} /> : null}
    </button>
  );
}
