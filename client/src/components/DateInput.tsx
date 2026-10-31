import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref, type RefObject } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { addDaysIso, addMonthsIso, formatDateInput, formatDisplayDate, isValidIsoDate, MONTHS, parseDateInput, todayIso } from '@crafty/shared';
import { IconButton } from './ui';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const GAP = 6;
const EDGE = 8;

const SELECT =
  'rounded-lg border border-line-strong bg-surface-2 py-1.5 pl-2.5 pr-1.5 text-sm font-medium text-ink transition-colors focus:border-accent focus:outline-none';

const clamp = (iso: string, min?: string, max?: string) => (min && iso < min ? min : max && iso > max ? max : iso);

/**
 * A date field: type dd/mm/yyyy, or pick from the calendar. `value` is an ISO date, or '' for none.
 * While typing, onChange only hears complete dates; on leaving the field, what's shown is what's stored.
 * Touch devices only get the calendar, so no keyboard covers it.
 */
export function DateInput({
  id,
  value,
  onChange,
  onBlur,
  min,
  max,
  required,
  ref,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  min?: string;
  max?: string;
  required?: boolean;
  ref?: Ref<HTMLInputElement>;
}) {
  const [text, setText] = useState(() => formatDateInput(value));
  const [open, setOpen] = useState(false);
  const [focusCalendar, setFocusCalendar] = useState(false);
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);

  useEffect(() => {
    if ((parseDateInput(text) ?? '') !== value) setText(formatDateInput(value));
    // Only when the value changes from outside: while typing, the text is allowed to differ.
  }, [value]);

  // Forms that rely on the browser's own validation still need the range checked.
  const tooEarly = !!value && !!min && value < min;
  const tooLate = !!value && !!max && value > max;
  useEffect(() => {
    input.current?.setCustomValidity(
      tooEarly ? `Choose ${formatDisplayDate(min!)} or later` : tooLate ? `Choose ${formatDisplayDate(max!)} or earlier` : '',
    );
  }, [tooEarly, tooLate, min, max]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      input.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openCalendar = (focus: boolean) => {
    setFocusCalendar(focus);
    setOpen(true);
  };

  /** Settles the typed text. False when it wasn't a date, and goes back to the stored one. */
  const commitText = () => {
    if (!text.trim()) {
      if (value) onChange('');
      return true;
    }
    const parsed = parseDateInput(text);
    setText(formatDateInput(parsed ?? value));
    return parsed !== null;
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openCalendar(true);
    } else if (e.key === 'Enter') {
      if (!commitText() || open) e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      ref={wrapper}
      className="relative"
      onBlur={(e) => {
        if (e.relatedTarget && !wrapper.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <input
        ref={input}
        id={id}
        className="field tabular"
        placeholder="dd/mm/yyyy"
        autoComplete="off"
        required={required}
        readOnly={touch}
        aria-haspopup="dialog"
        aria-expanded={open}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseDateInput(e.target.value);
          if (parsed) onChange(parsed);
        }}
        onClick={() => openCalendar(false)}
        onKeyDown={onInputKeyDown}
        onBlur={() => {
          commitText();
          onBlur?.();
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Choose date"
        title="Choose date"
        className={`absolute inset-y-0 right-0 flex w-9 items-center justify-center transition-colors hover:text-accent-soft print:hidden ${open ? 'text-accent-soft' : 'text-muted'}`}
        onClick={() => (open ? setOpen(false) : openCalendar(!touch))}
      >
        <CalendarDays className="size-4" aria-hidden />
      </button>
      {open && (
        <Calendar
          anchor={wrapper}
          value={value}
          min={min}
          max={max}
          autoFocus={focusCalendar}
          onSelect={(iso) => {
            setText(formatDateInput(iso));
            onChange(iso);
            setOpen(false);
            input.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function Calendar({
  anchor,
  value,
  min,
  max,
  autoFocus,
  onSelect,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  value: string;
  min?: string;
  max?: string;
  autoFocus: boolean;
  onSelect: (iso: string) => void;
}) {
  const today = todayIso();
  const [cursor, setCursor] = useState(() => clamp(isValidIsoDate(value) ? value : today, min, max));
  const panel = useRef<HTMLDivElement>(null);
  const focusCursor = useRef(autoFocus);

  // The panel sits in the top layer, so no card or dialog can clip it.
  useLayoutEffect(() => {
    const el = panel.current!;
    el.showPopover();
    const place = () => {
      const box = anchor.current!.getBoundingClientRect();
      const { width, height } = el.getBoundingClientRect();
      const below = box.bottom + GAP;
      const above = box.top - GAP - height;
      el.style.top = `${below + height > window.innerHeight - EDGE && above >= EDGE ? above : below}px`;
      el.style.left = `${Math.max(EDGE, Math.min(box.left, window.innerWidth - width - EDGE))}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    if (isValidIsoDate(value)) setCursor(clamp(value, min, max));
  }, [value, min, max]);

  useEffect(() => {
    if (!focusCursor.current) return;
    focusCursor.current = false;
    panel.current?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)?.focus();
  }, [cursor]);

  const year = Number(cursor.slice(0, 4));
  const month = Number(cursor.slice(5, 7));
  const yearMonth = cursor.slice(0, 7);
  const monthAllowed = (ym: string) => (!min || ym >= min.slice(0, 7)) && (!max || ym <= max.slice(0, 7));

  const firstYear = Math.min(min ? Number(min.slice(0, 4)) : Number(today.slice(0, 4)) - 10, year);
  const lastYear = Math.max(max ? Number(max.slice(0, 4)) : Number(today.slice(0, 4)) + 1, year);
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);

  const firstOfMonth = `${yearMonth}-01`;
  const mondayOffset = (new Date(`${firstOfMonth}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDaysIso(firstOfMonth, -mondayOffset);
  const days = Array.from({ length: 42 }, (_, i) => addDaysIso(start, i));
  const weeks = Array.from({ length: 6 }, (_, i) => days.slice(i * 7, i * 7 + 7));

  const showMonth = (y: number, m: number) => {
    const day = Math.min(Number(cursor.slice(8)), new Date(Date.UTC(y, m, 0)).getUTCDate());
    setCursor(clamp(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, min, max));
  };

  const onGridKeyDown = (e: KeyboardEvent) => {
    const weekday = (new Date(`${cursor}T00:00:00Z`).getUTCDay() + 6) % 7;
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDaysIso(cursor, -1),
      ArrowRight: () => addDaysIso(cursor, 1),
      ArrowUp: () => addDaysIso(cursor, -7),
      ArrowDown: () => addDaysIso(cursor, 7),
      Home: () => addDaysIso(cursor, -weekday),
      End: () => addDaysIso(cursor, 6 - weekday),
      PageUp: () => addMonthsIso(cursor, -1),
      PageDown: () => addMonthsIso(cursor, 1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    focusCursor.current = true;
    setCursor(clamp(move(), min, max));
  };

  return (
    <div
      ref={panel}
      popover="manual"
      role="dialog"
      aria-label="Choose date"
      className="fixed inset-auto m-0 w-72 rounded-[var(--radius-card)] border border-line-strong bg-surface p-3 text-ink shadow-xl shadow-black/40 print:hidden"
    >
      <div className="mb-2 flex items-center justify-between gap-1">
        <IconButton label="Previous month" disabled={!monthAllowed(addMonthsIso(cursor, -1).slice(0, 7))} onClick={() => setCursor(clamp(addMonthsIso(cursor, -1), min, max))}>
          <ChevronLeft className="size-4" aria-hidden />
        </IconButton>
        <div className="flex items-center gap-1.5">
          <select aria-label="Month" className={SELECT} value={month} onChange={(e) => showMonth(year, Number(e.target.value))}>
            {MONTHS.map((name, i) => (
              <option key={name} value={i + 1} disabled={!monthAllowed(`${year}-${String(i + 1).padStart(2, '0')}`)}>
                {name}
              </option>
            ))}
          </select>
          <select aria-label="Year" className={`${SELECT} tabular`} value={year} onChange={(e) => showMonth(Number(e.target.value), month)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <IconButton label="Next month" disabled={!monthAllowed(addMonthsIso(cursor, 1).slice(0, 7))} onClick={() => setCursor(clamp(addMonthsIso(cursor, 1), min, max))}>
          <ChevronRight className="size-4" aria-hidden />
        </IconButton>
      </div>
      <div role="grid" aria-label={`${MONTHS[month - 1]} ${year}`} onKeyDown={onGridKeyDown}>
        <div role="row" className="grid grid-cols-7 gap-0.5">
          {WEEKDAYS.map((d) => (
            <div key={d} role="columnheader" className="flex h-8 items-center justify-center text-xs font-medium text-muted">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="mt-0.5 grid grid-cols-7 gap-0.5">
            {week.map((iso) => {
              const selected = iso === value;
              const allowed = clamp(iso, min, max) === iso;
              const tone = selected
                ? 'bg-accent/25 font-semibold text-accent-soft'
                : !allowed
                  ? 'cursor-not-allowed text-faint/50'
                  : iso.slice(0, 7) === yearMonth
                    ? 'text-ink hover:bg-surface-2'
                    : 'text-faint hover:bg-surface-2 hover:text-ink';
              return (
                <div key={iso} role="gridcell" aria-selected={selected}>
                  <button
                    type="button"
                    data-date={iso}
                    disabled={!allowed}
                    tabIndex={iso === cursor ? 0 : -1}
                    aria-label={formatDisplayDate(iso)}
                    aria-current={iso === today ? 'date' : undefined}
                    className={`tabular flex size-9 items-center justify-center rounded-lg text-sm transition-colors ${tone} ${iso === today && !selected ? 'ring-1 ring-inset ring-line-strong' : ''}`}
                    onClick={() => onSelect(iso)}
                  >
                    {Number(iso.slice(8))}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
