/**
 * İstatistikler — planlama odaklı teslimat/sipariş özeti.
 *
 * Tek bir /statistics/summary çağrısından beslenir: sayfadaki her kutu aynı
 * "bugün" ve aynı dönem üzerinden hesaplanır, aksi halde paralel isteklerde
 * kartlar birbiriyle çelişen sayılar gösterebilirdi.
 *
 * Sayfada İKİ kapsam var ve bu ayrım arayüzde de açıkça yazılı:
 *   • Üstteki "Genel Durum" şeridi ve "Geciken Teslimatlar" listesi TÜM veriye,
 *     bugüne göredir — dönem gezinmesinden etkilenmez. Kullanıcı 2029'a baksa
 *     bile "şu an 6 teslimat gecikmiş" bilgisi geçerliliğini korumalı.
 *   • Grafik, kırılımlar ve "Dönemdeki Teslimatlar" seçili döneme göredir.
 *
 * Grafik renkleri (SERIES) bilinçli olarak Tailwind sınıfı değil sabit hex:
 * hem açık hem koyu temada aynı üçlü kullanılır ve bu üçlü renk körlüğü
 * ayrışması / yüzey kontrastı açısından ikisinde de doğrulanmıştır.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { getApiErrorMessage } from '../lib/errorMessage';

const SERIES = {
  remaining: '#3b82f6',
  overdue: '#ef4444',
  completed: '#059669',
} as const;

const CHART_HEIGHT = 200;
/** En yüksek çubuğun değer etiketine ayrılan üst boşluk (çizim alanının dışında). */
const BAR_LABEL_HEIGHT = 16;
/** Yığındaki 2px'lik ayırıcı boşluklar (etiket + en fazla 2 segment arası) için
 *  pay. Kaba eklenmezse tam yükseklikteki bir çubuğun değer etiketi kabın
 *  üstünden taşar ve `overflow-x-auto` onu dikeyde de kırpar. */
const BAR_STACK_SLACK = 6;
/** Sütun ne kadar genişlerse genişlesin çubuk bundan kalın olmaz. */
const MAX_BAR_WIDTH = 88;
/** Yıllık görünümde yalnızca birkaç sütun olur; sütunlar tüm genişliğe yayılırsa
 *  ince çubuklar dev boşluklarda kaybolur, bu yüzden satırın kendisi daraltılır. */
const YEAR_COLUMN_WIDTH = 110;
/** Yıllık görünümün kapsadığı yıl sayısı — çapa yılından bir önce başlar. */
const YEAR_SPAN = 5;

type Granularity = 'month' | 'year';
type Metric = 'quantity' | 'count';

interface Totals {
  total_orders: number;
  active_orders: number;
  completed_orders: number;
  total_deliveries: number;
  remaining_deliveries: number;
  remaining_quantity: number;
  completed_deliveries: number;
  completed_quantity: number;
  overdue_deliveries: number;
  overdue_quantity: number;
  this_month_deliveries: number;
  this_month_quantity: number;
  next_30_days_deliveries: number;
  next_30_days_quantity: number;
  at_risk_deliveries: number;
  outsourced_remaining_deliveries: number;
}

interface PeriodTotals {
  delivery_count: number;
  quantity: number;
  remaining_count: number;
  remaining_quantity: number;
  completed_count: number;
  completed_quantity: number;
  overdue_count: number;
  overdue_quantity: number;
  at_risk_count: number;
  avg_per_bucket: number;
  avg_quantity_per_bucket: number;
}

interface Bucket {
  key: string;
  label: string;
  short: string;
  sub: string;
  delivery_count: number;
  quantity: number;
  remaining_count: number;
  remaining_quantity: number;
  completed_count: number;
  completed_quantity: number;
  overdue_count: number;
  overdue_quantity: number;
  is_current: boolean;
  is_past: boolean;
}

interface PeriodInfo {
  granularity: Granularity;
  start: string;
  end: string;
  label: string;
  contains_today: boolean;
}

interface StatusBucket {
  key: string;
  label: string;
  count: number;
  quantity: number;
}

interface CustomerBucket {
  name: string;
  remaining_deliveries: number;
  remaining_quantity: number;
  overdue_deliveries: number;
  next_delivery_date: string | null;
}

interface ProductBucket {
  name: string;
  remaining_deliveries: number;
  remaining_quantity: number;
}

