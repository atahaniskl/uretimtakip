/**
 * DateField — elle yazılamayan, yalnızca takvimden seçilen tarih alanı.
 *
 * Neden native <input type="date"> değil:
 *   1. Native alan elle yazmaya izin veriyor (gün/ay/yıl bölmelerine rakam
 *      girilebiliyor) — hatalı/yanlış tarihler bu yolla giriyordu.
 *   2. Native alanın gösterim biçimi tarayıcı yerelinden gelir ve
 *      değiştirilemez; tr-TR'de "05.08.2026" olarak, ay RAKAMLA yazılır.
 *      Ayın yazıyla görünmesi (5 Ağustos 2026) native alanla mümkün değil.
 *
 * Bu yüzden tetikleyici salt-okunur bir düğme, seçim ise kendi takvim
 * panelimizden yapılır. Değer formatı dışarıya karşı native alanla AYNI
 * kalır ("YYYY-MM-DD"), böylece çağıran taraflarda başka bir değişiklik
 * gerekmez.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const WEEK_DAYS = ['PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT', 'PAZ'];

/** "YYYY-MM-DD" -> yerel Date. Doğrudan new Date(str) UTC olarak yorumlanıp
 *  negatif saat diliminde bir gün geriye kayabildiği için elle ayrıştırılır. */
const parseValue = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value || '').trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
};

const toValue = (date: Date): string => {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
};

/** "5 Ağustos 2026" — ay adı yazıyla, kullanıcının gördüğü biçim. */
const formatDisplay = (date: Date): string =>
  date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

const formatMonthTitle = (date: Date): string =>
  date.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Ayı kapsayan 6x7'lik ızgara; hafta Pazartesi başlar (WEEK_DAYS ile aynı). */
const buildMonthGrid = (anchor: Date): Date[] => {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
};

interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Bu tarihten önceki günler seçilemez ("YYYY-MM-DD"). */
  min?: string;
  /** Seçimi temizleme düğmesi gösterilsin mi (zorunlu alanlarda kapatılır). */
  clearable?: boolean;
  className?: string;
  id?: string;
}

export default function DateField({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  placeholder = 'Tarih seçin',
  min,
  clearable = true,
  className = '',
  id,
}: DateFieldProps) {
  const selected = useMemo(() => parseValue(value), [value]);
  const minDate = useMemo(() => (min ? parseValue(min) : null), [min]);
  const [isOpen, setIsOpen] = useState(false);
  const [viewDate, setViewDate] = useState<Date>(() => selected || new Date());
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Dışarıdan gelen değer değişince görünen ay da ona atlasın (ör. "Sistem
  // Önerisi" bir tarih yazdığında panel o ayı göstersin).
  useEffect(() => {
    if (selected) setViewDate(selected);
  }, [selected]);

  const openPanel = useCallback(() => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      // Panel `position: fixed` — tetikleyici kaydırılabilir bir modalın içinde
      // olabildiği için absolute konumlandırma paneli kırpardı. Alta sığmıyorsa
      // alanın üstüne açılır.
      const panelHeight = 340;
      const openUpwards = rect.bottom + panelHeight > window.innerHeight && rect.top > panelHeight;
      setAnchorRect({
        top: openUpwards ? rect.top - panelHeight - 6 : rect.bottom + 6,
        left: Math.min(rect.left, Math.max(8, window.innerWidth - 300)),
        width: rect.width,
      });
    }
    setViewDate(selected || new Date());
    setIsOpen(true);
  }, [disabled, selected]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Panel fixed konumlandığı için kaydırma/boyut değişiminde tetikleyiciden
    // kopar — bu durumda kapatmak, yanlış yerde asılı kalmasından iyidir.
    const onScrollOrResize = () => setIsOpen(false);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [isOpen]);

  const isDisabledDay = useCallback(
    (day: Date) => !!minDate && day < new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()),
    [minDate],
  );

  const pick = (day: Date) => {
    if (isDisabledDay(day)) return;
    onChange(toValue(day));
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const grid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const today = new Date();

  return (
    <>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => (isOpen ? setIsOpen(false) : openPanel())}
        className={`input-field flex items-center justify-between gap-2 text-left ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        } ${className}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span className={selected ? '' : 'text-surface-500'}>
          {selected ? formatDisplay(selected) : placeholder}
        </span>
        <svg className="w-4 h-4 flex-shrink-0 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3M5 11h14M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
        </svg>
      </button>

      {isOpen && anchorRect && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Tarih seç"
          className="date-picker-panel"
          style={{ top: anchorRect.top, left: anchorRect.left }}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              className="date-picker-nav"
              onClick={() => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
              aria-label="Önceki ay"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            {/* Ay ADIYLA yazılır — bu bileşenin var olma sebeplerinden biri. */}
            <span className="text-sm font-semibold text-surface-100 capitalize">{formatMonthTitle(viewDate)}</span>
            <button
              type="button"
              className="date-picker-nav"
              onClick={() => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
              aria-label="Sonraki ay"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEK_DAYS.map((d) => (
              <span key={d} className="text-[10px] text-center text-surface-500 py-1">{d}</span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((day) => {
              const inMonth = day.getMonth() === viewDate.getMonth();
              const isSelected = !!selected && sameDay(day, selected);
              const isToday = sameDay(day, today);
              const unavailable = isDisabledDay(day);
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  disabled={unavailable}
                  onClick={() => pick(day)}
                  className={`date-picker-day ${isSelected ? 'is-selected' : ''} ${
                    isToday && !isSelected ? 'is-today' : ''
                  } ${inMonth ? '' : 'is-outside'} ${unavailable ? 'is-disabled' : ''}`}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-surface-700/60">
            <button
              type="button"
              className="text-[11px] text-surface-400 hover:text-primary-300 transition-colors"
              onClick={() => pick(new Date())}
            >
              Bugün
            </button>
            {clearable && value && (
              <button
                type="button"
                className="text-[11px] text-surface-400 hover:text-red-400 transition-colors"
                onClick={() => {
                  onChange('');
                  setIsOpen(false);
                }}
              >
                Temizle
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
