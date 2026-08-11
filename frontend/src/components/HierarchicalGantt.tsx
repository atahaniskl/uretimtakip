import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Fragment, type ReactNode } from 'react';
import api from '../lib/api';
import { STAGE_LABELS } from '../lib/stageLabels';
import { useAppearanceSettings } from '../lib/appearanceSettings';
import { matchesTaskTextFilters, type TaskTextFilter } from '../lib/taskFilters';
import CalendarHeader from './CalendarHeader';

const DAY_MS = 86400000;
const DAY_WIDTH = 32;
const ROW_HEIGHT_STAGE = 36;
const ROW_HEIGHT_SPLIT = 40;
const ROW_HEIGHT_ORDER = 44;
const TREE_INDENT = 24;
const MONTH_COL_WIDTH = 88;
const ORDER_LABEL_WIDTH = 260;
const MIN_MONTH_LABEL_HEIGHT = 70;

const STAGE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  supply:     { bg: '#10b981', fg: '#ffffff', border: '#059669' },
  assembly:   { bg: '#3b82f6', fg: '#ffffff', border: '#2563eb' },
  production: { bg: '#f59e0b', fg: '#ffffff', border: '#d97706' },
  test:       { bg: '#8b5cf6', fg: '#ffffff', border: '#7c3aed' },
  delivery:   { bg: '#06b6d4', fg: '#ffffff', border: '#0891b2' },
};
const DEFAULT_BAR_COLOR = { bg: '#6b7280', fg: '#ffffff', border: '#4b5563' };
// Fason (dış dizgi) dizgi barı — pembe. DİKKAT: eskiden amber (#f59e0b) idi,
// yani Üretim adımıyla BİREBİR aynı renkti; bar'larda ikisi ayırt edilemiyordu.
// Diğer beş adım rengine (yeşil/mavi/amber/mor/camgöbeği) uzak olsun diye pembe
// seçildi — bkz. STAGE_LEGEND_ITEMS, artık açıklamada da kendi satırı var.
const FASON_BAR_COLOR = { bg: '#ec4899', fg: '#ffffff', border: '#db2777' };

export function getStageBarColor(stageKey: string, isOutsourced?: boolean) {
  const key = stageKey.toLowerCase();
  if (key === 'assembly' && isOutsourced) return FASON_BAR_COLOR;
  return STAGE_COLORS[key] || DEFAULT_BAR_COLOR;
}


const MONTH_LABELS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const MONTH_LABELS_LONG = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

const STAGE_ORDER = ['supply', 'assembly', 'production', 'test', 'delivery'];

// Alttaki renk açıklamasının (legend) TEK kaynağı — Dikey ve Yatay görünümlerin
// ikisi de bunu kullanır (ikisi de bu bileşendir, bkz. orientation prop'u),
// böylece açıklama (renk, etiket, sıra) kendiliğinden aynı kalır. Fason, ayrı
// bir adım değil "dış kaynaklı Dizgi" olduğu için Dizgi'nin hemen ardından gelir.
export const STAGE_LEGEND_ITEMS: { key: string; isOutsourced?: boolean }[] = [
  { key: 'supply' },
  { key: 'assembly' },
  { key: 'assembly', isOutsourced: true },
  { key: 'production' },
  { key: 'test' },
  { key: 'delivery' },
];

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(year: number): Date {
  return new Date(year, 0, 1);
}

function getDaysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function getMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(date);
}

function getYearLabel(year: number): string {
  return String(year);
}

function formatDateRange(start: Date, end: Date): string {
  return `${start.getDate()} ${MONTH_LABELS[start.getMonth()]} - ${end.getDate()} ${MONTH_LABELS[end.getMonth()]}`;
}

function parseTaskDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw.substring(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeText(text: string): string {
  return String(text || '')
    .replace(/^Teslimat\s*[—-]\s*/i, '')
    .replace(/^Otomatik\s+Teslimat\s*[—-]\s*/i, '')
    .trim();
}

export function getStageLabel(stageKey: string, isOutsourced = false): string {
  const key = stageKey.toLowerCase();
  // Fason (dış dizgi): dizgi adımı dış firmada yapılır.
  if (key === 'assembly' && isOutsourced) return 'Fason (Dış Dizgi)';
  return STAGE_LABELS[key] || stageKey;
}

function getSplitRootFromId(taskId: string): string {
  const id = String(taskId);
  const m = id.match(/^(split_[a-f0-9-]+)/i);
  return m ? m[1] : id;
}

// Sağ panelde açık olan görevle AYNI parçalı teslimata (split) ait bar'ları
// bulmak için — bkz. DeliveryCalendarPage.tsx içindeki aynı isimli fonksiyon.
function getHighlightScopeId(taskId: string): string | null {
  const id = String(taskId);
  if (id.startsWith('split_fake_')) return `order:${id.slice('split_fake_'.length)}`;
  if (id.startsWith('split_')) return `split:${getSplitRootFromId(id).slice('split_'.length)}`;
  if (id.startsWith('order_')) return `order:${id.slice('order_'.length)}`;
  return null;
}

function hasSplitIdFormat(taskId: string): boolean {
  return /^split_/i.test(String(taskId));
}

// Grup vurgusu sınıfı — ana sipariş mavi, alt ürün (BOM bileşeni) kehribar.
// Özet takvim ve Yatay Timeline ile aynı ayrım (bkz. index.css).
function groupHighlightClass(isHighlighted: boolean, isComponent: boolean): string {
  if (!isHighlighted) return '';
  return isComponent ? 'is-group-highlighted-component' : 'is-group-highlighted-main';
}

// Bir aşamanın, siparişin alt ürünlerinden (BOM bileşeni) birine mi ait olduğu.
function isComponentSplit(order: OrderData, split: SplitData): boolean {
  return order.components.some((c) => c.id === split.id);
}

function renderStageIcon(stageKey: string): React.ReactNode {
  const normalizedKey = String(stageKey || '').trim().toLowerCase();
  switch (normalizedKey) {
    case 'delivery':
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      );
    case 'supply':
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      );
    case 'assembly':
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    case 'production':
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      );
    case 'test':
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      );
    default:
      return <span className="w-3.5 h-3.5 flex-shrink-0" />;
  }
}

interface StageData {
  id: string;
  stageKey: string;
  stageLabel: string;
  startDate: Date;
  endDate: Date;
  deliveryDate: Date;
  isOutsourced?: boolean;
}

interface SplitData {
  id: string;
  productType: string;
  quantity: number;
  deliveryDate: Date;
  stages: StageData[];
  overallStart: Date;
  overallEnd: Date;
}

interface OrderData {
  id: string;
  externalId: string;
  orderText: string;
  customerName: string;
  splits: SplitData[];
  components: SplitData[];
  overallStart: Date;
  overallEnd: Date;
  isExplicitSplit: boolean;
}

interface MonthBucket {
  monthIndex: number;
  monthLabel: string;
  orders: OrderData[];
}

interface MonthRow {
  type: 'month';
  id: string;
  label: string;
  depth: number;
  orderNo: string;
  monthLabel: string;
}

interface OrderRow {
  type: 'order';
  id: string;
  label: string;
  depth: number;
  orderNo: string;
  monthLabel?: string;
  order: OrderData;
}

interface SplitRow {
  type: 'split';
  id: string;
  label: string;
  depth: number;
  orderNo: string;
  splitId: string;
  monthLabel?: string;
  order: OrderData;
  split: SplitData;
}

interface StageRow {
  type: 'stage';
  id: string;
  label: string;
  depth: number;
  orderNo: string;
  splitId: string;
  monthLabel?: string;
  order: OrderData;
  split: SplitData;
  stage: StageData;
}

type DisplayRow = MonthRow | OrderRow | SplitRow | StageRow;

function AnimatedCollapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: open ? '1fr' : '0fr',
        transition: 'grid-template-rows 0.3s ease',
      }}
    >
      <div style={{ overflow: 'hidden', minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

interface HierarchicalGanttProps {
  zoomLevel: 'monthly' | 'yearly';
  refreshKey: number;
  taskTextFilters: TaskTextFilter[];
  customerFilter: string;
  onTaskClick?: (taskId: string) => void;
  headerExtra?: ReactNode;
  /** Verilirse header'ın sağında "+ Teslimat" düğmesi çizilir (yetki kontrolü çağıranda). */
  onCreateDelivery?: () => void;
  highlightScopeId?: string | null;
  /** 'vertical' = mevcut Dikey görünüm (aylık ızgara / yıllık ay kovaları).
   *  'horizontal' = aynı sol ağaç paneli + KESİNTİSİZ yatay zaman ekseni;
   *  her satır tek bir bara aittir, zoomLevel burada eksenin yakınlaştırmasını
   *  belirler (Aylık = geniş/detaylı, Yıllık = sıkışık). */
  orientation?: 'vertical' | 'horizontal';
  /** Resmi tatiller (YYYY-MM-DD) — yatay eksende çalışılmayan günleri boyar. */
  holidayKeySet?: Set<string>;
}

// --- Yatay (kesintisiz eksen) görünüm sabitleri ---
const H_DAY_WIDTH_MONTHLY = 34;
const H_DAY_WIDTH_YEARLY = 10;
// Gün numaraları bu genişliğin altında okunaksız olur; onun yerine ayın
// birkaç sabit günü (5/10/15/20/25/30) kılavuz olarak yazılır.
const H_DAY_LABEL_MIN_WIDTH = 16;
const H_PAD_DAYS_MONTHLY = 45;
const H_PAD_DAYS_YEARLY = 120;
const H_RULER_MONTH_H = 22;
const H_RULER_DAY_H = 20;
const H_RULER_H = H_RULER_MONTH_H + H_RULER_DAY_H;
const H_DAY_MARKERS = [5, 10, 15, 20, 25, 30];

// Yatay görünümün yakınlaştırma kademeleri — gün başına piksel genişliğini
// (H_DAY_WIDTH_MONTHLY/YEARLY) çarpar. Sürekli/serbest bir değer yerine sabit
// kademeler: her tıklama öngörülebilir bir adım atar ve "yarım piksel" gibi
// bulanık genişlikler oluşmaz. Gün SAYISI değişmediği için DOM eleman sayısı
// zoom'dan etkilenmez, yalnızca genişlik ölçeklenir.
const H_ZOOM_STEPS = [0.4, 0.6, 0.8, 1, 1.35, 1.75, 2.25, 3];
const H_ZOOM_DEFAULT_IDX = 3; // 1x — mevcut (zoom eklenmeden önceki) görünüm

const hDateKey = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const hAddDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const hDaysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

// Kapatilmis (collapse) satirlarin ozet bari — renkleri BILINCLI olarak inline
// style ile degil, index.css'teki .gantt-summary-bar sinifiyla verilir: inline
// stiller .theme-light kuraliyla EZILEMEZ, dolayisiyla acik temada koyu temanin
// yari saydam acik gri tonu beyaz zeminde neredeyse gorunmez kalirdi. Rengin
// kendisi ve neden notr secildigi CSS tarafindaki yorumda anlatiliyor.
const SUMMARY_BAR_CLASS = 'gantt-summary-bar';

// Yearly Gantt bar positioning (% based on 31-day scale) — SALT konum hesabi
// (renk yok), boylece hem asama barlari hem de notr renkli "ozet bar" ayni
// kirpma/olcekleme mantigini paylasir.
function getYearlyRangeStyle(
  startDate: Date,
  endDate: Date,
  monthIndex: number,
  year: number,
): React.CSSProperties | null {
  const monthStart = new Date(year, monthIndex, 1);
  const monthEndExclusive = new Date(year, monthIndex + 1, 1);
  const clippedStart = Math.max(startOfDay(startDate).getTime(), monthStart.getTime());
  const clippedEnd = Math.min(startOfDay(endDate).getTime(), monthEndExclusive.getTime() - DAY_MS);
  if (clippedStart > clippedEnd) return null;
  const startDay = Math.max(1, Math.floor((clippedStart - monthStart.getTime()) / DAY_MS) + 1);
  const dayCount = Math.max(1, Math.floor((clippedEnd - clippedStart) / DAY_MS) + 1);
  return {
    position: 'absolute',
    left: `${((startDay - 1) / 31) * 100}%`,
    width: `${(dayCount / 31) * 100}%`,
    minWidth: '24px',
  };
}

function getYearlyBarStyle(
  stage: StageData,
  monthIndex: number,
  year: number,
): React.CSSProperties {
  const base = getYearlyRangeStyle(stage.startDate, stage.endDate, monthIndex, year);
  if (!base) return { display: 'none' };
  const colorMap = getStageBarColor(stage.stageKey, stage.isOutsourced);
  return {
    ...base,
    backgroundColor: colorMap.bg,
    color: colorMap.fg,
    borderColor: colorMap.border,
  };
}

// Monthly Gantt bar positioning (% based on 31-day scale)
// getYearlyRangeStyle'in aylik karsiligi — SALT konum (renk yok), boylece asama
// barlari ve notr "ozet bar" ayni kirpma mantigini paylasir.
function getMonthlyRangeStyle(
  startDate: Date,
  endDate: Date,
  calendarDate: Date,
): React.CSSProperties {
  const startMonth = startOfMonth(calendarDate);
  const rangeStart = startOfDay(startDate);
  const rangeEnd = startOfDay(endDate);
  const visibleStart = startOfDay(startMonth);
  const visibleEnd = new Date(startMonth.getFullYear(), startMonth.getMonth() + 1, 1);
  const clippedStart = Math.max(rangeStart.getTime(), visibleStart.getTime());
  const clippedEnd = Math.min(rangeEnd.getTime(), visibleEnd.getTime() - DAY_MS);
  const unitsFromStart = (clippedStart - visibleStart.getTime()) / DAY_MS;
  const barUnits = Math.max(1, Math.floor((clippedEnd - clippedStart) / DAY_MS) + 1);
  return {
    position: 'absolute',
    left: `${(unitsFromStart / 31) * 100}%`,
    width: `${(barUnits / 31) * 100}%`,
    minWidth: '24px',
  };
}

function getMonthlyBarStyle(
  stage: StageData,
  calendarDate: Date,
): React.CSSProperties {
  const colorMap = getStageBarColor(stage.stageKey, stage.isOutsourced);
  return {
    ...getMonthlyRangeStyle(stage.startDate, stage.endDate, calendarDate),
    backgroundColor: colorMap.bg,
    color: colorMap.fg,
    borderColor: colorMap.border,
  };
}

// Yearly view: two-panel layout support
interface YearlyTableProps {
  monthBuckets: MonthBucket[];
  year: number;
  collapsedOrders: Set<string>;
  collapsedSplits: Set<string>;
  toggleOrder: (id: string) => void;
  toggleSplit: (id: string) => void;
  onTaskClick?: (taskId: string) => void;
  sidebarWidth?: number;
  displayMode?: 'full' | 'labels' | 'gantt';
  /** When true, collapse keys are prefixed with monthIndex (e.g., "3:orderId")
   *  so collapsing an order in one month doesn't affect other months. */
  monthScopedCollapse?: boolean;
  /** Resmi tatil günleri (YYYY-MM-DD) — dolu günler ızgarada ayırt edici bir
   *  renkle işaretlenir. */
  holidayKeys?: Set<string>;
  highlightScopeId?: string | null;
  /** Hover ile vurgulanan siparişin id'si (ana sipariş + alt ürünleri birlikte). */
  hoveredOrderId?: string | null;
  onHoverOrderChange?: (orderId: string | null) => void;
}

function YearlyTable({
  monthBuckets,
  year,
  collapsedOrders,
  collapsedSplits,
  toggleOrder,
  toggleSplit,
  onTaskClick,
  sidebarWidth = ORDER_LABEL_WIDTH,
  displayMode = 'full',
  monthScopedCollapse,
  holidayKeys,
  highlightScopeId,
  hoveredOrderId,
  onHoverOrderChange,
}: YearlyTableProps) {
  // Ayar prop olarak gecirilmez, dogrudan okunur — bu bilesen HierarchicalGantt
  // icinde iki kez (labels/gantt panelleri) render ediliyor ve ikisinin de ayni
  // degeri gormesi zaten garanti; ustelik aradaki tum prop zincirini uzatmaya
  // gerek kalmaz.
  const { collapsedSummaryBar: showCollapsedSummaryBar } = useAppearanceSettings();

  const collapseKey = useCallback((monthIndex: number, id: string) => {
    return monthScopedCollapse ? `${monthIndex}:${id}` : id;
  }, [monthScopedCollapse]);

  // Belirli bir ay+gün çalışma günü DEĞİL mi — hafta sonu (Cmt/Paz) ya da resmi
  // tatil. "Tatil" burada geniş anlamda kullanılıyor: iş yapılmayan her gün.
  const isHolidayDay = useCallback((monthIndex: number, day: number) => {
    const weekday = new Date(year, monthIndex, day).getDay();
    if (weekday === 0 || weekday === 6) return true;
    if (!holidayKeys || holidayKeys.size === 0) return false;
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return holidayKeys.has(key);
  }, [holidayKeys, year]);

  const today = new Date();
  const todayMonth = today.getMonth();
  const todayDay = today.getDate();
  const isCurrentYear = today.getFullYear() === year;

  const DAY_HEADER_H = 26;
  // Ay etiketi tam gün başlığının altına yapışık durmasın diye — kullanıcı isteği
  // üzerine biraz nefes payı bırakılır (sticky konumu tam üst kenara değil, ondan
  // biraz aşağıya sabitlenir).
  const MONTH_LABEL_STICKY_TOP = DAY_HEADER_H + 40;
  const labelWidth = sidebarWidth;
  const ganttWidth = 31 * DAY_WIDTH;

  // --- Helpers: render a single row's content for labels-only or gantt-only ---
  function renderOrderLabel(orderIdx: string, order: OrderData, isOrderCollapsed: boolean, monthIndex: number) {
    const totalQty = order.splits.reduce((sum, s) => sum + s.quantity, 0);
    const orderLabel = totalQty > 0
      ? `${order.externalId} - ${order.orderText} - ${totalQty} adet`
      : `${order.externalId} - ${order.orderText}`;
    return (
      <div key={`ord-label-${orderIdx}`} className="flex items-center gap-2 px-3 border-r-2 border-surface-700/50 border-b border-surface-700/20 flex-shrink-0 bg-surface-900/20" style={{ width: `${labelWidth}px`, height: `${ROW_HEIGHT_ORDER}px` }}>
        <button type="button" onClick={() => toggleOrder(collapseKey(monthIndex, order.id))} className="flex items-center gap-2 flex-1 text-left min-w-0">
          <svg className={`w-3.5 h-3.5 text-surface-400 transition-transform flex-shrink-0 ${isOrderCollapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
          <span className="w-2 h-2 rounded-full bg-primary-400 flex-shrink-0" />
          <span className="text-xs font-bold text-primary-400 truncate">{orderLabel}</span>
        </button>
      </div>
    );
  }

  /** Kapatilmis bir satirin (siparis/parca/alt urun) ozet bari — gizlenen tum
   *  asamalarin toplam araligini TEK bir notr barla gosterir. Satir acikken veya
   *  ayar kapaliyken null doner ve satir eskisi gibi bos kalir. */
  function renderSummaryBar(
    start: Date,
    end: Date,
    monthIndex: number,
    rowHeight: number,
    onExpand: () => void,
  ) {
    const base = getYearlyRangeStyle(start, end, monthIndex, year);
    if (!base) return null; // bu aya hic denk gelmiyor
    const barH = rowHeight - 12;
    return (
      <div
        className={`absolute rounded-md border border-dashed flex items-center overflow-hidden z-20 cursor-pointer hover:brightness-125 transition-all ${SUMMARY_BAR_CLASS}`}
        style={{
          ...base,
          top: `${(rowHeight - barH) / 2}px`,
          height: `${barH}px`,
        }}
        onClick={onExpand}
        title={`${formatDateRange(start, end)} — adımları göstermek için tıklayın`}
      >
        <span className="px-2 text-[11px] font-medium whitespace-nowrap truncate opacity-90">
          {formatDateRange(start, end)}
        </span>
      </div>
    );
  }

  function renderOrderGantt(
    orderIdx: string,
    order: OrderData,
    daysInMonth: number,
    monthIndex: number,
    isOrderCollapsed: boolean,
  ) {
    return (
      <div key={`ord-gantt-${orderIdx}`} className="relative w-full flex-shrink-0 border-b border-surface-700/20" style={{ height: `${ROW_HEIGHT_ORDER}px` }}>
        <div className="absolute inset-0 flex pointer-events-none">
          {Array.from({ length: 31 }, (_, d) => (
            <div key={d} className={`flex-1 border-r border-surface-700/10 min-w-0 ${d + 1 > daysInMonth ? 'gantt-outmonth-cell' : isHolidayDay(monthIndex, d + 1) ? 'gantt-holiday-cell' : ''} ${isCurrentYear && monthIndex === todayMonth && d + 1 === todayDay ? 'bg-red-500/10' : ''}`} style={{ boxSizing: 'border-box' }} />
          ))}
        </div>
        {isCurrentYear && monthIndex === todayMonth && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500/70 z-10 pointer-events-none" style={{ left: `${((todayDay - 1) / 31) * 100}%` }} />
        )}
        {isOrderCollapsed && showCollapsedSummaryBar && renderSummaryBar(
          order.overallStart,
          order.overallEnd,
          monthIndex,
          ROW_HEIGHT_ORDER,
          () => toggleOrder(collapseKey(monthIndex, order.id)),
        )}
      </div>
    );
  }

  function renderSplitLabel(splitIdx: string, split: SplitData, isSplitCollapsed: boolean, monthIndex: number, labelOverride?: string) {
    const fmtDate = split.deliveryDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const label = labelOverride ?? `🧩 ${split.quantity} adet · ${fmtDate}`;
    const isComponent = labelOverride !== undefined;
    return (
      <div
        key={`split-label-${splitIdx}`}
        className={`flex items-center gap-2 border-r-2 border-surface-700/50 border-b border-surface-700/20 flex-shrink-0 ${isComponent ? 'bg-amber-500/10' : 'bg-surface-900/10'}`}
        style={{ width: `${labelWidth}px`, height: `${ROW_HEIGHT_SPLIT}px`, paddingLeft: `${TREE_INDENT + 12}px` }}
      >
        <button type="button" onClick={() => toggleSplit(collapseKey(monthIndex, split.id))} className="flex items-center gap-1.5 flex-1 text-left min-w-0">
          <svg className={`w-3 h-3 transition-transform flex-shrink-0 ${isComponent ? 'text-amber-500/70' : 'text-surface-500'} ${isSplitCollapsed ? '' : 'rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
          <span className={`text-xs font-medium truncate ${isComponent ? 'gantt-component-label-text' : 'text-surface-300'}`}>{label}</span>
        </button>
      </div>
    );
  }

  function renderSplitGantt(
    splitIdx: string,
    daysInMonth: number,
    monthIndex: number,
    split?: SplitData,
    isSplitCollapsed?: boolean,
  ) {
    return (
      <div key={`split-gantt-${splitIdx}`} className="relative w-full flex-shrink-0 border-b border-surface-700/20" style={{ height: `${ROW_HEIGHT_SPLIT}px` }}>
        <div className="absolute inset-0 flex pointer-events-none">
          {Array.from({ length: 31 }, (_, d) => (
            <div key={d} className={`flex-1 border-r border-surface-700/10 min-w-0 ${d + 1 > daysInMonth ? 'gantt-outmonth-cell' : isHolidayDay(monthIndex, d + 1) ? 'gantt-holiday-cell' : ''} ${isCurrentYear && monthIndex === todayMonth && d + 1 === todayDay ? 'bg-red-500/10' : ''}`} style={{ boxSizing: 'border-box' }} />
          ))}
        </div>
        {isCurrentYear && monthIndex === todayMonth && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500/70 z-10 pointer-events-none" style={{ left: `${((todayDay - 1) / 31) * 100}%` }} />
        )}
        {split && isSplitCollapsed && showCollapsedSummaryBar && renderSummaryBar(
          split.overallStart,
          split.overallEnd,
          monthIndex,
          ROW_HEIGHT_SPLIT,
          () => toggleSplit(collapseKey(monthIndex, split.id)),
        )}
      </div>
    );
  }

  function renderStageLabel(stageIdx: string, stage: StageData, stageDepth: number) {
    return (
      <div key={`stage-label-${stageIdx}`} className="flex items-center gap-2 border-r-2 border-surface-700/50 border-b border-surface-700/20 flex-shrink-0" style={{ width: `${labelWidth}px`, height: `${ROW_HEIGHT_STAGE}px`, paddingLeft: `${stageDepth * TREE_INDENT + 12}px` }}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {renderStageIcon(stage.stageKey)}
          <span className="text-xs text-surface-300 truncate">{stage.stageLabel}</span>
        </div>
      </div>
    );
  }

  function renderStageGantt(
    stageIdx: string,
    stage: StageData,
    daysInMonth: number,
    monthIndex: number,
    ownerOrderId: string,
    isComponent: boolean,
  ) {
    const barStyle = getYearlyBarStyle(stage, monthIndex, year);
    const barH = ROW_HEIGHT_STAGE - 8;
    const isPanelHighlighted = !!highlightScopeId && getHighlightScopeId(stage.id) === highlightScopeId;
    const isHighlighted = isPanelHighlighted || ownerOrderId === hoveredOrderId;
    return (
      <div key={`stage-gantt-${stageIdx}`} className="relative w-full flex-shrink-0 border-b border-surface-700/20" style={{ height: `${ROW_HEIGHT_STAGE}px` }}>
        <div className="absolute inset-0 flex pointer-events-none">
          {Array.from({ length: 31 }, (_, d) => (
            <div key={d} className={`flex-1 border-r border-surface-700/10 min-w-0 ${d + 1 > daysInMonth ? 'gantt-outmonth-cell' : isHolidayDay(monthIndex, d + 1) ? 'gantt-holiday-cell' : ''} ${isCurrentYear && monthIndex === todayMonth && d + 1 === todayDay ? 'bg-red-500/10' : ''}`} style={{ boxSizing: 'border-box' }} />
          ))}
        </div>
        {isCurrentYear && monthIndex === todayMonth && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500/70 z-10 pointer-events-none" style={{ left: `${((todayDay - 1) / 31) * 100}%` }} />
        )}
        <div
          className={`absolute rounded-md border flex items-center overflow-hidden z-20 cursor-pointer hover:brightness-110 transition-all ${groupHighlightClass(isHighlighted, isComponent)}`}
          style={{ ...barStyle, top: `${(ROW_HEIGHT_STAGE - barH) / 2}px`, height: `${barH}px`, borderRadius: '6px', borderWidth: '1px', borderStyle: 'solid' }}
          onClick={() => onTaskClick?.(stage.id)}
          onMouseEnter={() => onHoverOrderChange?.(ownerOrderId)}
          onMouseLeave={() => onHoverOrderChange?.(null)}
          title={`${stage.stageLabel} — detay için tıklayın`}
        >
          <span className="px-2 text-[11px] font-medium whitespace-nowrap truncate opacity-90">{formatDateRange(stage.startDate, stage.endDate)}</span>
        </div>
      </div>
    );
  }

  // --- Shared row iteration: returns label and gantt content for each row ---
  function buildMonthContent(bucket: MonthBucket) {
    const monthDate = new Date(year, bucket.monthIndex, 1);
    const daysInMonth = getDaysInMonth(monthDate);
    const monthLong = MONTH_LABELS_LONG[bucket.monthIndex];

    const labelContent: React.ReactNode[] = [];
    const ganttContent: React.ReactNode[] = [];
    let labelIdx = 0;
    let ganttIdx = 0;

    bucket.orders.forEach((order) => {
      const isOrderCollapsed = collapsedOrders.has(collapseKey(bucket.monthIndex, order.id));
      labelContent.push(renderOrderLabel(`o${labelIdx++}`, order, isOrderCollapsed, bucket.monthIndex));
      ganttContent.push(renderOrderGantt(`o${ganttIdx++}`, order, daysInMonth, bucket.monthIndex, isOrderCollapsed));

      if (!isOrderCollapsed) {
        const realSplitCount = order.splits.filter(s => s.id.startsWith('split_') && !s.id.startsWith('split_fake_')).length;
        const hasMultipleSplits = order.isExplicitSplit || realSplitCount > 1;
        order.splits.forEach((split) => {
          const isSplitCollapsed = hasMultipleSplits && collapsedSplits.has(collapseKey(bucket.monthIndex, split.id));

          if (hasMultipleSplits) {
            labelContent.push(renderSplitLabel(`s${labelIdx++}`, split, isSplitCollapsed, bucket.monthIndex));
            ganttContent.push(renderSplitGantt(`s${ganttIdx++}`, daysInMonth, bucket.monthIndex, split, isSplitCollapsed));
          }

          if (!isSplitCollapsed) {
            split.stages.forEach((stage) => {
              const stageDepth = hasMultipleSplits ? 2 : 1;
              labelContent.push(renderStageLabel(`st${labelIdx++}`, stage, stageDepth));
              ganttContent.push(renderStageGantt(`st${ganttIdx++}`, stage, daysInMonth, bucket.monthIndex, order.id, false));
            });
          }
        });

        // BOM bileşenleri (alt ürünler) — splitlerden ayrı, her zaman kendi
        // satırıyla gösterilir; "parçalı teslimat" sayımına katılmazlar.
        order.components.forEach((component) => {
          const isComponentCollapsed = collapsedSplits.has(collapseKey(bucket.monthIndex, component.id));
          const componentLabel = `📦 ${component.productType} — ${component.quantity} adet`;
          labelContent.push(renderSplitLabel(`c${labelIdx++}`, component, isComponentCollapsed, bucket.monthIndex, componentLabel));
          ganttContent.push(renderSplitGantt(`c${ganttIdx++}`, daysInMonth, bucket.monthIndex, component, isComponentCollapsed));

          if (!isComponentCollapsed) {
            component.stages.forEach((stage) => {
              labelContent.push(renderStageLabel(`cst${labelIdx++}`, stage, 2));
              ganttContent.push(renderStageGantt(`cst${ganttIdx++}`, stage, daysInMonth, bucket.monthIndex, order.id, true));
            });
          }
        });
      }
    });

    return { monthLong, labelContent, ganttContent, orderCount: bucket.orders.length };
  }

  // --- Full view (original combined layout) ---
  function renderFullView() {
    return (
      <div style={{ width: `${MONTH_COL_WIDTH + labelWidth + ganttWidth}px` }}>
        <div className="flex items-center bg-surface-800 border-b-2 border-surface-700/50 sticky top-0 z-30" style={{ height: `${DAY_HEADER_H}px` }}>
          <div className="flex-shrink-0 bg-surface-800 border-r-2 border-surface-700/50 h-full" style={{ width: `${MONTH_COL_WIDTH}px` }} />
          <div className="flex-shrink-0 border-r-2 border-surface-700/50 h-full flex items-center px-2" style={{ width: `${labelWidth}px` }}>
            <span className="text-[10px] font-semibold text-surface-500 uppercase tracking-wider">Sipariş</span>
          </div>
          {Array.from({ length: 31 }, (_, d) => {
            const day = d + 1;
            const isToday = isCurrentYear && today.getDate() === day;
            return (
              <div key={d} className={`flex items-center justify-center text-[11px] border-r border-surface-700/20 h-full ${isToday ? 'text-red-400 font-bold' : 'text-surface-400'}`} style={{ width: `${DAY_WIDTH}px`, minWidth: `${DAY_WIDTH}px` }}>
                {day}
              </div>
            );
          })}
        </div>
        {monthBuckets.map((bucket) => {
          const { monthLong, labelContent, ganttContent, orderCount } = buildMonthContent(bucket);
          return (
            <div key={`yr-month-${bucket.monthIndex}`} className="flex items-stretch border-b-2 border-surface-700/60">
              <div className="flex-shrink-0 bg-surface-900/80 border-r-2 border-surface-700/50 relative" style={{ width: `${MONTH_COL_WIDTH}px`, minHeight: `${Math.max(orderCount * ROW_HEIGHT_ORDER, MIN_MONTH_LABEL_HEIGHT)}px` }}>
                {/* Çok sipariş olan bir ayda bu etiket eskiden bloğun TAM ORTASINA
                    sabitleniyordu (absolute+inset-0) — aşağı kaydırınca ekran
                    dışına çıkıp bir süre hangi ayda olunduğu görünmüyordu. Sticky
                    ile üst menünün (DAY_HEADER_H) hemen altında kalıp kaydırma
                    boyunca takip eder, blok bitince doğal olarak bir sonrakine
                    yer açar. */}
                <div className="sticky flex items-center justify-center pointer-events-none" style={{ top: `${MONTH_LABEL_STICKY_TOP}px`, height: `${MIN_MONTH_LABEL_HEIGHT}px` }}>
                  <div className="text-sm font-semibold text-primary-300 leading-tight text-center px-2" style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}>
                    {monthLong}
                  </div>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                {orderCount === 0 ? (
                  <div className="flex items-stretch" style={{ height: `${ROW_HEIGHT_ORDER}px` }}>
                    <div className="flex-shrink-0 border-r-2 border-surface-700/50" style={{ width: `${labelWidth}px` }} />
                    <div className="flex items-center px-4 text-sm text-surface-500 italic">Bu ayda sipariş yok</div>
                  </div>
                ) : (
                  labelContent.map((labelEl, idx) => (
                    <div key={`full-row-${bucket.monthIndex}-${idx}`} className="flex items-stretch border-b border-surface-700/20 hover:bg-surface-800/20 group" style={{ minHeight: `${ROW_HEIGHT_ORDER}px` }}>
                      {labelEl}
                      {ganttContent[idx] || <div className="relative flex-shrink-0" style={{ width: `${ganttWidth}px` }} />}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // --- Labels only (left panel) ---
  function renderLabelsView() {
    return (
      <div style={{ width: `${MONTH_COL_WIDTH + labelWidth}px` }}>
        <div className="flex items-center bg-surface-800 border-b-2 border-surface-700/50 sticky top-0 z-30" style={{ height: `${DAY_HEADER_H}px` }}>
          <div className="flex-shrink-0 bg-surface-800 border-r-2 border-surface-700/50 h-full" style={{ width: `${MONTH_COL_WIDTH}px` }} />
          <div className="flex-shrink-0 border-r-2 border-surface-700/50 h-full flex items-center px-2" style={{ width: `${labelWidth}px` }}>
            <span className="text-[10px] font-semibold text-surface-500 uppercase tracking-wider">Sipariş</span>
          </div>
        </div>
        {monthBuckets.map((bucket) => {
          const { monthLong, labelContent, orderCount } = buildMonthContent(bucket);
          return (
            <div key={`yr-labels-${bucket.monthIndex}`} className="flex items-stretch border-b-2 border-surface-700/60">
              <div className="flex-shrink-0 bg-surface-900/80 border-r-2 border-surface-700/50 relative" style={{ width: `${MONTH_COL_WIDTH}px`, minHeight: `${Math.max(orderCount * ROW_HEIGHT_ORDER, MIN_MONTH_LABEL_HEIGHT)}px` }}>
                <div className="sticky flex items-center justify-center pointer-events-none" style={{ top: `${MONTH_LABEL_STICKY_TOP}px`, height: `${MIN_MONTH_LABEL_HEIGHT}px` }}>
                  <div className="text-sm font-semibold text-primary-300 leading-tight text-center px-2" style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}>
                    {monthLong}
                  </div>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                {orderCount === 0 ? (
                  <div style={{ height: `${MIN_MONTH_LABEL_HEIGHT}px` }} />
                ) : (
                  labelContent
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // --- Gantt only (right panel, responsive flex layout) ---
  function renderGanttView() {
    return (
      <div className="w-full">
        <div className="flex items-center bg-surface-800 border-b-2 border-surface-700/50 sticky top-0 z-30" style={{ height: `${DAY_HEADER_H}px` }}>
          {Array.from({ length: 31 }, (_, d) => {
            const day = d + 1;
            const isToday = isCurrentYear && today.getDate() === day;
            return (
              <div key={d} className={`flex-1 flex items-center justify-center text-[11px] border-r border-surface-700/20 h-full min-w-0 ${isToday ? 'text-red-400 font-bold' : 'text-surface-400'}`} style={{ boxSizing: 'border-box' }}>
                {day}
              </div>
            );
          })}
        </div>
        {monthBuckets.map((bucket) => {
          const { ganttContent, orderCount } = buildMonthContent(bucket);
          return (
            <div key={`yr-gantt-${bucket.monthIndex}`} className="border-b-2 border-surface-700/60">
              {orderCount === 0 ? (
                <div className="relative" style={{ height: `${MIN_MONTH_LABEL_HEIGHT}px` }}>
                  <div className="absolute inset-0 flex pointer-events-none">
                    {Array.from({ length: 31 }, (_, d) => (
                      <div key={d} className={`flex-1 border-r border-surface-700/10 min-w-0 ${d + 1 > getDaysInMonth(new Date(year, bucket.monthIndex, 1)) ? 'gantt-outmonth-cell' : isHolidayDay(bucket.monthIndex, d + 1) ? 'gantt-holiday-cell' : ''}`} style={{ boxSizing: 'border-box' }} />
                    ))}
                  </div>
                </div>
              ) : (
                ganttContent
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (displayMode === 'labels') return renderLabelsView();
  if (displayMode === 'gantt') return renderGanttView();
  return renderFullView();
}

export default function HierarchicalGantt({ zoomLevel, refreshKey, taskTextFilters, customerFilter, onTaskClick, headerExtra, onCreateDelivery, highlightScopeId, orientation = 'vertical', holidayKeySet }: HierarchicalGanttProps) {
  const isHorizontal = orientation === 'horizontal';
  // Kapatilmis satirlarda ozet bar gosterilsin mi? (Gorunum Ayarlari sayfasindan
  // degistirilir; localStorage'da saklanir ve degisiklik aninda yansir.)
  const { collapsedSummaryBar: showCollapsedSummaryBar } = useAppearanceSettings();
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  // Yıllık ızgarada resmi tatil günlerini vurgulamak için — DeliveryCalendarPage
  // ile aynı endpoint/anahtar biçimi (YYYY-MM-DD).
  const [holidayKeys, setHolidayKeys] = useState<Set<string>>(new Set());
  const [collapsedOrders, setCollapsedOrders] = useState<Set<string>>(new Set());
  const [collapsedSplits, setCollapsedSplits] = useState<Set<string>>(new Set());
  const [calendarDate, setCalendarDate] = useState<Date>(() => new Date());
  const [yearViewYear, setYearViewYear] = useState<number>(() => new Date().getFullYear());
  const [sidebarWidth, setSidebarWidth] = useState(380);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  // Bir bara hover olununca, o barla İLİŞKİLİ her şeyi (ana sipariş, tüm alt
  // ürünleri ve hepsinin parçalı teslimatları) birlikte vurgulamak için.
  // Burada küme anahtarı doğrudan OrderData.id'dir — bir OrderData zaten kendi
  // splits + components'ini kapsıyor. Özet takvimdeki hoveredRootOrderId ve
  // Yatay Timeline'daki aynı davranışın karşılığı.
  const [hoveredOrderId, setHoveredOrderId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const ganttBodyRef = useRef<HTMLDivElement | null>(null);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const yearlyTreeRef = useRef<HTMLDivElement>(null);
  const yearlyGanttRef = useRef<HTMLDivElement>(null);

  const toggleOrder = (orderNo: string) => {
    setCollapsedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderNo)) next.delete(orderNo);
      else next.add(orderNo);
      return next;
    });
  };

  const toggleSplit = (splitId: string) => {
    setCollapsedSplits((prev) => {
      const next = new Set(prev);
      if (next.has(splitId)) next.delete(splitId);
      else next.add(splitId);
      return next;
    });
  };

  const goPrevMonth = useCallback(() => {
    setCalendarDate((prev) => addMonths(prev, -1));
  }, []);

  const goNextMonth = useCallback(() => {
    setCalendarDate((prev) => addMonths(prev, 1));
  }, []);

  const goPrevYear = useCallback(() => {
    setYearViewYear((prev) => prev - 1);
  }, []);

  const goNextYear = useCallback(() => {
    setYearViewYear((prev) => prev + 1);
  }, []);

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsSidebarResizing(true);
  }, []);

  useEffect(() => {
    if (!isSidebarResizing) return;
    const container = sidebarContainerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const handleMouseMove = (e: MouseEvent) => {
      const nextWidth = Math.max(200, Math.min(600, e.clientX - containerRect.left));
      setSidebarWidth(nextWidth);
    };
    const handleMouseUp = () => {
      setIsSidebarResizing(false);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isSidebarResizing]);

  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);
      setError('');
      const { data } = await api.get('/gantt/tasks');
      const rawTasks: any[] = data.tasks || [];

      const parsedTasks = rawTasks.map((t: any) => {
        const start = parseTaskDate(t.start_date);
        if (!start) return null;
        const end = parseTaskDate(t.end_date) || new Date(start.getTime() + (Number(t.duration || 1) - 1) * DAY_MS);
        return {
          id: t.id,
          text: t.text,
          start,
          end,
          deliveryDate: parseTaskDate(t.delivery_date) || end,
          duration: Number(t.duration || 1),
          type: t.type === 'project' ? 'summary' : 'task',
          parent: t.parent ?? null,
          stage: t.stage || null,
          quantity: t.quantity ?? null,
          externalId: t.external_id || '',
          customerName: t.customer_name || '',
          isOutsourced: t.is_outsourced ?? null,
          outsourceDays: t.outsource_days ?? null,
          is_explicit_split: t.is_explicit_split === true,
        };
      }).filter(Boolean) as Array<{
        id: string; text: string; start: Date; end: Date; deliveryDate: Date;
        duration: number; type: string; parent: string | null;
        stage: string | null; quantity: number | null; externalId: string;
        customerName: string; isOutsourced: boolean | null; outsourceDays: number | null; is_explicit_split: boolean;
      }>;

      const orderTasks = parsedTasks.filter(t => t.type === 'summary' && t.parent === null);

      const childrenByParent = new Map<string, typeof parsedTasks>();
      parsedTasks.forEach(t => {
        if (t.parent) {
          const pid = t.parent;
          if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
          childrenByParent.get(pid)!.push(t);
        }
      });

      const result: OrderData[] = [];

      for (const ord of orderTasks) {
        const children = childrenByParent.get(ord.id) || [];
        const externalId = ord.externalId || ord.id;

        const splitGroups = new Map<string, { splitTask: (typeof parsedTasks)[0] | null; stages: (typeof parsedTasks)[0][] }>();
        const components: SplitData[] = [];

        for (const child of children) {
          // BOM bilesen siparisleri (alt urunler) kendi "Bilesen: X" proje/summary
          // satirlarini bu siparisin (ord) COCUGU olarak tasir (nested gosterim
          // icin), ama bunlar bu siparisin bir TESLIMAT PARCASI DEGIL — splitGroups'a
          // eklenmezler (aksi halde "split representative" saniliyor ve yanlislikla
          // parcali teslimat gibi gosteriliyordu), ayri bir `components` dizisine
          // toplanirlar. Bilesenin KENDI asama gorevleri ayri parent'a (order_<bilesen.id>)
          // sahip oldugu icin childrenByParent'tan child.id ile ayrica cekilir.
          if (child.type === 'summary') {
            const compStages = childrenByParent.get(child.id) || [];
            // Bilesenin KENDISI de parcali teslimata bolunmus olabilir (birden
            // fazla DeliverySplit) — asama gorevleri KENDI split-root'larina gore
            // gruplanmali, aksi halde 2. parcanin asamalari ayni "stage key" (ör.
            // "production") altinda 1. parcaninkiyle CAKISIP (Map key collision)
            // sessizce kaybolurdu.
            const compSplitGroups = new Map<string, (typeof parsedTasks)>();
            for (const stage of compStages) {
              const rootId = getSplitRootFromId(stage.id);
              if (!compSplitGroups.has(rootId)) compSplitGroups.set(rootId, []);
              compSplitGroups.get(rootId)!.push(stage);
            }
            const compProductType = normalizeText((child.text || '').replace(/^📦\s*/, '')) || 'Alt Ürün';
            const compRootIds = Array.from(compSplitGroups.keys());
            const hasMultipleCompSplits = compRootIds.length > 1;

            compRootIds.forEach((rootId, partIdx) => {
              const stagesForRoot = compSplitGroups.get(rootId)!;
              const stageMap = new Map<string, StageData>();
              for (const stage of stagesForRoot) {
                const key = stage.stage?.toLowerCase() || stage.id;
                if (!key || stageMap.has(key)) continue;
                stageMap.set(key, {
                  id: stage.id,
                  stageKey: stage.stage || '',
                  stageLabel: getStageLabel(stage.stage || '', stage.isOutsourced === true),
                  startDate: stage.start,
                  endDate: stage.end,
                  deliveryDate: stage.deliveryDate,
                  isOutsourced: stage.isOutsourced === true,
                });
              }
              const stageRows = STAGE_ORDER.filter(sk => stageMap.has(sk)).map(sk => stageMap.get(sk)!);
              const allCompDates = stageRows.flatMap(s => [s.startDate.getTime(), s.endDate.getTime()]);
              const compStart = allCompDates.length > 0 ? new Date(Math.min(...allCompDates)) : child.start;
              const compEnd = allCompDates.length > 0 ? new Date(Math.max(...allCompDates)) : child.end;
              components.push({
                id: hasMultipleCompSplits ? `${child.id}__${rootId}` : child.id,
                productType: hasMultipleCompSplits ? `${compProductType} — Parça ${partIdx + 1}` : compProductType,
                quantity: stagesForRoot[0]?.quantity ?? child.quantity ?? 0,
                deliveryDate: compEnd,
                stages: stageRows,
                overallStart: compStart,
                overallEnd: compEnd,
              });
            });
            continue;
          }
          if (child.stage) {
            const rootId = getSplitRootFromId(child.id);
            if (!splitGroups.has(rootId)) splitGroups.set(rootId, { splitTask: null, stages: [] });
            splitGroups.get(rootId)!.stages.push(child);
          } else {
            const rid = hasSplitIdFormat(child.id) ? child.id : child.id;
            if (!splitGroups.has(rid)) splitGroups.set(rid, { splitTask: null, stages: [] });
            splitGroups.get(rid)!.splitTask = child;
          }
        }

        const splits: SplitData[] = [];

        for (const [rootId, group] of splitGroups) {
          const st = group.splitTask;
          const productType = normalizeText(ord.text || st?.text || group.stages[0]?.text || '') || 'Bilinmeyen Ürün';
          const quantity = st?.quantity ?? group.stages[0]?.quantity ?? 0;
          const deliveryDate = st?.deliveryDate || group.stages[0]?.deliveryDate || new Date();

          const stageMap = new Map<string, StageData>();
          const addedKeys = new Set<string>();

          for (const stage of group.stages) {
            const key = stage.stage?.toLowerCase() || stage.id;
            if (!key || addedKeys.has(key)) continue;
            addedKeys.add(key);
            stageMap.set(key, {
              id: stage.id,
              stageKey: stage.stage || '',
              stageLabel: getStageLabel(stage.stage || '', stage.isOutsourced === true),
              startDate: stage.start,
              endDate: stage.end,
              deliveryDate: stage.deliveryDate,
              isOutsourced: stage.isOutsourced === true,
            });
          }

          let stageRows: StageData[];
          if (stageMap.size > 0) {
            stageRows = STAGE_ORDER
              .filter(sk => stageMap.has(sk))
              .map(sk => stageMap.get(sk)!)
              .concat(
                Array.from(stageMap.entries())
                  .filter(([k]) => !STAGE_ORDER.includes(k))
                  .map(([, v]) => v),
              );
          } else if (st) {
            stageRows = [{
              id: st.id,
              stageKey: '',
              stageLabel: productType,
              startDate: st.start,
              endDate: st.end,
              deliveryDate: st.deliveryDate,
            }];
          } else {
            stageRows = [];
          }

          const allDates = stageRows.flatMap(s => [s.startDate.getTime(), s.endDate.getTime()]);
          const overallStart = allDates.length > 0 ? new Date(Math.min(...allDates)) : new Date();
          const overallEnd = allDates.length > 0 ? new Date(Math.max(...allDates)) : new Date();

          splits.push({
            id: rootId,
            productType,
            quantity,
            deliveryDate,
            stages: stageRows,
            overallStart,
            overallEnd,
          });
        }

        // Siparişin genel tarih aralığı, kendi parçalarının YANINDA alt ürünlerini
        // (BOM bileşenleri) de kapsamalı. Alt ürünler ana üründen ÖNCE üretildiği
        // için çoğu zaman daha erken başlarlar; bunlar dışarıda bırakılırsa
        // overallStart olduğundan geç çıkar. Yıllık görünümde ay kovaları bu
        // aralığa göre (firstMonth..lastMonth) kurulduğundan, bu durumda alt
        // ürünün başladığı ay için hiç kova açılmaz: bar yalnızca bir sonraki
        // ayda, ayın 1'ine kırpılmış olarak görünür (etiketi ise gerçek
        // başlangıcı yazmaya devam eder). Bkz. monthBuckets.
        const allRangeDates = [...splits, ...components]
          .flatMap(s => [s.overallStart.getTime(), s.overallEnd.getTime()]);
        const orderStart = allRangeDates.length > 0 ? new Date(Math.min(...allRangeDates)) : ord.start;
        const orderEnd = allRangeDates.length > 0 ? new Date(Math.max(...allRangeDates)) : ord.end;

        result.push({
          id: ord.id,
          externalId,
          orderText: ord.text || '',
          customerName: ord.customerName || '',
          splits,
          components,
          overallStart: orderStart,
          overallEnd: orderEnd,
          isExplicitSplit: ord.is_explicit_split === true,
        });
      }

      result.sort((a, b) => a.overallStart.getTime() - b.overallStart.getTime());
      setOrders(result);
    } catch (err) {
      setError('Veri yüklenirken hata oluştu');
      console.error('[HierarchicalGantt] fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  useEffect(() => {
    api
      .get('/holidays/')
      .then(({ data }) => {
        const items: { holiday_date: string; is_active: boolean }[] = Array.isArray(data) ? data : [];
        setHolidayKeys(new Set(items.filter((h) => h.is_active).map((h) => h.holiday_date)));
      })
      .catch(() => {
        // Tatiller yüklenemezse ızgara sessizce tatilsiz gösterilir — kritik bir veri değil.
      });
  }, []);

  const viewRange = useMemo(() => {
    if (zoomLevel === 'yearly') {
      const start = startOfYear(yearViewYear);
      const end = new Date(yearViewYear + 1, 0, 1);
      return {
        start,
        end,
        label: getYearLabel(yearViewYear),
        unitCount: 31,
        unitWidth: DAY_WIDTH,
      };
    }

    const start = startOfMonth(calendarDate);
    const end = addMonths(start, 1);
    return {
      start,
      end,
      label: getMonthLabel(calendarDate),
      unitCount: 31,
      unitWidth: DAY_WIDTH,
    };
  }, [calendarDate, yearViewYear, zoomLevel]);

  const filteredOrders = useMemo(() => {
    const hasTextFilter = taskTextFilters.some(f => f.query.trim());
    const hasCustomerFilter = !!customerFilter;
    if (!hasTextFilter && !hasCustomerFilter) return orders;

    return orders.filter(order => {
      if (hasCustomerFilter && !order.customerName.toLocaleLowerCase('tr-TR').includes(customerFilter.toLocaleLowerCase('tr-TR'))) return false;

      if (hasTextFilter) {
        const pseudoTask = {
          text: order.orderText,
          externalId: order.externalId,
          orderNo: order.externalId,
          productType: order.splits.map(s => s.productType).join(' '),
          quantity: order.splits.reduce((sum, s) => sum + (s.quantity || 0), 0),
          customerName: order.customerName,
        };
        return matchesTaskTextFilters(pseudoTask, taskTextFilters);
      }
      return true;
    });
  }, [orders, taskTextFilters, customerFilter]);

  const visibleOrders = useMemo(() => {
    // Yatay görünümde eksen kesintisizdir ve tüm zaman aralığında kaydırılabilir;
    // bu yüzden siparişler ne yıla ne de görünen aya kırpılır — hepsi listelenir.
    if (isHorizontal) return filteredOrders;
    if (zoomLevel === 'yearly') {
      const yearStart = new Date(yearViewYear, 0, 1);
      const yearEnd = new Date(yearViewYear + 1, 0, 1);
      return filteredOrders.filter(order =>
        order.overallEnd >= yearStart && order.overallStart < yearEnd,
      );
    }

    return filteredOrders
      .map((order) => {
        const splits = order.splits
          .map((split) => {
            const stages = split.stages.filter((stage) => stage.endDate >= viewRange.start && stage.startDate < viewRange.end);
            if (stages.length === 0) return null;

            const overallStart = new Date(Math.min(...stages.map((stage) => stage.startDate.getTime())));
            const overallEnd = new Date(Math.max(...stages.map((stage) => stage.endDate.getTime())));

            return { ...split, stages, overallStart, overallEnd };
          })
          .filter((split): split is SplitData => split !== null);

        // BOM bileşenleri de splitler gibi görüntülenen aya göre kırpılır — aksi
        // halde görünür hiçbir aşaması olmayan bir bileşen boş bir kart olarak kalır.
        const components = order.components
          .map((component) => {
            const stages = component.stages.filter((stage) => stage.endDate >= viewRange.start && stage.startDate < viewRange.end);
            if (stages.length === 0) return null;

            const overallStart = new Date(Math.min(...stages.map((stage) => stage.startDate.getTime())));
            const overallEnd = new Date(Math.max(...stages.map((stage) => stage.endDate.getTime())));

            return { ...component, stages, overallStart, overallEnd };
          })
          .filter((component): component is SplitData => component !== null);

        if (splits.length === 0 && components.length === 0) return null;

        const allOverallDates = [...splits, ...components];
        const overallStart = allOverallDates.length > 0
          ? new Date(Math.min(...allOverallDates.map((s) => s.overallStart.getTime())))
          : order.overallStart;
        const overallEnd = allOverallDates.length > 0
          ? new Date(Math.max(...allOverallDates.map((s) => s.overallEnd.getTime())))
          : order.overallEnd;

        return { ...order, splits, components, overallStart, overallEnd };
      })
      .filter((order): order is OrderData => order !== null);
  }, [filteredOrders, viewRange.end, viewRange.start, zoomLevel, yearViewYear, isHorizontal]);

  const monthBuckets = useMemo<MonthBucket[]>(() => {
    if (zoomLevel !== 'yearly') {
      return [{ monthIndex: 0, monthLabel: '', orders: visibleOrders }];
    }

    const yearStart = new Date(yearViewYear, 0, 1);
    const yearEndInclusive = new Date(yearViewYear, 11, 31, 23, 59, 59);

    const buckets = Array.from({ length: 12 }, (_, monthIndex) => ({
      monthIndex,
      monthLabel: MONTH_LABELS[monthIndex],
      orders: [] as OrderData[],
    }));

    visibleOrders.forEach((order) => {
      // Clamp order range to the viewed year so cross-year orders are handled correctly
      const clampedStart = order.overallStart < yearStart ? yearStart : order.overallStart;
      const clampedEnd   = order.overallEnd   > yearEndInclusive ? yearEndInclusive : order.overallEnd;

      const firstMonth = clampedStart.getMonth(); // 0-11 within this year
      const lastMonth  = clampedEnd.getMonth();   // 0-11 within this year

      for (let m = firstMonth; m <= lastMonth; m++) {
        const monthStart = new Date(yearViewYear, m, 1);
        const monthEnd   = new Date(yearViewYear, m + 1, 0, 23, 59, 59); // last moment of month

        // Keep only splits/stages that overlap this calendar month
        const clippedSplits: SplitData[] = order.splits
          .map((split) => {
            const clippedStages = split.stages.filter(
              (stage) =>
                startOfDay(stage.startDate).getTime() <= monthEnd.getTime() &&
                startOfDay(stage.endDate).getTime()   >= monthStart.getTime(),
            );
            if (clippedStages.length === 0) return null;
            return { ...split, stages: clippedStages };
          })
          .filter((s): s is SplitData => s !== null);

        // BOM bileşenleri de aynı şekilde bu aya kırpılır.
        const clippedComponents: SplitData[] = order.components
          .map((component) => {
            const clippedStages = component.stages.filter(
              (stage) =>
                startOfDay(stage.startDate).getTime() <= monthEnd.getTime() &&
                startOfDay(stage.endDate).getTime()   >= monthStart.getTime(),
            );
            if (clippedStages.length === 0) return null;
            return { ...component, stages: clippedStages };
          })
          .filter((c): c is SplitData => c !== null);

        // Only show order in a month if it has at least one overlapping stage
        if (clippedSplits.length === 0 && clippedComponents.length === 0) continue;

        buckets[m].orders.push({
          ...order,
          splits: clippedSplits,
          components: clippedComponents,
        });
      }
    });

    return buckets;
  }, [visibleOrders, yearViewYear, zoomLevel]);

  // Monthly view rows
  const visibleRows = useMemo(() => {
    const rows: DisplayRow[] = [];
    // Yıllık DİKEY görünüm satır listesi kullanmaz (ay kovalı tabloyu çizer).
    // Yatay görünüm ise her iki zoom seviyesinde de bu listeyi kullanır.
    if (zoomLevel === 'yearly' && !isHorizontal) return rows;

    visibleOrders.forEach(order => {
      const isOrderCollapsed = collapsedOrders.has(order.id);
      const totalQty = order.splits.reduce((sum, s) => sum + s.quantity, 0);
      const orderLabel = totalQty > 0
        ? `${order.externalId} - ${order.orderText} - ${totalQty} adet`
        : `${order.externalId} - ${order.orderText}`;
      rows.push({ type: 'order', id: `order-${order.id}`, label: orderLabel, depth: 0, orderNo: order.id, order });

      if (isOrderCollapsed) return;

      const hasMultipleSplits = order.isExplicitSplit || order.splits.filter(s => s.id.startsWith('split_') && !s.id.startsWith('split_fake_')).length > 1;

      order.splits.forEach(split => {
        const isSplitCollapsed = hasMultipleSplits && collapsedSplits.has(split.id);
        const fmtDate = split.deliveryDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const splitLabel = `🧩 ${split.quantity} adet · ${fmtDate}`;

        if (hasMultipleSplits) {
          rows.push({ type: 'split', id: `split-${split.id}`, label: splitLabel, depth: 1, orderNo: order.id, splitId: split.id, order, split });
        }

        if (isSplitCollapsed) return;

        split.stages.forEach(stage => {
          rows.push({ type: 'stage', id: `stage-${stage.id}`, label: stage.stageLabel, depth: hasMultipleSplits ? 2 : 1, orderNo: order.id, splitId: split.id, order, split, stage });
        });
      });

      // BOM bileşenleri (alt ürünler) — splitlerden ayrı, her zaman kendi
      // satırıyla (kaç tane olursa olsun) gösterilir; "parçalı teslimat" sayımına
      // katılmazlar (hasMultipleSplits bunları hiç görmez).
      order.components.forEach(component => {
        const isComponentCollapsed = collapsedSplits.has(component.id);
        const componentLabel = `📦 ${component.productType} — ${component.quantity} adet`;
        rows.push({ type: 'split', id: `component-${component.id}`, label: componentLabel, depth: 1, orderNo: order.id, splitId: component.id, order, split: component });

        if (isComponentCollapsed) return;

        component.stages.forEach(stage => {
          rows.push({ type: 'stage', id: `stage-${stage.id}`, label: stage.stageLabel, depth: 2, orderNo: order.id, splitId: component.id, order, split: component, stage });
        });
      });
    });

    return rows;
  }, [visibleOrders, collapsedOrders, collapsedSplits, zoomLevel, isHorizontal]);

  const getRowHeight = (type: string) => {
    if (type === 'month') return ROW_HEIGHT_ORDER;
    if (type === 'order') return ROW_HEIGHT_ORDER;
    if (type === 'split') return ROW_HEIGHT_SPLIT;
    return ROW_HEIGHT_STAGE;
  };

  const totalHeight = visibleRows.reduce((sum, r) => sum + getRowHeight(r.type), 0);

  // --- Yatay görünüm: kesintisiz zaman ekseni ---
  // Eksen, görünen TÜM aşamaların en erken/en geç tarihlerini (artı bugünü)
  // kapsar; iki yanına pay eklenir. zoomLevel yalnızca gün başına piksel
  // genişliğini değiştirir, düzeni değil.
  // Kullanıcının seçtiği yakınlaştırma kademesi. Aylık/Yıllık (zoomLevel prop'u)
  // TABANI belirler, bu çarpan onu ölçekler — böylece iki modda da aynı kademeler
  // kullanılabilir ve mod değiştirince kullanıcının tercihi korunur.
  const [hZoomIdx, setHZoomIdx] = useState(H_ZOOM_DEFAULT_IDX);
  const hZoom = H_ZOOM_STEPS[hZoomIdx];
  const hDayWidth = (zoomLevel === 'yearly' ? H_DAY_WIDTH_YEARLY : H_DAY_WIDTH_MONTHLY) * hZoom;
  const hPadDays = zoomLevel === 'yearly' ? H_PAD_DAYS_YEARLY : H_PAD_DAYS_MONTHLY;

  const hAxis = useMemo(() => {
    const today = startOfDay(new Date());
    const times: number[] = [today.getTime()];
    visibleRows.forEach((row) => {
      if (row.type !== 'stage' || !row.stage) return;
      times.push(startOfDay(row.stage.startDate).getTime(), startOfDay(row.stage.endDate).getTime());
    });
    const start = hAddDays(new Date(Math.min(...times)), -hPadDays);
    const end = hAddDays(new Date(Math.max(...times)), hPadDays);
    return { axisStart: start, totalDays: Math.max(1, hDaysBetween(start, end)), today };
  }, [visibleRows, hPadDays]);

  // Ay başlıkları — ardışık aynı aya ait günler tek kutuda gruplanır.
  const hMonthGroups = useMemo(() => {
    const groups: { label: string; startDay: number; dayCount: number }[] = [];
    for (let i = 0; i <= hAxis.totalDays; i += 1) {
      const d = hAddDays(hAxis.axisStart, i);
      const label = `${MONTH_LABELS_LONG[d.getMonth()]} ${d.getFullYear()}`;
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.dayCount += 1;
      else groups.push({ label, startDay: i, dayCount: 1 });
    }
    return groups;
  }, [hAxis]);

  const hShowEveryDay = hDayWidth >= H_DAY_LABEL_MIN_WIDTH;
  const hTotalWidth = hAxis.totalDays * hDayWidth;
  const hTodayOffset = hDaysBetween(hAxis.axisStart, hAxis.today);

  // Ekseni bugüne ortala. DİKKAT: bu bileşen Dikey seçiliyken de mount'ludur
  // (yalnızca CSS ile gizlenir) — gizliyken clientWidth 0 olduğu için ortalama
  // tutmaz. Bu yüzden "yapıldı" işareti ancak eleman GERÇEKTEN görünürken
  // (clientWidth > 0) konur; aksi halde görünür olunca tekrar denenir.
  const hScrollRef = useRef<HTMLDivElement | null>(null);
  // Yatay gövdenin DOM düğümü, ref'in YANI SIRA state olarak da tutulur. Sebep:
  // bileşen isLoading/error durumlarında ERKEN return ediyor, yani gövde ilk
  // render'da HİÇ oluşmuyor. Yalnızca ref kullanılsaydı, native olay dinleyicisi
  // ekleyen effect ilk çalışmasında ref'i null bulur ve bağımlılıkları değişmediği
  // için BİR DAHA çalışmazdı — dinleyici hiç bağlanmazdı (Ctrl+tekerlek'in
  // çalışmama sebebi tam olarak buydu). State ile düğüm DOM'a girdiği anda effect
  // yeniden tetiklenir. Callback useCallback ile stabil tutulur; inline arrow
  // olsaydı React her render'da null→düğüm çağırır ve sonsuz döngü olurdu.
  const [hScrollEl, setHScrollEl] = useState<HTMLDivElement | null>(null);
  const setHScrollNode = useCallback((el: HTMLDivElement | null) => {
    ganttBodyRef.current = el;
    hScrollRef.current = el;
    setHScrollEl(el);
  }, []);
  const hCenteredRef = useRef(false);
  const hCenterOnToday = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = hScrollRef.current;
    if (!el || el.clientWidth === 0) return false;
    el.scrollTo({ left: Math.max(0, hTodayOffset * hDayWidth - el.clientWidth / 2), behavior });
    return true;
  }, [hTodayOffset, hDayWidth]);

  useEffect(() => {
    if (!isHorizontal) return;
    if (hCenteredRef.current || visibleRows.length === 0) return;
    if (hCenterOnToday('auto')) hCenteredRef.current = true;
  });

  // Zoom sırasında bir "çapa" sabit tutulur: hangi gün ekranın neresinde duruyorsa
  // yeni ölçekte de aynı piksel konumunda dursun. Aksi halde her adımda takvim başka
  // bir tarihe savrulur ve kullanıcı yerini kaybeder. Çapa, butonla zoom'da ekranın
  // ORTASI, Ctrl+tekerlekte İMLECİN ALTIDIR (harita/görsel zoom'larındaki alışılmış
  // davranış — imlecin gösterdiği gün yerinde kalır).
  const hZoomAnchorRef = useRef<{ day: number; viewportX: number } | null>(null);
  const changeHZoom = useCallback((delta: number, viewportX?: number) => {
    setHZoomIdx((prev) => {
      const next = Math.min(H_ZOOM_STEPS.length - 1, Math.max(0, prev + delta));
      if (next === prev) return prev;
      const el = hScrollRef.current;
      if (el && el.clientWidth > 0) {
        const base = zoomLevel === 'yearly' ? H_DAY_WIDTH_YEARLY : H_DAY_WIDTH_MONTHLY;
        const anchorX = viewportX ?? el.clientWidth / 2;
        hZoomAnchorRef.current = {
          day: (el.scrollLeft + anchorX) / (base * H_ZOOM_STEPS[prev]),
          viewportX: anchorX,
        };
      }
      return next;
    });
  }, [zoomLevel]);

  // Yeni genişlik DOM'a yazıldıktan SONRA, ama tarayıcı boyamadan ÖNCE (useLayoutEffect)
  // scroll yeniden kurulur — böylece ara karede zıplama GÖRÜNMEZ. useEffect ile
  // yapılsaydı tarayıcı önce kaymış hâli boyar, sonra düzeltirdi (görünür titreme).
  useLayoutEffect(() => {
    const anchor = hZoomAnchorRef.current;
    if (!anchor) return;
    hZoomAnchorRef.current = null;
    const el = hScrollRef.current;
    if (!el || el.clientWidth === 0) return;
    el.scrollLeft = Math.max(0, anchor.day * hDayWidth - anchor.viewportX);
  }, [hDayWidth]);

  // Ctrl + fare tekerleği (ve trackpad'de "pinch", tarayıcının ctrlKey'li wheel
  // olarak ilettiği jest) ile yakınlaştırma. passive:false ŞART — preventDefault
  // olmadan tarayıcı kendi SAYFA zoom'unu uygular ve tüm arayüz büyür.
  // Delta doğrudan kademeye çevrilmez, eşiğe kadar biriktirilir: trackpad'ler çok
  // sayıda küçük olay üretir, her biri bir kademe atlasaydı zoom kontrolsüz uçardı.
  useEffect(() => {
    if (!isHorizontal) return;
    const el = hScrollEl;
    if (!el) return;
    let accumulated = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // Ctrl'süz tekerlek normal kaydırma olarak kalır
      e.preventDefault();
      // deltaMode: 0=piksel, 1=satır, 2=sayfa — hepsi kabaca piksele normalize edilir,
      // yoksa satır modundaki tarayıcılarda (deltaY≈3) eşik hiç aşılmaz.
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      accumulated += px;
      if (Math.abs(accumulated) < 30) return;
      const step = accumulated > 0 ? -1 : 1; // tekerlek aşağı/kendine doğru = uzaklaştır
      accumulated = 0;
      changeHZoom(step, e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isHorizontal, changeHZoom, hScrollEl]);

  // Başlık, kesintisiz eksende ekranın ORTASINDAKİ aya göre canlı güncellenir —
  // aksi halde Aralık 2025'e bakarken başlıkta "Temmuz 2026" yazıyordu.
  const [hCenterLabel, setHCenterLabel] = useState('');
  useEffect(() => {
    if (!isHorizontal) return;
    const el = hScrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const centerDay = Math.floor((el.scrollLeft + el.clientWidth / 2) / hDayWidth);
      const d = hAddDays(hAxis.axisStart, Math.max(0, Math.min(hAxis.totalDays, centerDay)));
      setHCenterLabel(`${MONTH_LABELS_LONG[d.getMonth()]} ${d.getFullYear()}`);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [isHorizontal, hAxis, hDayWidth, visibleRows.length]);

  const handleTreeScroll = () => {
    if (treeRef.current && ganttBodyRef.current) {
      ganttBodyRef.current.scrollTop = treeRef.current.scrollTop;
    }
  };

  const handleGanttScroll = () => {
    if (ganttBodyRef.current && treeRef.current) {
      treeRef.current.scrollTop = ganttBodyRef.current.scrollTop;
    }
  };

  const handleYearlyTreeScroll = () => {
    if (yearlyTreeRef.current && yearlyGanttRef.current) {
      yearlyGanttRef.current.scrollTop = yearlyTreeRef.current.scrollTop;
    }
  };

  const handleYearlyGanttScroll = () => {
    if (yearlyGanttRef.current && yearlyTreeRef.current) {
      yearlyTreeRef.current.scrollTop = yearlyGanttRef.current.scrollTop;
    }
  };

  const getGridLines = () => {
    const lines: React.ReactNode[] = [];
    for (let u = 0; u <= viewRange.unitCount; u++) {
      lines.push(
        <div
          key={`gl-${u}`}
          className="absolute top-0 h-full border-l border-surface-700/30"
          style={{ left: `${(u / viewRange.unitCount) * 100}%`, zIndex: 1 }}
        />,
      );
    }
    return lines;
  };

  const timelineLabels = useMemo(() => {
    return Array.from({ length: viewRange.unitCount }, (_, dayIndex) => ({
      label: String(dayIndex + 1),
      colSpan: 1,
    }));
  }, [viewRange.unitCount]);

  /* Header, Özet ve Adım görünümleriyle BİREBİR aynı bileşendir
     (bkz. CalendarHeader) — görünüm değişince yeri/yüksekliği oynamasın diye.
     Ayrıca yükleniyor/hata dallarının da ÜSTÜNDE render edilir: Özet'ten
     Detay'a geçerken sayfanın tamamı spinner'a dönmez, yalnızca gövde. */
  const header = (
    <CalendarHeader
      onPrev={
        isHorizontal
          /* Kesintisiz eksende "ay değiştirme" yoktur; ekseni kaydırır. */
          ? () => hScrollRef.current?.scrollBy({ left: -30 * hDayWidth, behavior: 'smooth' })
          : zoomLevel === 'monthly' ? goPrevMonth : goPrevYear
      }
      onNext={
        isHorizontal
          ? () => hScrollRef.current?.scrollBy({ left: 30 * hDayWidth, behavior: 'smooth' })
          : zoomLevel === 'monthly' ? goNextMonth : goNextYear
      }
      prevAriaLabel={isHorizontal ? 'Geri kaydır' : zoomLevel === 'monthly' ? 'Önceki ay' : 'Önceki yıl'}
      nextAriaLabel={isHorizontal ? 'İleri kaydır' : zoomLevel === 'monthly' ? 'Sonraki ay' : 'Sonraki yıl'}
      title={isHorizontal ? hCenterLabel : viewRange.label}
      controls={headerExtra}
      onCreateDelivery={onCreateDelivery}
    />
  );

  if (isLoading) {
    return (
      <div className="h-full flex flex-col bg-surface-950">
        {header}
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <svg className="animate-spin h-10 w-10 text-primary-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <span className="ml-3 text-surface-400">Yükleniyor...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col bg-surface-950">
        {header}
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <div className="text-center">
            <svg className="w-16 h-16 text-red-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-surface-300 text-lg font-medium">{error}</p>
            <button type="button" onClick={fetchData} className="btn-ghost mt-2 py-1.5 px-3 text-sm">
              Tekrar Dene
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-950">
      {header}

      {/* Main content — Yatay görünüm, DİKEY'in aylık iki panelli düzenini
          (sol ağaç + sağ gövde) aynen kullanır; yalnızca sağ gövde kesintisiz
          zaman eksenine dönüşür. Bu yüzden yıllık dalı yataya girmez. */}
      {zoomLevel === 'yearly' && !isHorizontal ? (
        /* YEARLY VIEW: two-panel layout with resizable sidebar */
        <div ref={sidebarContainerRef} className="flex-1 flex overflow-hidden relative">
          <div
            ref={yearlyTreeRef}
            onScroll={handleYearlyTreeScroll}
            className="flex-shrink-0 overflow-y-auto overflow-x-hidden bg-surface-900/30 gantt-scroll"
            style={{ width: `${sidebarWidth}px` }}
          >
            <YearlyTable
              monthBuckets={monthBuckets}
              year={yearViewYear}
              collapsedOrders={collapsedOrders}
              collapsedSplits={collapsedSplits}
              toggleOrder={toggleOrder}
              toggleSplit={toggleSplit}
              onTaskClick={onTaskClick}
              sidebarWidth={sidebarWidth}
              displayMode="labels"
              monthScopedCollapse
              holidayKeys={holidayKeys}
              highlightScopeId={highlightScopeId}
              hoveredOrderId={hoveredOrderId}
              onHoverOrderChange={setHoveredOrderId}
            />
          </div>

          <div
            className={`flex-shrink-0 bg-surface-800 border-x border-surface-700/50 cursor-col-resize hover:bg-surface-700 transition-colors ${isSidebarResizing ? 'bg-surface-700' : ''}`}
            onMouseDown={startSidebarResize}
            style={{ width: '8px' }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Sipariş listesi boyut ayırıcı"
          />

          <div className="flex-1 flex flex-col overflow-hidden">
            <div
              ref={yearlyGanttRef}
              onScroll={handleYearlyGanttScroll}
              className="flex-1 overflow-auto relative gantt-scroll"
            >
              <YearlyTable
                monthBuckets={monthBuckets}
                year={yearViewYear}
                collapsedOrders={collapsedOrders}
                collapsedSplits={collapsedSplits}
                toggleOrder={toggleOrder}
                toggleSplit={toggleSplit}
                onTaskClick={onTaskClick}
                sidebarWidth={sidebarWidth}
                displayMode="gantt"
                monthScopedCollapse
                holidayKeys={holidayKeys}
                highlightScopeId={highlightScopeId}
                hoveredOrderId={hoveredOrderId}
                onHoverOrderChange={setHoveredOrderId}
              />
            </div>
          </div>
        </div>
      ) : (
        /* MONTHLY VIEW: two-panel layout with resizable sidebar */
        <div ref={sidebarContainerRef} className="flex-1 flex overflow-hidden relative">
          <div
            ref={treeRef}
            onScroll={handleTreeScroll}
            className="flex-shrink-0 overflow-y-auto bg-surface-900/30 gantt-scroll"
            style={{ width: `${sidebarWidth}px` }}
          >
            {/* Bu başlık, sağ gövdedeki cetvelle AYNI yükseklikte olmalı —
                aksi halde satırlar iki panelde farklı y'den başlar ve barlar
                etiketlerinden kayar. Yatay görünümde cetvel iki satırlı
                (H_RULER_H), dikeyde ise tek satırlık gün başlığıdır; bu yüzden
                yükseklik yalnızca yatayda sabitlenir. */}
            <div
              className="sticky top-0 z-20 bg-surface-800 px-3 py-2 border-b border-surface-700/50 text-xs font-semibold text-surface-400 uppercase tracking-wider"
              style={isHorizontal ? { height: `${H_RULER_H}px`, display: 'flex', alignItems: 'center', boxSizing: 'border-box' } : undefined}
            >
              Sipariş / Ürün
              {visibleOrders.length > 0 && (
                <span className="ml-2 font-normal text-surface-500">({visibleOrders.length} sipariş)</span>
              )}
            </div>

            <div style={{ minHeight: `${totalHeight}px` }}>
              {visibleRows.length === 0 && !isLoading && (
                <div className="flex items-center justify-center h-32 text-surface-500 text-sm">
                  Seçili dönemde sipariş bulunamadı
                </div>
              )}

              {visibleOrders.map((order) => {
                const isCollapsed = collapsedOrders.has(order.id);
                const totalQty = order.splits.reduce((sum, s) => sum + s.quantity, 0);
                const orderLabel = totalQty > 0
                  ? `${order.externalId} - ${order.orderText} - ${totalQty} adet`
                  : `${order.externalId} - ${order.orderText}`;

                return (
                  <Fragment key={order.id}>
                    <div
                      className="flex items-center bg-surface-800/40 hover:bg-surface-800/60 border-b border-surface-700/20"
                      style={{ height: `${ROW_HEIGHT_ORDER}px`, paddingLeft: '12px', boxSizing: 'border-box' }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleOrder(order.id)}
                        className="flex items-center gap-2 flex-1 text-left"
                      >
                        <svg
                          className={`w-3.5 h-3.5 text-surface-400 transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className="text-xs font-bold text-primary-400 truncate">{orderLabel}</span>
                      </button>
                    </div>

                    <AnimatedCollapse open={!isCollapsed}>
                      {order.splits.map(split => {
                        const hasMultipleSplits = order.isExplicitSplit || order.splits.filter(s => s.id.startsWith('split_') && !s.id.startsWith('split_fake_')).length > 1;
                        const isSplitCollapsed = hasMultipleSplits && collapsedSplits.has(split.id);
                        const fmtDate = split.deliveryDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
                        const splitLabel = `🧩 ${split.quantity} adet · ${fmtDate}`;
                        const stageDepth = hasMultipleSplits ? 2 : 1;

                        const stageRows = split.stages.map(stage => (
                          <div
                            key={`stage-${stage.id}`}
                            className="flex items-center hover:bg-surface-800/20 border-b border-surface-700/20"
                            style={{ height: `${ROW_HEIGHT_STAGE}px`, paddingLeft: `${stageDepth * TREE_INDENT + 12}px`, boxSizing: 'border-box' }}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              {renderStageIcon(stage.stageKey)}
                              <span className="text-xs text-surface-300 truncate">{stage.stageLabel}</span>
                            </div>
                          </div>
                        ));

                        if (!hasMultipleSplits) {
                          return <Fragment key={split.id}>{stageRows}</Fragment>;
                        }

                        return (
                          <Fragment key={split.id}>
                            <div
                              className="flex items-center hover:bg-surface-800/30 border-b border-surface-700/20"
                              style={{ height: `${ROW_HEIGHT_SPLIT}px`, paddingLeft: `${TREE_INDENT + 12}px`, boxSizing: 'border-box' }}
                            >
                              <button
                                type="button"
                                onClick={() => toggleSplit(split.id)}
                                className="flex items-center gap-2 flex-1 text-left"
                              >
                                <svg
                                  className={`w-3 h-3 text-surface-500 transition-transform flex-shrink-0 ${isSplitCollapsed ? '' : 'rotate-90'}`}
                                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                                </svg>
                                <span className="text-xs font-medium text-surface-300 truncate">{splitLabel}</span>
                              </button>
                            </div>
                            <AnimatedCollapse open={!isSplitCollapsed}>
                              {stageRows}
                            </AnimatedCollapse>
                          </Fragment>
                        );
                      })}
                      {order.components.map(component => {
                        const isComponentCollapsed = collapsedSplits.has(component.id);
                        const componentLabel = `📦 ${component.productType} — ${component.quantity} adet`;

                        const stageRows = component.stages.map(stage => (
                          <div
                            key={`stage-${stage.id}`}
                            className="flex items-center hover:bg-surface-800/20 border-b border-surface-700/20"
                            style={{ height: `${ROW_HEIGHT_STAGE}px`, paddingLeft: `${2 * TREE_INDENT + 12}px`, boxSizing: 'border-box' }}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              {renderStageIcon(stage.stageKey)}
                              <span className="text-xs text-surface-300 truncate">{stage.stageLabel}</span>
                            </div>
                          </div>
                        ));

                        return (
                          <Fragment key={component.id}>
                            <div
                              className="flex items-center hover:bg-amber-500/10 border-b border-surface-700/20"
                              style={{ height: `${ROW_HEIGHT_SPLIT}px`, paddingLeft: `${TREE_INDENT + 12}px`, boxSizing: 'border-box' }}
                            >
                              <button
                                type="button"
                                onClick={() => toggleSplit(component.id)}
                                className="flex items-center gap-2 flex-1 text-left"
                              >
                                <svg
                                  className={`w-3 h-3 text-amber-500/70 transition-transform flex-shrink-0 ${isComponentCollapsed ? '' : 'rotate-90'}`}
                                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                                </svg>
                                <span className="text-xs font-medium gantt-component-label-text truncate">{componentLabel}</span>
                              </button>
                            </div>
                            <AnimatedCollapse open={!isComponentCollapsed}>
                              {stageRows}
                            </AnimatedCollapse>
                          </Fragment>
                        );
                      })}
                    </AnimatedCollapse>
                  </Fragment>
                );
              })}
            </div>
          </div>

          <div
            className={`flex-shrink-0 bg-surface-800 border-x border-surface-700/50 cursor-col-resize hover:bg-surface-700 transition-colors ${isSidebarResizing ? 'bg-surface-700' : ''}`}
            onMouseDown={startSidebarResize}
            style={{ width: '8px' }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Sipariş listesi boyut ayırıcı"
          />

          <div className="flex-1 flex flex-col overflow-hidden">
            {isHorizontal ? (
              /* YATAY GÖVDE — kesintisiz eksen. Dikey kaydırma sol ağaçla
                 senkron (handleGanttScroll), yatay kaydırma serbesttir. */
              <div
                ref={setHScrollNode}
                onScroll={handleGanttScroll}
                className="flex-1 overflow-auto relative gantt-scroll"
              >
                <div className="relative" style={{ width: `${hTotalWidth}px`, height: `${H_RULER_H + totalHeight}px` }}>
                  {/* Cetvel: ay kutuları + gün numaraları */}
                  <div className="sticky top-0 z-30 bg-surface-800 border-b-2 border-surface-700/50" style={{ height: `${H_RULER_H}px` }}>
                    <div className="relative border-b border-surface-800/60" style={{ height: `${H_RULER_MONTH_H}px` }}>
                      {hMonthGroups.map((g) => (
                        <div
                          key={g.label}
                          className="absolute inset-y-0 flex items-center justify-center text-[10px] font-semibold text-surface-300 uppercase tracking-wide border-l border-surface-700/40 truncate px-1"
                          style={{ left: `${g.startDay * hDayWidth}px`, width: `${g.dayCount * hDayWidth}px` }}
                        >
                          {g.label}
                        </div>
                      ))}
                    </div>
                    <div className="relative" style={{ height: `${H_RULER_DAY_H}px` }}>
                      {Array.from({ length: hAxis.totalDays }, (_, i) => {
                        const d = hAddDays(hAxis.axisStart, i);
                        // Dar yakınlaştırmada (Yıllık) her gün okunaksız olur;
                        // yalnızca kılavuz günler yazılır.
                        if (!hShowEveryDay && !H_DAY_MARKERS.includes(d.getDate())) return null;
                        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                        return (
                          <div
                            key={hDateKey(d)}
                            className={`absolute inset-y-0 flex items-center justify-center text-[9px] border-l border-surface-800/40 ${isWeekend ? 'text-surface-600' : 'text-surface-500'}`}
                            style={{ left: `${i * hDayWidth}px`, width: `${hDayWidth}px` }}
                          >
                            {d.getDate()}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Gün sütunları: iş günü / çalışılmayan / bugün */}
                  {Array.from({ length: hAxis.totalDays }, (_, i) => {
                    const d = hAddDays(hAxis.axisStart, i);
                    const isToday = i === hTodayOffset;
                    const isOff = d.getDay() === 0 || d.getDay() === 6 || !!holidayKeySet?.has(hDateKey(d));
                    return (
                      <div
                        key={hDateKey(d)}
                        className={`absolute pointer-events-none ${isToday ? 'htv-day-today' : isOff ? 'htv-day-offday' : 'htv-day-workday'}${hShowEveryDay ? ' htv-day-divider' : ''}`}
                        style={{ left: `${i * hDayWidth}px`, width: `${hDayWidth}px`, top: `${H_RULER_H}px`, height: `${Math.max(totalHeight, 0)}px` }}
                      />
                    );
                  })}

                  {/* Bar'lar — her satır (stage) tek bir bara aittir, sol
                      ağaçtaki etiketiyle aynı y'de durur. */}
                  {(() => {
                    let y = H_RULER_H;
                    return visibleRows.map((row) => {
                      const h = getRowHeight(row.type);
                      const top = y;
                      y += h;

                      // Kapatilmis siparis/parca satiri: altindaki asamalar gizli
                      // oldugu icin satir bos kalirdi. Ayar acikken bunun yerine,
                      // gizlenen tum asamalari kapsayan TEK notr bir ozet bar cizilir
                      // (10 bar yerine 1) — tiklayinca satir yeniden acilir.
                      // 'month' satirlari yalnizca ayirici basliktir, kendi tarih
                      // araligi yoktur — ozet bar disinda kalir.
                      if (row.type === 'order' || row.type === 'split') {
                        if (!showCollapsedSummaryBar) return null;
                        const isRowCollapsed = row.type === 'order'
                          ? collapsedOrders.has(row.order.id)
                          : collapsedSplits.has(row.splitId);
                        if (!isRowCollapsed) return null;
                        const range = row.type === 'order' ? row.order : row.split;
                        const sStart = startOfDay(range.overallStart);
                        const sEnd = startOfDay(range.overallEnd);
                        const sLeft = hDaysBetween(hAxis.axisStart, sStart) * hDayWidth;
                        const sGap = Math.min(4, hDayWidth * 0.25);
                        const sWidth = Math.max(3, (hDaysBetween(sStart, sEnd) + 1) * hDayWidth - sGap);
                        const sBarH = h - 12;
                        const label = formatDateRange(range.overallStart, range.overallEnd);
                        return (
                          <button
                            key={row.id}
                            type="button"
                            onClick={() => (row.type === 'order' ? toggleOrder(row.order.id) : toggleSplit(row.splitId))}
                            onMouseEnter={() => setHoveredOrderId(row.order.id)}
                            onMouseLeave={() => setHoveredOrderId(null)}
                            className={`absolute rounded-md flex items-center overflow-hidden px-2 cursor-pointer hover:brightness-125 z-20 border border-dashed ${SUMMARY_BAR_CLASS}`}
                            style={{
                              left: `${sLeft}px`, width: `${sWidth}px`,
                              top: `${top + (h - sBarH) / 2}px`, height: `${sBarH}px`,
                            }}
                            title={`${label} — adımları göstermek için tıklayın`}
                          >
                            <span className="text-[11px] font-medium whitespace-nowrap truncate opacity-90">{label}</span>
                          </button>
                        );
                      }

                      if (row.type !== 'stage' || !row.stage) return null;
                      const start = startOfDay(row.stage.startDate);
                      const end = startOfDay(row.stage.endDate);
                      const left = hDaysBetween(hAxis.axisStart, start) * hDayWidth;
                      // Barlar arası görsel boşluk gün genişliğine ORANLANIR: sabit 4px,
                      // uzaklaştırıldığında (yıllık + en düşük kademede gün ~4px) tek günlük
                      // bir aşamanın genişliğini sıfıra indirip barı tamamen görünmez yapıyordu.
                      // Alttaki 3px taban da, eksik/bozuk tarihli (end < start) satırlarda bile
                      // en azından görünür bir iz kalmasını garanti eder.
                      const barGap = Math.min(4, hDayWidth * 0.25);
                      const width = Math.max(3, (hDaysBetween(start, end) + 1) * hDayWidth - barGap);
                      const barH = h - 8;
                      const color = getStageBarColor(row.stage.stageKey, row.stage.isOutsourced);
                      const highlighted = (!!highlightScopeId && getHighlightScopeId(row.stage.id) === highlightScopeId)
                        || row.order.id === hoveredOrderId;
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => onTaskClick?.(row.stage!.id)}
                          onMouseEnter={() => setHoveredOrderId(row.order.id)}
                          onMouseLeave={() => setHoveredOrderId(null)}
                          className={`absolute rounded-md flex items-center overflow-hidden px-2 cursor-pointer hover:brightness-110 z-20 ${groupHighlightClass(highlighted, isComponentSplit(row.order, row.split!))}`}
                          style={{
                            left: `${left}px`, width: `${width}px`,
                            top: `${top + (h - barH) / 2}px`, height: `${barH}px`,
                            backgroundColor: color.bg, color: color.fg,
                          }}
                          title={`${row.stage.stageLabel} — ${formatDateRange(row.stage.startDate, row.stage.endDate)}`}
                        >
                          <span className="text-[11px] font-medium whitespace-nowrap truncate">
                            {formatDateRange(row.stage.startDate, row.stage.endDate)}
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
              </div>
            ) : (
            <div
              ref={ganttBodyRef}
              onScroll={handleGanttScroll}
              className="flex-1 overflow-auto relative gantt-scroll"
            >
              <div className="sticky top-0 z-20 bg-surface-800 border-b border-surface-700/50 w-full">
                <div className="flex border-b border-surface-700/30" style={{ height: '31px' }}>
                  {timelineLabels.map((_, i) => {
                    const dayNumber = i + 1;
                    const isInvalidDay = dayNumber > getDaysInMonth(calendarDate);
                    const now = new Date();
                    const isToday = !isInvalidDay && now.getFullYear() === calendarDate.getFullYear() && now.getMonth() === calendarDate.getMonth() && now.getDate() === dayNumber;
                    return (
                      <div
                        key={`dh-${dayNumber}`}
                        className={`flex-1 flex items-center justify-center text-[11px] border-r border-surface-700/20 min-w-0 ${isInvalidDay ? 'text-surface-600' : isToday ? 'text-red-400 font-bold' : 'text-surface-400'}`}
                        style={{ boxSizing: 'border-box' }}
                      >
                        {dayNumber}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div
                className="relative w-full"
                style={{ height: `${totalHeight}px` }}
              >
                {getGridLines()}

                {(() => {
                  const now = new Date();
                  if (now.getFullYear() !== calendarDate.getFullYear() || now.getMonth() !== calendarDate.getMonth()) return null;
                  const dayIndex = now.getDate() - 1;
                  return (
                    <div
                      className="absolute top-0 w-0.5 bg-red-500/70 z-10"
                      style={{ left: `${(dayIndex / 31) * 100}%`, height: `${totalHeight}px` }}
                    />
                  );
                })()}

                {(() => {
                  let yOffset = 0;
                  return visibleRows.map((row) => {
                    const height = getRowHeight(row.type);
                    const barHeight = height - 8;
                    const el = (
                      <div
                        key={row.id}
                        className="absolute w-full border-b border-surface-700/20"
                        style={{ top: `${yOffset}px`, height: `${height}px`, boxSizing: 'border-box', zIndex: 2 }}
                      >
                        {/* Kapatilmis siparis/parca satiri: gizlenen tum asamalari
                            kapsayan tek notr ozet bar (bkz. Gorunum Ayarlari).
                            Tiklayinca satir yeniden acilir. */}
                        {(row.type === 'order' || row.type === 'split') && showCollapsedSummaryBar && (() => {
                          const isRowCollapsed = row.type === 'order'
                            ? collapsedOrders.has(row.order.id)
                            : collapsedSplits.has(row.splitId);
                          if (!isRowCollapsed) return null;
                          const range = row.type === 'order' ? row.order : row.split;
                          const label = formatDateRange(range.overallStart, range.overallEnd);
                          const summaryH = height - 12;
                          return (
                            <div
                              className={`overflow-hidden flex items-center cursor-pointer hover:brightness-125 transition-all z-20 rounded-md border border-dashed ${SUMMARY_BAR_CLASS}`}
                              onClick={() => (row.type === 'order' ? toggleOrder(row.order.id) : toggleSplit(row.splitId))}
                              onMouseEnter={() => setHoveredOrderId(row.order.id)}
                              onMouseLeave={() => setHoveredOrderId(null)}
                              title={`${label} — adımları göstermek için tıklayın`}
                              style={{
                                ...getMonthlyRangeStyle(range.overallStart, range.overallEnd, calendarDate),
                                top: `${(height - summaryH) / 2}px`,
                                height: `${summaryH}px`,
                              }}
                            >
                              <span className="px-2 text-[11px] font-medium leading-tight whitespace-nowrap truncate opacity-90">
                                {label}
                              </span>
                            </div>
                          );
                        })()}
                        {row.type === 'stage' && row.stage && (
                          <div
                            className={`overflow-visible flex items-center flex-shrink-0 cursor-pointer hover:brightness-110 transition-all z-20 ${groupHighlightClass(
                              (!!highlightScopeId && getHighlightScopeId(row.stage.id) === highlightScopeId)
                                || row.order.id === hoveredOrderId,
                              isComponentSplit(row.order, row.split),
                            )}`}
                            onClick={() => onTaskClick?.(row.stage!.id)}
                            onMouseEnter={() => setHoveredOrderId(row.order.id)}
                            onMouseLeave={() => setHoveredOrderId(null)}
                            title={`${row.stage.stageLabel} — detay için tıklayın`}
                            style={{
                              ...getMonthlyBarStyle(row.stage, calendarDate),
                              position: 'absolute',
                              top: `${(height - barHeight) / 2}px`,
                              height: `${barHeight}px`,
                              borderRadius: '6px',
                              borderWidth: '1px',
                              borderStyle: 'solid',
                            }}
                          >
                            {row.stage.stageKey === 'delivery' && (
                              <div className="flex items-center justify-center ml-1 flex-shrink-0">
                                <svg className="w-3.5 h-3.5 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                </svg>
                              </div>
                            )}
                            <div className="flex-1 flex items-center justify-center min-w-0" style={{ paddingLeft: '4px', paddingRight: '4px' }}>
                              <span className="text-[11px] font-medium leading-tight whitespace-nowrap truncate opacity-90">
                                {formatDateRange(row.stage.startDate, row.stage.endDate)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                    yOffset += height;
                    return el;
                  });
                })()}
              </div>
            </div>
            )}
          </div>
        </div>
      )}

      {/* Legend — STAGE_LEGEND_ITEMS ortak kaynağından; Fason (dış dizgi) artık
          Üretim'den farklı bir renge sahip olduğu için kendi satırıyla yer alır. */}
      <div className="flex-shrink-0 px-4 py-2 border-t border-surface-700/50 bg-surface-900/50 flex items-center gap-4">
        {STAGE_LEGEND_ITEMS.map((item) => (
          <div key={`${item.key}-${item.isOutsourced ? 'out' : 'in'}`} className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm inline-block" style={{ backgroundColor: getStageBarColor(item.key, item.isOutsourced).bg }} />
            <span className="text-xs text-surface-400">{getStageLabel(item.key, item.isOutsourced)}</span>
          </div>
        ))}

        {/* Yakınlaştırma — yalnızca Yatay görünümde anlamlı: orada eksen kesintisiz
            ve gün başına piksel genişliği ölçeklenebilir. Dikey görünüm sabit
            31 günlük aylık ızgara kullandığı için burada gösterilmez. */}
        {isHorizontal && (
          <div className="ml-auto flex items-center gap-1 flex-shrink-0">
            <span
              className="text-[11px] text-surface-500 mr-1 hidden sm:inline cursor-help"
              title="Takvim üzerinde Ctrl tuşuna basılı tutarak fare tekerleğini çevirerek de yakınlaştırabilirsiniz."
            >
              Yakınlaştırma
            </span>
            <button
              type="button"
              onClick={() => changeHZoom(-1)}
              disabled={hZoomIdx === 0}
              className="w-6 h-6 flex items-center justify-center rounded border border-surface-700/60 bg-surface-800/60 text-surface-300 hover:bg-surface-700 hover:text-white disabled:opacity-30 disabled:hover:bg-surface-800/60 disabled:cursor-not-allowed transition-colors"
              title="Uzaklaştır — daha geniş bir tarih aralığı görünür (Ctrl + fare tekerleği)"
              aria-label="Uzaklaştır"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M20 12H4" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setHZoomIdx(H_ZOOM_DEFAULT_IDX)}
              className="min-w-[46px] h-6 px-1.5 flex items-center justify-center rounded border border-surface-700/60 bg-surface-800/60 text-[11px] font-medium text-surface-300 hover:bg-surface-700 hover:text-white transition-colors tabular-nums"
              title="Varsayılan yakınlaştırmaya dön (%100)"
              aria-label="Yakınlaştırmayı sıfırla"
            >
              %{Math.round(hZoom * 100)}
            </button>
            <button
              type="button"
              onClick={() => changeHZoom(1)}
              disabled={hZoomIdx === H_ZOOM_STEPS.length - 1}
              className="w-6 h-6 flex items-center justify-center rounded border border-surface-700/60 bg-surface-800/60 text-surface-300 hover:bg-surface-700 hover:text-white disabled:opacity-30 disabled:hover:bg-surface-800/60 disabled:cursor-not-allowed transition-colors"
              title="Yakınlaştır — günler daha geniş görünür (Ctrl + fare tekerleği)"
              aria-label="Yakınlaştır"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16M20 12H4" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