interface DeliveryItem {
  split_id: string;
  order_id: string;
  external_id: string;
  customer_name: string | null;
  product_name: string | null;
  quantity: number;
  delivery_date: string;
  promised_date: string | null;
  days_left: number;
  status_key: string;
  status_label: string;
  is_component: boolean;
  is_outsourced: boolean;
  is_overdue: boolean;
  late_vs_promise: boolean;
}

interface StatisticsSummary {
  generated_at: string;
  today: string;
  period: PeriodInfo;
  totals: Totals;
  period_totals: PeriodTotals;
  buckets: Bucket[];
  status_breakdown: StatusBucket[];
  customers: CustomerBucket[];
  products: ProductBucket[];
  deliveries: DeliveryItem[];
  overdue: DeliveryItem[];
}

const formatNumber = (value: number) =>
  Number.isInteger(value) ? value.toLocaleString('tr-TR') : value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });

const formatDate = (value: string | null) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

/** Çapa yılından, seçili granülerliğe karşılık gelen tarih aralığını üretir.
 *  Aylık = o takvim yılının 12 ayı; yıllık = çapadan bir önceki yıldan başlayan
 *  YEAR_SPAN yıl. İkisinde de ileri/geri gezinme çapayı bir yıl kaydırır, yani
 *  kullanıcı ileri gidip geri döndüğünde tam olarak aynı aralığa döner. */
const rangeFor = (granularity: Granularity, anchorYear: number) =>
  granularity === 'year'
    ? { start: `${anchorYear - 1}-01-01`, end: `${anchorYear - 1 + YEAR_SPAN - 1}-12-31` }
    : { start: `${anchorYear}-01-01`, end: `${anchorYear}-12-31` };

function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'danger' | 'warning' | 'success';
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-red-400'
      : tone === 'warning'
        ? 'text-amber-400'
        : tone === 'success'
          ? 'text-emerald-400'
          : 'text-surface-100';

  return (
    <div className="glass-card p-4 flex flex-col gap-1">
      <p className="text-[11px] uppercase tracking-wider text-surface-500">{label}</p>
      <p className={`text-2xl font-bold leading-tight ${toneClass}`}>{value}</p>
      {hint && <p className="text-xs text-surface-400">{hint}</p>}
    </div>
  );
}

/** Grafik kartının içindeki küçük dönem okuması — kartların aksine kutu değil,
 *  tek satırlık sayı, çünkü üstteki genel şeritle karışmamalı. */
function PeriodStat({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-[11px] text-surface-500">
        {color && <span className="w-2 h-2 rounded-sm" style={{ background: color }} />}
        {label}
      </span>
      <span className="text-base font-semibold text-surface-100 tabular-nums">{value}</span>
      {hint && <span className="text-[11px] text-surface-500">{hint}</span>}
    </div>
  );
}

/** Tek serili yatay büyüklük çubuğu — durum/müşteri/ürün kırılımlarının ortak satırı. */
function BreakdownRow({
  label,
  value,
  max,
  secondary,
  muted,
}: {
  label: string;
  value: number;
  max: number;
  secondary?: string;
  muted?: boolean;
}) {
  const width = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className={`w-32 shrink-0 truncate text-xs ${muted ? 'text-surface-500' : 'text-surface-300'}`} title={label}>
        {label}
      </span>
      <span className="flex-1 h-2.5 rounded-full bg-surface-800/70 overflow-hidden">
        <span
          className="block h-full rounded-full transition-all duration-500"
          style={{ width: `${width}%`, background: SERIES.remaining, opacity: muted ? 0.45 : 1 }}
        />
      </span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-surface-200">
        {formatNumber(value)}
        {secondary && <span className="text-surface-500"> {secondary}</span>}
      </span>
    </div>
  );
}

function DeliveryTable({ items, emptyText }: { items: DeliveryItem[]; emptyText: string }) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-surface-500">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-surface-500">
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">Tarih</th>
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">Zaman</th>
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">Sipariş No</th>
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">Müşteri</th>
            <th className="text-left font-medium py-2 pr-3 whitespace-nowrap">Ürün</th>
            <th className="text-right font-medium py-2 pr-3 whitespace-nowrap">Adet</th>
            <th className="text-left font-medium py-2 whitespace-nowrap">Durum</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const days = Math.abs(item.days_left);
            // Dönem listesinde hem geçmiş hem gelecek tarihli satırlar bir arada
            // olabildiği için üç durum da ayrı okunur.
            const timeCell = item.is_overdue ? (
              <span className="text-red-400 font-medium">{days} gün geç</span>
            ) : item.days_left < 0 ? (
              <span className="text-surface-500">{days} gün önce</span>
            ) : (
              <span className={days <= 7 ? 'text-amber-400 font-medium' : 'text-surface-300'}>{days} gün</span>
            );

            return (
              <tr key={item.split_id} className="border-t border-surface-800/70">
                <td className="py-2 pr-3 whitespace-nowrap text-surface-200">{formatDate(item.delivery_date)}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{timeCell}</td>
                {/* Alt ürün sipariş numaraları uzun ("987654-ANT-4011-P2") — kırpılmazsa
                    bu sütun tabloyu şişirip Durum rozetlerini alt satıra itiyor. */}
                <td className="py-2 pr-3 max-w-32 truncate text-surface-200 font-medium" title={item.external_id}>
                  {item.external_id}
                </td>
                <td className="py-2 pr-3 max-w-40 truncate text-surface-300" title={item.customer_name || ''}>
                  {item.customer_name || '—'}
                </td>
                <td className="py-2 pr-3 max-w-40 truncate text-surface-300" title={item.product_name || ''}>
                  {item.product_name || '—'}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-surface-200">{formatNumber(item.quantity)}</td>
                {/* Rozetler nowrap değil sarmalı — iki liste yan yana durduğunda
                    (2xl) sabit genişlikte kalırlarsa tablonun sağ kenarında yarım
                    kesilmiş rozet görünüyordu. */}
                <td className="py-2">
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="text-surface-300 whitespace-nowrap">{item.status_label}</span>
                    {/* Alt ürünler de sayıldığı için ana sipariş satırlarıyla aynı listede
                        karışıyorlar — hangisinin iç üretim kalemi olduğu görünmeli. */}
                    {item.is_component && (
                      <span className="badge border border-surface-600/60 bg-surface-700/40 text-surface-300 text-[10px] px-1.5 py-0">
                        Alt ürün
                      </span>
                    )}
                    {item.late_vs_promise && (
                      <span className="badge badge-warning border text-[10px] px-1.5 py-0" title="Planlanan bitiş, söz verilen teslim tarihinden sonra">
                        Söz aşımı
                      </span>
                    )}
                    {item.is_outsourced && (
                      <span className="badge badge-info border text-[10px] px-1.5 py-0">Fason</span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function StatisticsPage() {
  const [data, setData] = useState<StatisticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [anchorYear, setAnchorYear] = useState(() => new Date().getFullYear());
  const [metric, setMetric] = useState<Metric>('quantity');
  const [asTable, setAsTable] = useState(false);
  const [hoveredBucket, setHoveredBucket] = useState<string | null>(null);

  const currentYear = new Date().getFullYear();

  const fetchStats = useCallback(async () => {
    try {
      setIsLoading(true);
      const { start, end } = rangeFor(granularity, anchorYear);
      const { data: payload } = await api.get<StatisticsSummary>('/statistics/summary', {
        params: { granularity, start, end },
      });
      setData(payload);
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'İstatistikler yüklenemedi.'));
    } finally {
      setIsLoading(false);
    }
  }, [granularity, anchorYear]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Granülerlik değişince çapa yılı KORUNUR — kullanıcı 2028'e gidip "Yıllık"a
  // bastığında 2028'i içeren aralığı görmeli, başladığı yere geri fırlamamalı.
  const buckets = data?.buckets ?? [];
  const periodTotals = data?.period_totals;
  const totals = data?.totals;

  const chartMax = useMemo(() => {
    const values = buckets.map((b) => (metric === 'quantity' ? b.quantity : b.delivery_count));
    return Math.max(1, ...values);
  }, [buckets, metric]);

  const segmentsFor = useCallback(
    (bucket: Bucket) => {
      const overdue = metric === 'quantity' ? bucket.overdue_quantity : bucket.overdue_count;
      const remainingTotal = metric === 'quantity' ? bucket.remaining_quantity : bucket.remaining_count;
      const completed = metric === 'quantity' ? bucket.completed_quantity : bucket.completed_count;
      // overdue, remaining içinde ZATEN sayılı (backend'deki PeriodTotals notu) —
      // yığmadan önce ayrıştırılır, aksi halde geciken teslimatlar iki kez çizilir.
      const onTime = Math.max(remainingTotal - overdue, 0);
      return { overdue, onTime, completed, total: onTime + overdue + completed };
    },
    [metric],
  );

  const statusMax = Math.max(1, ...(data?.status_breakdown ?? []).map((s) => s.count));
  const customerMax = Math.max(1, ...(data?.customers ?? []).map((c) => c.remaining_quantity));
  const productMax = Math.max(1, ...(data?.products ?? []).map((p) => p.remaining_quantity));

  const bucketWord = granularity === 'year' ? 'yıl' : 'ay';
  const periodLabel = data?.period.label ?? '';
  const isEmptyPeriod = Boolean(periodTotals && periodTotals.delivery_count === 0);

  return (
    <div className="h-full min-h-0 flex flex-col animate-fade-in">
      <div className="px-6 py-5 border-b border-surface-700/50">
        <h1 className="text-2xl font-bold text-white">İstatistikler</h1>
        <p className="text-surface-400 text-sm mt-1">
          {totals
            ? `${formatNumber(totals.active_orders)} aktif sipariş · ${formatNumber(totals.remaining_deliveries)} kalan teslimat · ${formatNumber(totals.remaining_quantity)} adet`
            : 'Teslimat planı ve kalan iş özeti'}
        </p>
      </div>

      {error && (
        <div className="mx-6 mt-4 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {isLoading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <svg className="animate-spin h-8 w-8 text-primary-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </div>
      ) : !data || !totals || !periodTotals ? (
        <div className="flex-1 flex items-center justify-center text-surface-500 text-sm">Gösterilecek veri yok.</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-6 py-6 space-y-6">
          {/* ── Genel durum: dönemden BAĞIMSIZ, bugüne göre ── */}
          <section>
            <p className="text-[11px] uppercase tracking-wider text-surface-500 mb-2">
              Genel durum · bugüne göre · dönem seçiminden etkilenmez
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
              <StatTile
                label="Kalan Teslimat"
                value={formatNumber(totals.remaining_deliveries)}
                hint={`${formatNumber(totals.remaining_quantity)} adet`}
              />
              <StatTile
                label="Bu Ay Teslim"
                value={formatNumber(totals.this_month_deliveries)}
                hint={`${formatNumber(totals.this_month_quantity)} adet`}
              />
              <StatTile
                label="Önümüzdeki 30 Gün"
                value={formatNumber(totals.next_30_days_deliveries)}
                hint={`${formatNumber(totals.next_30_days_quantity)} adet`}
              />
              <StatTile
                label="Geciken"
                value={formatNumber(totals.overdue_deliveries)}
                hint={`${formatNumber(totals.overdue_quantity)} adet · tarihi geçti`}
                tone={totals.overdue_deliveries > 0 ? 'danger' : 'success'}
              />
              <StatTile
                label="Söz Aşımı Riski"
                value={formatNumber(totals.at_risk_deliveries)}
                hint="planlanan bitiş > söz verilen tarih"
                tone={totals.at_risk_deliveries > 0 ? 'warning' : 'success'}
              />
              <StatTile
                label="Aktif Sipariş"
                value={formatNumber(totals.active_orders)}
                hint={`${formatNumber(totals.completed_orders)} tamamlandı`}
              />
            </div>
          </section>

          {/* ── Dönem: grafik + gezinme ── */}
          <section className={`glass-card p-5 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-surface-100">Teslimat Dağılımı</h2>
                <p className="text-xs text-surface-500 mt-0.5">
                  Teslimat tarihine (parçanın bitiş tarihi) göre · {granularity === 'year' ? 'yıllık' : 'aylık'} dağılım
                </p>
              </div>

              {/* Dönem gezinmesi — grafiğin ve altındaki bütün kırılımların kapsamı. */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setAnchorYear((year) => year - 1)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-surface-700/60 text-surface-400 hover:text-surface-100 hover:bg-surface-800/60 transition-colors"
                    aria-label="Önceki dönem"
                    title="Önceki dönem"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <span className="min-w-28 text-center text-sm font-semibold text-surface-100 tabular-nums">
                    {periodLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAnchorYear((year) => year + 1)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-surface-700/60 text-surface-400 hover:text-surface-100 hover:bg-surface-800/60 transition-colors"
                    aria-label="Sonraki dönem"
                    title="Sonraki dönem"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setAnchorYear(currentYear)}
                  disabled={anchorYear === currentYear}
                  className="px-3 py-1.5 text-xs rounded-lg border border-surface-700/60 text-surface-400 hover:text-surface-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Bugün
                </button>
                <div className="flex rounded-lg border border-surface-700/60 overflow-hidden">
                  {(['month', 'year'] as Granularity[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setGranularity(option)}
                      className={`px-3 py-1.5 text-xs transition-colors ${
                        granularity === option ? 'bg-primary-600/25 text-primary-300' : 'text-surface-400 hover:text-surface-200'
                      }`}
                    >
                      {option === 'month' ? 'Aylık' : 'Yıllık'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Seçili dönemin özeti ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-4 border-t border-surface-700/50">
              <PeriodStat
                label={`${periodLabel} toplamı`}
                value={`${formatNumber(periodTotals.delivery_count)} teslimat`}
                hint={`${formatNumber(periodTotals.quantity)} adet`}
              />
              <PeriodStat
                label="Kalan"
                color={SERIES.remaining}
                value={`${formatNumber(periodTotals.remaining_count - periodTotals.overdue_count)} teslimat`}
                hint={`${formatNumber(periodTotals.remaining_quantity - periodTotals.overdue_quantity)} adet`}
              />
              <PeriodStat
                label="Geciken"
                color={SERIES.overdue}
                value={`${formatNumber(periodTotals.overdue_count)} teslimat`}
                hint={`${formatNumber(periodTotals.overdue_quantity)} adet`}
              />
              <PeriodStat
                label="Tamamlanan"
                color={SERIES.completed}
                value={`${formatNumber(periodTotals.completed_count)} teslimat`}
                hint={`${formatNumber(periodTotals.completed_quantity)} adet · ${formatNumber(periodTotals.avg_per_bucket)} teslimat/${bucketWord}`}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 mt-5 mb-4 min-h-[24px]">
              <div className="flex flex-wrap items-center gap-4 text-xs text-surface-400">
                {[
                  { color: SERIES.remaining, label: 'Planlanan (kalan)' },
                  { color: SERIES.overdue, label: 'Geciken' },
                  { color: SERIES.completed, label: 'Tamamlanan' },
                ].map((entry) => (
                  <span key={entry.label} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: entry.color }} />
                    {entry.label}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-surface-700/60 overflow-hidden">
                  {(['quantity', 'count'] as Metric[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setMetric(option)}
                      className={`px-3 py-1.5 text-xs transition-colors ${
                        metric === option ? 'bg-primary-600/25 text-primary-300' : 'text-surface-400 hover:text-surface-200'
                      }`}
                    >
                      {option === 'quantity' ? 'Adet' : 'Teslimat sayısı'}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setAsTable((prev) => !prev)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-surface-700/60 text-surface-400 hover:text-surface-200 transition-colors"
                >
                  {asTable ? 'Grafik' : 'Tablo'}
                </button>
              </div>
            </div>

            {/* Üzerine gelinen kovanın okuması BİLİNÇLİ olarak sabit bir satırda
                duruyor, çubukların üzerinde yüzen bir kutuda değil — en yüksek
                çubuk grafiğin tepesine kadar uzandığı için yüzen kutu onu
                kaçınılmaz olarak örterdi. */}
            {!asTable && (
              <div className="min-h-[20px] mb-2 text-xs">
                {(() => {
                  const bucket = hoveredBucket ? buckets.find((b) => b.key === hoveredBucket) : null;
                  if (!bucket) {
                    return <span className="text-surface-600">Ayrıntı için bir {bucketWord}ın üzerine gelin</span>;
                  }
                  const seg = segmentsFor(bucket);
                  return (
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-semibold text-surface-100">{bucket.label}</span>
                      <span className="text-surface-400">
                        Planlanan <span className="tabular-nums text-surface-100">{formatNumber(seg.onTime)}</span>
                      </span>
                      {seg.overdue > 0 && (
                        <span className="text-surface-400">
                          Geciken <span className="tabular-nums text-red-400">{formatNumber(seg.overdue)}</span>
                        </span>
                      )}
                      {seg.completed > 0 && (
                        <span className="text-surface-400">
                          Tamamlanan <span className="tabular-nums text-emerald-400">{formatNumber(seg.completed)}</span>
                        </span>
                      )}
                      <span className="text-surface-500">
                        · {formatNumber(bucket.delivery_count)} teslimat / {formatNumber(bucket.quantity)} adet
                      </span>
                    </div>
                  );
                })()}
              </div>
            )}

            {isEmptyPeriod ? (
              <p className="py-16 text-center text-sm text-surface-500">
                {periodLabel} döneminde teslimat yok. Oklarla başka bir döneme geçebilirsiniz.
              </p>
            ) : asTable ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-surface-500">
                      <th className="text-left font-medium py-2 pr-3">{granularity === 'year' ? 'Yıl' : 'Ay'}</th>
                      <th className="text-right font-medium py-2 pr-3">Planlanan</th>
                      <th className="text-right font-medium py-2 pr-3">Geciken</th>
                      <th className="text-right font-medium py-2 pr-3">Tamamlanan</th>
                      <th className="text-right font-medium py-2">Toplam</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buckets.map((bucket) => {
                      const seg = segmentsFor(bucket);
                      return (
                        <tr key={bucket.key} className={`border-t border-surface-800/70 ${bucket.is_current ? 'bg-primary-500/5' : ''}`}>
                          <td className="py-2 pr-3 text-surface-200">
                            {bucket.label}
                            {bucket.is_current && <span className="text-primary-400 ml-1.5">• şimdi</span>}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-surface-300">{formatNumber(seg.onTime)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-surface-300">{formatNumber(seg.overdue)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-surface-300">{formatNumber(seg.completed)}</td>
                          <td className="py-2 text-right tabular-nums text-surface-100 font-medium">{formatNumber(seg.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              // Dar ekranda 12 sütun okunamayacak kadar incelir — grafik kendi
              // yatay kaydırma kabında durur, sayfa gövdesi yana kaymaz.
              <div className="overflow-x-auto">
                <div
                  className={`flex items-end gap-1.5 ${granularity === 'year' ? '' : 'min-w-[560px]'}`}
                  style={granularity === 'year' ? { maxWidth: buckets.length * YEAR_COLUMN_WIDTH } : undefined}
                >
                  {buckets.map((bucket) => {
                    const seg = segmentsFor(bucket);
                    const isHovered = hoveredBucket === bucket.key;
                    const parts = [
                      { key: 'overdue', value: seg.overdue, color: SERIES.overdue },
                      { key: 'onTime', value: seg.onTime, color: SERIES.remaining },
                      { key: 'completed', value: seg.completed, color: SERIES.completed },
                    ].filter((part) => part.value > 0);

                    return (
                      <div
                        key={bucket.key}
                        className="flex-1 min-w-0 flex flex-col justify-end items-center gap-1 cursor-default"
                        onMouseEnter={() => setHoveredBucket(bucket.key)}
                        onMouseLeave={() => setHoveredBucket(null)}
                      >
                        {/* Değer etiketi yığının İÇİNDE, en üst segmentin hemen üstünde durur —
                            sütunun dışına alınırsa bütün etiketler grafiğin tepesinde tek bir
                            sıra hâlinde toplanır ve hangi çubuğa ait oldukları okunamaz.
                            Yalnızca dolu kovalarda yazılır; her sütuna sayı basmak grafiği boğar. */}
                        <div
                          className="w-full flex flex-col justify-end gap-[2px]"
                          style={{ height: CHART_HEIGHT + BAR_LABEL_HEIGHT + BAR_STACK_SLACK, maxWidth: MAX_BAR_WIDTH }}
                        >
                          <span
                            className={`text-[10px] tabular-nums text-center shrink-0 ${
                              isHovered ? 'text-surface-100' : 'text-surface-400'
                            }`}
                            style={{ height: BAR_LABEL_HEIGHT }}
                          >
                            {seg.total > 0 ? formatNumber(seg.total) : ''}
                          </span>
                          {parts.map((part, index) => (
                            <div
                              key={part.key}
                              className="shrink-0"
                              style={{
                                height: `${(part.value / chartMax) * CHART_HEIGHT}px`,
                                background: part.color,
                                borderRadius: index === 0 ? '4px 4px 0 0' : 0,
                                opacity: hoveredBucket && !isHovered ? 0.45 : 1,
                                transition: 'opacity 150ms, height 400ms',
                              }}
                            />
                          ))}
                          {parts.length === 0 && <div className="h-[2px] shrink-0 rounded-full bg-surface-800/80" />}
                        </div>
                        <span
                          className={`text-[10px] leading-tight text-center ${
                            bucket.is_current ? 'text-primary-400 font-semibold' : bucket.is_past ? 'text-surface-600' : 'text-surface-400'
                          }`}
                        >
                          {bucket.short}
                          {bucket.sub && (
                            <>
                              <br />
                              <span className="text-surface-600">{bucket.sub}</span>
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* ── Kırılımlar — seçili döneme göre ── */}
          <div className={`grid grid-cols-1 xl:grid-cols-3 gap-4 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
            <section className="glass-card p-5">
              <h2 className="text-sm font-semibold text-surface-100">Üretim Aşamasına Göre</h2>
              <p className="text-xs text-surface-500 mt-0.5 mb-3">{periodLabel} · teslimat parçası sayısı</p>
              <div>
                {data.status_breakdown.map((bucket) => (
                  <BreakdownRow
                    key={bucket.key}
                    label={bucket.label}
                    value={bucket.count}
                    max={statusMax}
                    secondary={bucket.quantity > 0 ? `(${formatNumber(bucket.quantity)} ad.)` : undefined}
                    muted={bucket.count === 0}
                  />
                ))}
              </div>
            </section>

            <section className="glass-card p-5">
              <h2 className="text-sm font-semibold text-surface-100">Müşteriye Göre Kalan İş</h2>
              <p className="text-xs text-surface-500 mt-0.5 mb-3">
                {periodLabel} · en yüklü {data.customers.length} müşteri · adet
              </p>
              <div>
                {data.customers.map((customer) => (
                  <BreakdownRow
                    key={customer.name}
                    label={customer.name}
                    value={customer.remaining_quantity}
                    max={customerMax}
                    secondary={`(${formatNumber(customer.remaining_deliveries)} tes.)`}
                  />
                ))}
                {data.customers.length === 0 && (
                  <p className="py-6 text-center text-sm text-surface-500">Bu dönemde kalan iş yok.</p>
                )}
              </div>
            </section>

            <section className="glass-card p-5">
              <h2 className="text-sm font-semibold text-surface-100">Ürüne Göre Kalan İş</h2>
              <p className="text-xs text-surface-500 mt-0.5 mb-3">
                {periodLabel} · en yüklü {data.products.length} ürün · adet
              </p>
              <div>
                {data.products.map((product) => (
                  <BreakdownRow
                    key={product.name}
                    label={product.name}
                    value={product.remaining_quantity}
                    max={productMax}
                    secondary={`(${formatNumber(product.remaining_deliveries)} tes.)`}
                  />
                ))}
                {data.products.length === 0 && (
                  <p className="py-6 text-center text-sm text-surface-500">Bu dönemde kalan iş yok.</p>
                )}
              </div>
            </section>
          </div>

          {/* ── Listeler ── */}
          <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
            <section className={`glass-card p-5 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
              <h2 className="text-sm font-semibold text-surface-100">Dönemdeki Teslimatlar</h2>
              <p className="text-xs text-surface-500 mt-0.5 mb-2">
                {periodLabel} · tarih sırasıyla {data.deliveries.length} teslimat
                {periodTotals.delivery_count > data.deliveries.length &&
                  ` (toplam ${formatNumber(periodTotals.delivery_count)} içinden ilk ${data.deliveries.length})`}
              </p>
              {/* Dönem listesi 25 satıra kadar çıkabiliyor ve yanındaki geciken
                  listesi çoğu zaman çok daha kısa — kendi içinde kaydırılmazsa
                  kart devleşip yanında koca bir boşluk bırakıyor. */}
              <div className="max-h-[420px] overflow-y-auto">
                <DeliveryTable items={data.deliveries} emptyText="Bu dönemde teslimat yok." />
              </div>
            </section>

            <section className="glass-card p-5">
              <h2 className="text-sm font-semibold text-surface-100">Geciken Teslimatlar</h2>
              <p className="text-xs text-surface-500 mt-0.5 mb-2">
                Tüm dönemler · teslimat tarihi geçtiği hâlde tamamlanmamış {data.overdue.length} teslimat
              </p>
              <DeliveryTable items={data.overdue} emptyText="Geciken teslimat yok." />
            </section>
          </div>

          <p className="text-[11px] text-surface-600 text-center pb-2">
            {formatDate(data.today)} tarihine göre hesaplandı · alt ürünler dahil
          </p>
        </div>
      )}
    </div>
  );
}
