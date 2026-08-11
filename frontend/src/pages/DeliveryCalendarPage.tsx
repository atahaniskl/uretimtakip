/**
 * Delivery Calendar page — event-only monthly and yearly delivery-date view.
 */

import { useCallback, useEffect, useMemo, useState, useRef, Fragment, type MouseEvent as ReactMouseEvent } from 'react';
import api from '../lib/api';
import { getTaskStageLabel as getTaskStageLabelShared } from '../lib/stageLabels';
import { dateKey, isWeekend, addBusinessDays, countWorkdaysInRange } from '../lib/dateUtils';
import StageView from '../components/StageView.tsx';
import CalendarHeader from '../components/CalendarHeader';
import RightPanel from '../components/RightPanel';
import HierarchicalGantt from '../components/HierarchicalGantt';
import {
  TASK_FILTER_FIELD_OPTIONS,
  createEmptyTaskTextFilter,
  matchesTaskTextFilters,
  type TaskFilterField,
  type TaskTextFilter,
} from '../lib/taskFilters';
import { useAuth } from '../contexts/AuthContext';

/**
 * "Adım" (StageView) görünümü son kullanıcıya GEÇİCİ olarak kapatıldı.
 *
 * Kod SİLİNMEDİ — StageView.tsx, ilgili state (detailSubMode), "Detay"
 * düğmesinin hover menüsü ve StageView'i çizen blok olduğu gibi duruyor;
 * yalnızca bu bayrakla erişilemez hâle getirildi. Tekrar açmak için bu değeri
 * `true` yapmak yeterli, başka hiçbir değişiklik gerekmez.
 *
 * Kapalıyken: "Detay" düz bir düğmedir (hover menüsü açılmaz) ve doğrudan
 * Hiyerarşik Gantt'ı gösterir.
 *
 * Tip `boolean` olarak AÇIKÇA yazıldı: `false` literali bırakılsaydı TypeScript
 * bayrağı daraltıp aşağıdaki blokları "erişilemez" sayar ve StageView'e ait
 * kodu ölü kod uyarılarıyla işaretlerdi.
 */
const STAGE_VIEW_ENABLED: boolean = false;
import {
  YEARLY_MONTH_WEEKEND_COLORS_DARK,
  YEARLY_MONTH_WEEKEND_COLORS_LIGHT,
  OUTSOURCED_COLOR,
  getTaskColor,
} from '../lib/colorPalette';
import CreateDeliveryModal from '../components/CreateDeliveryModal';
import QuickAddDeliveryWizard from '../components/QuickAddDeliveryWizard';
import { useActiveOrders } from '../hooks/useActiveOrders';

const DAY_MS = 86400000;
const WEEK_DAYS = ['PZT', 'SAL', 'CAR', 'PER', 'CUM', 'CMT', 'PAZ'];
const YEAR_MONTHS = ['Oca', 'Sub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Agu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const YEAR_MONTHS_LONG = ['Ocak', 'Subat', 'Mart', 'Nisan', 'Mayis', 'Haziran', 'Temmuz', 'Agustos', 'Eylul', 'Ekim', 'Kasim', 'Aralik'];
const YEARLY_PLANNER_COLS = 31;
const TIMELINE_MODE_STORAGE_KEY = 'deliveryCalendarTimelineMode';
const SIDEBAR_COLLAPSED_KEY = 'deliveryCalendarSidebarCollapsed';

interface HolidayItem {
  id: string;
  holiday_date: string;
  name: string;
  is_active: boolean;
}

interface ProductInfoItem {
  id: string;
  product_name: string;
  supply_days: number;
  assembly_days: number;
  delivery_days: number;
  epoxy_minutes: number | null;
  conformal_minutes: number | null;
  montaj_minutes: number | null;
  quality_minutes: number | null;
  montaj_kalite_minutes: number | null;
  test1_minutes: number | null;
  test2_minutes: number | null;
  final_test_minutes: number | null;
  duration_mode: 'per_unit' | 'flat' | null;
  production_flat_days: number | null;
  test_flat_days: number | null;
  assembly_flat_days: number | null;
  sub_products?: { product_id: string; product_name: string; quantity: number }[];
}

export interface DeliveryTask {
  id: string;
  text: string;
  start: Date;
  end: Date;
  deliveryDate: Date;
  duration: number;
  type: 'summary' | 'task';
  status?: string | null;
  quantity?: number | null;
  onHandQuantity?: number | null;
  externalId?: string;
  productType?: string;
  orderNo?: string;
  customerName?: string;
  chipLabel?: string;
  calendarLabel?: string;
  createdByUsername?: string;
  lastInteractedByUsername?: string;
  isOutsourced?: boolean | null;
  stage?: string | null;
  deliveryGroupDate?: string;
  completion_percentage?: number;
  stage_counts?: Record<string, number>;
  supplyDays?: number | null;
  productionDays?: number | null;
  outsourceDays?: number | null;
  durationMode?: string | null;
  productionFlatDays?: number | null;
  testFlatDays?: number | null;
  assemblyFlatDays?: number | null;
  isPartial?: boolean;
  parent?: string | number | null;
  is_explicit_split?: boolean;
  rootOrderId?: string;
  isComponentBar?: boolean;
  // Adımın bir ALT ÜRÜNE (BOM bileşeni) ait olup olmadığı. isComponentBar ile
  // KARIŞTIRMA: o alan Özet takvim bağlamında "teslimat dışı adım" demektir.
  // Bu alan yalnızca tüm adımları gösteren görünümlerde (Yatay Timeline)
  // doldurulur — bkz. filteredOrdersAllStages.
  isSubProduct?: boolean;
  highlightScopeId?: string | null;
}

const getSplitRootId = (taskId: string) => {
  if (!taskId.startsWith('split_') || taskId.startsWith('split_fake_')) return null;
  const raw = taskId.slice('split_'.length);
  const parts = raw.split('_');
  return parts[0] || null;
};

// Sağ panelde açık olan görevle AYNI parçalı teslimata (split) ait bar'ları
// bulmak için kullanılır — rootOrderId'nin aksine sipariş genelini değil,
// tek bir parçayı (split) kapsar. Gerçek split yoksa siparişin kendisine
// (order/split_fake) düşer.
const getHighlightScopeId = (taskId: string): string | null => {
  const splitRoot = getSplitRootId(taskId);
  if (splitRoot) return `split:${splitRoot}`;
  if (taskId.startsWith('split_fake_')) return `order:${taskId.slice('split_fake_'.length)}`;
  if (taskId.startsWith('order_')) return `order:${taskId.slice('order_'.length)}`;
  return null;
};

const toManualStepsTaskId = (value: string) => {
  if (value.startsWith('order_') || value.startsWith('split_')) return value;
  return `order_${value}`;
};

// Her parçalı teslimat (split) artık kendi bağımsız manuel adım durumunu taşıyor.
// Bir stage alt-bar'ı (split_<uuid>_production gibi) için doğru kapsam, kendi split'i;
// gerçek split'i olmayan (split_fake_/bare order) görevler için ise siparişin kendisidir.
const getManualStepScopeIdForTask = (taskId: string, parentId?: string | null): string => {
  const rootId = getSplitRootId(taskId);
  if (rootId) return `split_${rootId}`;
  if (parentId) return toManualStepsTaskId(String(parentId));
  return toManualStepsTaskId(taskId);
};

interface SavedFilterCriteria {
  task_filter_field?: TaskFilterField;
  task_filter_query?: string;
  customer_filter?: string;
  task_filters?: TaskTextFilter[];
}

interface SavedFilterItem {
  id: string;
  name: string;
  criteria: SavedFilterCriteria;
  created_by_username?: string;
}


const buildMonthGrid = (anchorDate: Date) => {
  const firstOfMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const dayIndex = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(firstOfMonth.getDate() - dayIndex);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
};


const normalizeTaskText = (text: string) =>
  String(text || '')
    .replace(/^Teslimat\s*[—-]\s*/i, '')
    .replace(/^Otomatik\s+Teslimat\s*[—-]\s*/i, '')
    .trim();


// `fallbackForTask = true`: bu ekranda, `stage` alani olmayan eski/otomatik
// gorevler "Teslimat" varsayilir (takvim hucresi bos etiketle anlamsiz kalir).
// StageView ayni durumda bos birakir — iki ekranin bilincli farki, bkz.
// lib/stageLabels.ts. Fason (Dis Dizgi) ayrimi bu ekranin eski kopyasinda
// EKSIKTI; ortak fonksiyona gecisle birlikte artik burada da dogru calisiyor.
const getTaskStageLabel = (task: DeliveryTask) => getTaskStageLabelShared(task, true);

const buildTaskBarLabel = (productType: string, task: DeliveryTask) => {
  const stageLabel = getTaskStageLabel(task);
  const productLabel = String(productType || normalizeTaskText(task.text || '') || task.text || '').trim();
  // Özet takvimde yalnızca teslimat aşaması gösterildiği için bar üzerinde adım
  // adını tekrar yazmaya gerek yok; sadece ürün adını göster. Alt ürünlerin (BOM
  // bileşenlerinin) kendi "Teslimat" adımı olmadığı için buraya en geç biten
  // gerçek adımıyla (genelde Test) giriyorlar — onlar için de adım adı bastırılır.
  if (productLabel) return productLabel;
  return stageLabel || task.text;
};

const getTaskOrderGroupKey = (task: DeliveryTask) =>
  String(task.orderNo || task.externalId || task.parent || task.id || '');

const getTaskStageOrder = (task: DeliveryTask) => {
  const stage = String(task.stage || '').trim().toLowerCase();
  const rankMap: Record<string, number> = {
    supply: 0,
    assembly: 1,
    production: 2,
    test: 3,
    delivery: 4,
  };
  if (stage in rankMap) return rankMap[stage];

  const label = getTaskStageLabel(task).toLowerCase();
  return rankMap[label] ?? 99;
};

const compareTasksByOrderAndStage = (a: DeliveryTask, b: DeliveryTask) => {
  const aGroup = getTaskOrderGroupKey(a);
  const bGroup = getTaskOrderGroupKey(b);
  if (aGroup !== bGroup) return aGroup.localeCompare(bGroup, 'tr');

  const aStage = getTaskStageOrder(a);
  const bStage = getTaskStageOrder(b);
  if (aStage !== bStage) return aStage - bStage;

  const aTime = a.start instanceof Date ? a.start.getTime() : 0;
  const bTime = b.start instanceof Date ? b.start.getTime() : 0;
  if (aTime !== bTime) return aTime - bTime;

  return String(a.id).localeCompare(String(b.id));
};

const isTaskCalendarVisible = (task: DeliveryTask) => {
  return !task.stage || task.stage === 'delivery';
};

const formatQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '');
};

const buildTooltip = (date: Date, isToday: boolean, isHoliday: boolean, isWeekendDay: boolean, holidayName: string | undefined, items: DeliveryTask[]) => {
  const lines: string[] = [];
  lines.push(date.toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  if (isToday) lines.push('📌 Bugün');
  if (isHoliday) lines.push(`🏖️ Resmi Tatil: ${holidayName || 'Tatil'}`);
  else if (isWeekendDay) lines.push('🛋️ Hafta Sonu');

  if (items.length > 0) {
    lines.push('----------');
    lines.push('📦 Teslimatlar:');
    items.forEach((task) => {
      // Alt ürün (BOM bileşeni) barları Özet'te kendi "Teslimat" adımı olmadığı
      // için en geç biten gerçek adımıyla (stage 'delivery' değil) temsil edilir —
      // bunlar için adet bilgisi de bar üzerinde tekrar gösterilmez.
      const isComponentBar = !!task.stage && String(task.stage).trim().toLowerCase() !== 'delivery';
      const qtyStr = !isComponentBar && task.quantity ? ` (${formatQuantity(task.quantity)} adet)` : '';
      const label = task.chipLabel || task.calendarLabel || task.text;
      const orderStr = task.orderNo ? ` - Siparis ${task.orderNo}` : '';
      lines.push(`• ${label}${orderStr}${qtyStr}`);
    });
  } else {
    lines.push('----------');
    lines.push('Teslimat yok.');
  }

  return lines.join('\n');
};

const getChipColor = (task: DeliveryTask) => {
  if (task.isOutsourced === true) return OUTSOURCED_COLOR;
  const dds = task.deliveryGroupDate ? task.deliveryGroupDate.slice(0, 10) : '';
  const colorKey = `${task.orderNo || ''}|${task.productType || ''}|${dds}|${task.id}`;
  return getTaskColor(colorKey);
};

const getInitialTimelineMode = (): 'monthly' | 'yearly' => {
  if (typeof window === 'undefined') return 'monthly';
  try {
    const saved = window.localStorage.getItem(TIMELINE_MODE_STORAGE_KEY);
    return saved === 'yearly' ? 'yearly' : 'monthly';
  } catch {
    return 'monthly';
  }
};

export default function DeliveryCalendarPage() {
  const [tasks, setTasks] = useState<DeliveryTask[]>([]);
  const tasksRef = useRef<DeliveryTask[]>([]);
  // Özet takviminde bir bar'a (ana sipariş ya da alt ürün) hover olunca aynı
  // rootOrderId'yi paylaşan tüm barları (ana sipariş + tüm alt ürünleri) anında
  // vurgulamak için — tıklama gerekmiyor.
  const [hoveredRootOrderId, setHoveredRootOrderId] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<HolidayItem[]>([]);
  const [holidaysLoaded, setHolidaysLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [timelineMode, setTimelineMode] = useState<'monthly' | 'yearly'>(getInitialTimelineMode);
  const [calendarDate, setCalendarDate] = useState<Date>(() => new Date());
  const [yearViewYear, setYearViewYear] = useState<number>(() => new Date().getFullYear());
  const [isFilterPanelCollapsed, setIsFilterPanelCollapsed] = useState(true);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [isRightPanelResizing, setIsRightPanelResizing] = useState(false);
  // Sağ panelde bir parçalı teslimatın başka bir parçasına tıklanınca kısa
  // süre bir yükleniyor göstergesi gösterip ardından içeriği (taskId) değiştiriyoruz.
  const [isPanelSwitching, setIsPanelSwitching] = useState(false);
  const panelSwitchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [taskTextFilters, setTaskTextFilters] = useState<TaskTextFilter[]>([createEmptyTaskTextFilter()]);
  const [customerFilter, setCustomerFilter] = useState('');
  // Özet takviminde BOM alt ürünlerinin (bileşenlerin) kendi "hazır olma" barını
  // gizlemek için — bu barlar componentFinalStageTaskIds ile normalde her zaman
  // gösterilir (bkz. aşağıdaki filteredOrders), bu anahtar açıkken hariç tutulur.
  // Parçalı teslimatlar (ana ürünün kendi split'leri) bundan ETKİLENMEZ — filtre
  // sadece "bu bir alt ürün mü" sorusuna bakar.
  const [hideComponentSubProducts, setHideComponentSubProducts] = useState(false);
  const [taskIdToOpenInGantt, setTaskIdToOpenInGantt] = useState<string | null>(null);
  const [savedFilters, setSavedFilters] = useState<SavedFilterItem[]>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState('');
  const [newSavedFilterName, setNewSavedFilterName] = useState('');
  const [isSavingFilter, setIsSavingFilter] = useState(false);
  const [isLoadingSavedFilters, setIsLoadingSavedFilters] = useState(false);
  const [savedFilterError, setSavedFilterError] = useState('');
  const [displayMode, setDisplayMode] = useState<'overview' | 'detail'>('overview');
  const [detailSubMode, setDetailSubMode] = useState<'hierarchical' | 'stageview'>('hierarchical');
  // Şimdilik yalnızca görsel — Hiyerarşik Gantt aktifken Aylık/Yıllık ile aynı
  // header satırında bir "Dikey/Yatay" anahtarı gösterir, henüz görünümü
  // değiştirmiyor.
  const [hierarchicalOrientation, setHierarchicalOrientation] = useState<'vertical' | 'horizontal'>('vertical');
  const [isDetailDropdownOpen, setIsDetailDropdownOpen] = useState(false);
  // "Detay" menüsünün viewport koordinatları. Menü `position: fixed` çizilir —
  // header dar pencerede yatay kaydırılabildiği için (overflow-x: auto) kırpma
  // yapıyor; absolute kalsaydı menü header'ın içinde kesilirdi.
  const [detailDropdownPos, setDetailDropdownPos] = useState<{ top: number; left: number } | null>(null);
  // HierarchicalGantt kendi verisini ayrı çeker (bkz. HierarchicalGantt.tsx
  // fetchData) ve SADECE bu anahtar değişince yeniden çeker. Bu yüzden sayfanın
  // görevleri her tazelendiğinde (silme/düzenleme sonrası fetchTasks) anahtarı
  // da artırmak ŞART — aksi halde Dikey görünüm mount anındaki veriyi gösterip
  // silinmiş siparişi ekranda tutar (polling yok, görünüm geçişleri de yeniden
  // yükleme tetiklemez).
  const [ganttRefreshKey, setGanttRefreshKey] = useState(0);
  const hasLoadedTasksOnceRef = useRef(false);
  const { user } = useAuth();
  const contentShellRef = useRef<HTMLDivElement | null>(null);
  const calendarShellRef = useRef<HTMLDivElement | null>(null);
  const detailHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calendarMainRef = useRef<HTMLElement | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const sidebarPendingWidthRef = useRef<number | null>(null);
  const rightPanelResizeFrameRef = useRef<number | null>(null);
  const rightPanelPendingWidthRef = useRef<number | null>(null);
  const topScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [tableScrollWidth, setTableScrollWidth] = useState(0);
  const [rightPanelState, setRightPanelState] = useState<{ mode: 'closed' | 'task' | 'day'; taskId?: string; date?: Date; events?: any[] }>({ mode: 'closed' });
  // QuickAddDeliveryWizard'daki "Detayları Düzenle" ile açılan panelin özet
  // yerine doğrudan düzenleme ekranını (OrderDetailModal) göstermesi için —
  // bkz. RightPanel.tsx'teki autoEditTaskId prop'u.
  const [autoEditTaskId, setAutoEditTaskId] = useState<string | null>(null);
  const [isLightMode, setIsLightMode] = useState(() => document.documentElement.classList.contains('theme-light'));

  // ─── Özet takvimde tek bir teslimatın alt adımlarını izole etme ───
  // Normalde Özet takvim her teslimattan yalnızca "Teslimat" adımını gösterir
  // (bkz. isTaskCalendarVisible). Bir barın üzerinde sağ tıklayıp "Alt adımları
  // göster" seçildiğinde takvim, SADECE o teslimatın (parçanın) bütün adımlarını
  // gösterir — başka hiçbir sipariş/parça görünmez.
  //
  // Kapsam anahtarı `rootOrderId`'dir, yani SİPARİŞİN TAMAMI: siparişin bütün
  // parçalı teslimatları ve bütün alt ürünleri (BOM bileşenleri) birlikte
  // gösterilir. Tek bir parçayı izole etmek yetmiyordu — bir teslimatın gerçek
  // resmi, onu besleyen alt ürünler ve kardeş parçalarla birlikte oluşuyor.
  // (Aynı anahtar hover vurgusunda da sipariş ailesini gruplamak için kullanılır.)
  const [focusedScope, setFocusedScope] = useState<
    { familyId: string; title: string; orderNo: string } | null
  >(null);
  // Bar üzerinde sağ tıkla açılan menünün viewport koordinatları. Menü
  // `position: fixed` çizilir — takvim gövdesi kaydırılabilir olduğu için
  // absolute konumlandırma menüyü kırpardı ("Detay" menüsüyle aynı gerekçe).
  const [barMenu, setBarMenu] = useState<{ x: number; y: number; task: DeliveryTask } | null>(null);
  // İzole moda girmeden önceki takvim konumu — çıkışta geri yüklenir.
  const preFocusViewRef = useRef<{ date: Date; year: number } | null>(null);

  // Sağ panelde bir görev (task) açıkken, o görevin ait olduğu parçalı teslimatın
  // (split) TÜM bar'larını (özet/adım/hiyerarşik takvimlerin hepsinde) hover
  // olmadan da sürekli vurgulamak için — bkz. getHighlightScopeId.
  const activeHighlightScopeId = useMemo(() => {
    if (rightPanelState.mode !== 'task' || !rightPanelState.taskId) return null;
    return getHighlightScopeId(String(rightPanelState.taskId));
  }, [rightPanelState.mode, rightPanelState.taskId]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLightMode(document.documentElement.classList.contains('theme-light'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const weekendColorPalette = isLightMode ? YEARLY_MONTH_WEEKEND_COLORS_LIGHT : YEARLY_MONTH_WEEKEND_COLORS_DARK;

  const handleTopScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (tableContainerRef.current) tableContainerRef.current.scrollLeft = e.currentTarget.scrollLeft;
  };

  const handleBottomScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (topScrollContainerRef.current) topScrollContainerRef.current.scrollLeft = e.currentTarget.scrollLeft;
  };

  // New states for delivery creation
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // "Gelişmiş ekleme" — yeni ürün tanımlama / abonelik gibi QuickAddDeliveryWizard'ın
  // kapsamadığı durumlar için wizard'ın 1. adımından açılan eski tam form.
  const [isAdvancedCreateModalOpen, setIsAdvancedCreateModalOpen] = useState(false);
  const [productInfos, setProductInfos] = useState<ProductInfoItem[]>([]);
  const [isLoadingProductInfos, setIsLoadingProductInfos] = useState(false);

  const holidayKeySet = useMemo(
    () => new Set(holidays.filter((h) => h.is_active).map((h) => h.holiday_date)),
    [holidays],
  );

  const holidayNameByDate = useMemo(() => {
    const map = new Map<string, string>();
    holidays.forEach((h) => {
      if (h.is_active) map.set(h.holiday_date, h.name || 'Resmi Tatil');
    });
    return map;
  }, [holidays]);

  const fetchHolidays = useCallback(async () => {
    try {
      const { data } = await api.get('/holidays/');
      setHolidays(Array.isArray(data) ? data : []);
    } catch {
      setHolidays([]);
    } finally {
      setHolidaysLoaded(true);
    }
  }, []);

  const fetchProductInfos = useCallback(async () => {
    try {
      setIsLoadingProductInfos(true);
      const { data } = await api.get<ProductInfoItem[]>('/product-info/');
      setProductInfos(Array.isArray(data) ? data : []);
    } catch {
      setProductInfos([]);
    } finally {
      setIsLoadingProductInfos(false);
    }
  }, []);

  const fetchTasks = useCallback(async (withLoading = false) => {
    try {
      console.log('[DeliveryCalendarPage] Fetching tasks...');
      if (withLoading) setIsLoading(true);
      const { data } = await api.get('/gantt/tasks');
      console.log('[DeliveryCalendarPage] Tasks fetched successfully:', data.tasks?.length || 0, 'tasks');
      const parsedTasks = (data.tasks || [])
        .map((t: any) => {
          const startRaw = t?.start_date ? String(t.start_date) : '';
          if (!startRaw) return null;

          const startDate = new Date(startRaw.substring(0, 10) + 'T00:00:00');
          if (Number.isNaN(startDate.getTime())) return null;

          let endDate = t.end_date
            ? new Date(String(t.end_date).substring(0, 10) + 'T00:00:00')
            : addBusinessDays(startDate, Number(t.duration || 1), holidayKeySet);

          if (Number.isNaN(endDate.getTime())) {
            endDate = addBusinessDays(startDate, Number(t.duration || 1), holidayKeySet);
          }
          const deliveryDate = new Date(endDate.getTime() - DAY_MS);

          return {
            id: t.id,
            text: t.text,
            start: startDate,
            end: endDate,
            deliveryDate,
            duration: Number(t.duration || 1),
            type: t.type === 'project' ? 'summary' : 'task',
            status: t.status || null,
            quantity: t.quantity,
            onHandQuantity: t.on_hand_quantity ?? null,
            externalId: t.external_id,
            customerName: t.customer_name || '',
            responsiblePersonnel: t.responsible_personnel || '',
            orderDate: t.order_date || '',
            promisedDate: t.promised_date || '',
            requirementDate: t.requirement_date || '',
            penaltyDate: t.penalty_date || '',
            chipLabel: t.text,
            calendarLabel: t.text,
            createdByUsername: t.created_by_username,
            lastInteractedByUsername: t.last_interacted_by_username,
            isOutsourced: t.is_outsourced,
            stage: t.stage ?? null,
            deliveryGroupDate: t.delivery_date || '',
            completion_percentage: typeof t.completion_percentage === 'number' ? t.completion_percentage : undefined,
            stage_counts: t.stage_counts || {},
            supplyDays: t.supply_days,
            productionDays: t.production_days,
            outsourceDays: t.outsource_days ?? null,
            durationMode: t.duration_mode ?? null,
            productionFlatDays: t.production_flat_days ?? null,
            testFlatDays: t.test_flat_days ?? null,
            assemblyFlatDays: t.assembly_flat_days ?? null,
            qualityMinutes: t.quality_minutes ?? null,
            epoxyMinutes: t.epoxy_minutes ?? null,
            conformalMinutes: t.conformal_minutes ?? null,
            montajMinutes: t.montaj_minutes ?? null,
            montajKaliteMinutes: t.montaj_kalite_minutes ?? null,
            test1Minutes: t.test1_minutes ?? null,
            test2Minutes: t.test2_minutes ?? null,
            finalTestMinutes: t.final_test_minutes ?? null,
            deliveryDays: t.delivery_days ?? null,
            assemblyEmployees: t.assembly_employees ?? 1,
            productionEmployees: t.production_employees ?? 1,
            testEmployees: t.test_employees ?? 1,
            workHoursPerDay: t.work_hours_per_day ?? 8,
            parent: t.parent,
            is_explicit_split: t.is_explicit_split === true,
          } as DeliveryTask;
        })
        .filter((task: DeliveryTask | null): task is DeliveryTask => task !== null);

      const parentsById = new Map<string, DeliveryTask>();
      parsedTasks.forEach((task: DeliveryTask) => {
        if (task.type === 'summary') parentsById.set(task.id, task);
      });

      const splitRootsByParent = new Map<string, Set<string>>();
      parsedTasks.forEach((t: DeliveryTask) => {
        if (!t.parent || t.type !== 'task') return;
        const rootId = getSplitRootId(String(t.id));
        if (!rootId) return;
        const parentId = String(t.parent);
        const roots = splitRootsByParent.get(parentId) || new Set<string>();
        roots.add(rootId);
        splitRootsByParent.set(parentId, roots);
      });

      const enriched = parsedTasks.map((task: DeliveryTask) => {
        if (task.type !== 'task') return task;

        const parent = (data.tasks || []).find((t: any) => t.id === task.id)?.parent;
        const parentTask = (parent !== null && parent !== undefined) ? parentsById.get(String(parent)) : null;
        const productType = parentTask ? normalizeTaskText(parentTask.text || '') : normalizeTaskText(task.text || '');
        const orderNo = parentTask?.externalId ? String(parentTask.externalId) : '';
        const customerName = task.customerName || parentTask?.customerName || '';
        const quantityText = formatQuantity(task.quantity);
        const barLabel = buildTaskBarLabel(productType, task);

        const labelParts = [
          barLabel,
          orderNo ? `Siparis ${orderNo}` : '',
          customerName ? `Müşteri ${customerName}` : '',
          quantityText ? `${quantityText} adet` : '',
        ].filter(Boolean);

        const isPartial = parentTask?.is_explicit_split || (parent ? (splitRootsByParent.get(String(parent))?.size || 0) > 1 : false);
        const partialPrefix = isPartial ? '🧩 ' : '';

        // Ana siparişin barları için parentTask (kendi "proje" satırı) hiç parent
        // taşımaz — rootOrderId onun kendi id'si (task.parent) olur. Alt ürün (BOM
        // bileşeni) barları için parentTask BİLEŞENİN kendi proje satırıdır, o da
        // ana siparişin proje satırını parent olarak taşır — bu yüzden bir kademe
        // daha yukarı çıkılır. Hover'da ana sipariş + tüm alt ürünlerini birlikte
        // vurgulamak için kullanılır.
        const rootOrderId = parentTask?.parent
          ? String(parentTask.parent)
          : (parent ? String(parent) : String(task.parent || task.id));

        // Özet'te "delivery" dışı bir stage taşıyan tek bar türü alt ürünlerdir
        // (bkz. isTaskCalendarVisible/componentFinalStageTaskIds) — hover vurgusunu
        // ana sipariş/alt ürün için farklı renklendirebilmek üzere işaretlenir.
        const isComponentBar = !!task.stage && String(task.stage).trim().toLowerCase() !== 'delivery';
        const highlightScopeId = getHighlightScopeId(String(task.id));

        return {
          ...task,
          text: partialPrefix + barLabel,
          productType,
          orderNo,
          customerName,
          rootOrderId,
          isComponentBar,
          highlightScopeId,
          chipLabel: partialPrefix + (barLabel || productType || normalizeTaskText(task.text || '') || task.text),
          calendarLabel: partialPrefix + (labelParts.join(' | ') || normalizeTaskText(task.text || '') || task.text),
          quantityLabel: quantityText ? `${quantityText} adet` : '',
          status: task.status || parentTask?.status || null,
          createdByUsername: task.createdByUsername || parentTask?.createdByUsername || '',
          lastInteractedByUsername: task.lastInteractedByUsername || parentTask?.lastInteractedByUsername || '',
          isOutsourced: task.isOutsourced ?? parentTask?.isOutsourced ?? null,
          onHandQuantity: task.onHandQuantity ?? parentTask?.onHandQuantity ?? null,
          completion_percentage: task.completion_percentage ?? parentTask?.completion_percentage ?? 0,
          stage_counts: task.stage_counts && Object.keys(task.stage_counts).length > 0
            ? task.stage_counts
            : (parentTask?.stage_counts || {}),
          supplyDays: task.supplyDays ?? parentTask?.supplyDays ?? null,
          productionDays: task.productionDays ?? parentTask?.productionDays ?? null,
          outsourceDays: task.outsourceDays ?? parentTask?.outsourceDays ?? null,
          durationMode: task.durationMode ?? parentTask?.durationMode ?? null,
          productionFlatDays: task.productionFlatDays ?? parentTask?.productionFlatDays ?? null,
          testFlatDays: task.testFlatDays ?? parentTask?.testFlatDays ?? null,
          assemblyFlatDays: task.assemblyFlatDays ?? parentTask?.assemblyFlatDays ?? null,
          isPartial,
          parent: parent || task.parent,
        };
      });

      console.log('[DeliveryCalendarPage] Setting tasks state with', enriched.length, 'tasks');
      setTasks(enriched);
      setError('');
      // Dikey görünüm (HierarchicalGantt) kendi verisini ayrı çektiği için
      // burada tetiklenmeli — bkz. ganttRefreshKey tanımı. İLK yüklemede
      // atlanır: o an HierarchicalGantt zaten kendi ilk isteğini yapıyor,
      // anahtarı burada da artırmak her sayfa açılışında gereksiz bir ikinci
      // istek doğururdu.
      if (hasLoadedTasksOnceRef.current) {
        setGanttRefreshKey((prev) => prev + 1);
      } else {
        hasLoadedTasksOnceRef.current = true;
      }
      // Background: fetch manual-step states per parent and prefix checked stages with check emoji
      (async () => {
        const formatErr = (e: unknown) => (e instanceof Error ? e.message : String(e));
        try {
          const scopeIds: string[] = Array.from(
            new Set<string>(
              enriched
                .filter((t: DeliveryTask) => t.stage)
                .map((t: DeliveryTask) => getManualStepScopeIdForTask(String(t.id), t.parent as string | null | undefined)),
            ),
          );
          const manualStepsByScope = new Map<string, any>();

          await Promise.all(
            scopeIds.map(async (scopeId) => {
              try {
                const { data } = await api.get(`/gantt/tasks/${scopeId}/manual-steps`);
                manualStepsByScope.set(scopeId, data?.steps || {});
              } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('manual-steps fetch failed for', scopeId, formatErr(e));
              }
            }),
          );

          const updated = enriched.map((task: DeliveryTask) => {
            try {
              if (task.stage) {
                const scopeId = getManualStepScopeIdForTask(String(task.id), task.parent as string | null | undefined);
                const steps = manualStepsByScope.get(scopeId) || {};
                const stepMeta = steps[task.stage] || {};
                if (stepMeta.checked) {
                  const prefix = '✅ ';
                  const cleanChip = String(task.chipLabel || task.calendarLabel || task.text || '').replace(/^✅\s*/, '');
                  const cleanText = String(task.calendarLabel || task.text || '').replace(/^✅\s*/, '');
                  return { ...task, chipLabel: `${prefix}${cleanChip}`, calendarLabel: `${prefix}${cleanText}` };
                }
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('manual-steps label update failed for task', task?.id, formatErr(e));
            }
            return task;
          });

          setTasks(updated);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('manual-steps background update failed', formatErr(e));
        }
      })();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Teslimatlar yuklenemedi';
      console.error('[DeliveryCalendarPage] fetchTasks error:', msg);
      setError(msg);
    } finally {
      if (withLoading) setIsLoading(false);
    }
  }, [holidayKeySet]);

  useEffect(() => {
    fetchHolidays();
    fetchProductInfos();
  }, [fetchHolidays, fetchProductInfos]);

  useEffect(() => {
    if (!holidaysLoaded) return;
    fetchTasks(true);
  }, [fetchTasks, holidaysLoaded]);


  useEffect(() => {
    try {
      window.localStorage.setItem(TIMELINE_MODE_STORAGE_KEY, timelineMode);
    } catch {
      // Ignore storage failures (e.g., private mode/storage restrictions)
    }
  }, [timelineMode]);

  useEffect(() => {
    setRightPanelState((prev) => (prev.mode === 'closed' ? prev : { mode: 'closed' }));
    setTaskIdToOpenInGantt(null);
  }, [displayMode, timelineMode, calendarDate, yearViewYear]);

  useEffect(() => {
    const element = calendarMainRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    return () => { };
  }, [displayMode, timelineMode]);

  // `position: fixed` menünün koordinatları ölçüm anına aittir; pencere yeniden
  // boyutlanır ya da bir şey kaydırılırsa konum bayatlar — menüyü kapatmak en
  // güvenlisi (kullanıcı hover'la anında yeniden açabiliyor).
  useEffect(() => {
    if (!isDetailDropdownOpen) return;
    const close = () => setIsDetailDropdownOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [isDetailDropdownOpen]);

  const handleGanttViewStateChanged = useCallback(() => {
    setRightPanelState((prev) => (prev.mode === 'closed' ? prev : { mode: 'closed' }));
    setTaskIdToOpenInGantt(null);
  }, []);

  const handleTaskStatusChanged = useCallback((orderId: string | null, status: string) => {
    if (!orderId) return;
    // `status` is the order's own roll-up across all its (independently tracked) splits —
    // only the order's own summary bar reflects it, not its children.
    const orderTaskId = `order_${orderId}`;
    setTasks((prev) => prev.map((task) => (task.id === orderTaskId ? { ...task, status } : task)));
  }, []);

  const customerOptions = useMemo(() => {
    const options = new Set<string>();
    tasks.forEach((task) => {
      const customer = String(task.customerName || '').trim();
      if (customer) options.add(customer);
    });
    return Array.from(options).sort((a, b) => a.localeCompare(b, 'tr'));
  }, [tasks]);

  // BOM bileşenlerinin (alt ürün) kendi "Teslimat" adımı hiç yok — müşteriye
  // doğrudan teslim edilmiyorlar, ana ürünün içine giriyorlar (bkz. backend
  // date_utils.py component_ready_at kuralı, gantt.py'de include_delivery=False
  // ile üretiliyorlar). Bu yüzden normal `isTaskCalendarVisible` filtresine
  // ("stage === 'delivery'") hiç takılmıyor, Özet Takvim'de hiç görünmüyorlardı.
  // Burada, her bileşenin (ve kendi parçalı teslimatı varsa HER parçasının) EN GEÇ
  // biten adımı (genelde Test) "bitmiş/hazır" tarihi olarak takvime dahil edilir —
  // RightPanel.tsx'teki componentsReadyAt ile aynı mantık, split bazında.
  const componentFinalStageTaskIds = useMemo(() => {
    const componentParentIds = new Set(
      tasks.filter((t) => t.type === 'summary' && t.parent).map((t) => String(t.id)),
    );
    if (componentParentIds.size === 0) return new Set<string>();

    const groups = new Map<string, DeliveryTask>();
    tasks.forEach((t) => {
      if (t.type !== 'task' || !t.parent) return;
      const parentId = String(t.parent);
      if (!componentParentIds.has(parentId)) return;
      const rootId = getSplitRootId(String(t.id)) ?? parentId;
      const groupKey = `${parentId}|${rootId}`;
      const current = groups.get(groupKey);
      if (!current || t.end.getTime() > current.end.getTime()) {
        groups.set(groupKey, t);
      }
    });

    return new Set(Array.from(groups.values()).map((t) => String(t.id)));
  }, [tasks]);

  // İzole edilen siparişin BÜTÜN adım barları — her parçalı teslimatın ve her
  // alt ürünün Tedarik → ... → Teslimat adımları dahil. `tasks` zaten hepsini
  // içeriyor; Özet takvim onları normalde süzüyor, burada yalnızca aile
  // eşleşmesi uygulanır.
  const focusedStageTasks = useMemo(() => {
    if (!focusedScope) return null;
    return tasks
      .filter((task) => task.type === 'task' && task.rootOrderId === focusedScope.familyId)
      .sort(compareTasksByOrderAndStage);
  }, [tasks, focusedScope]);

  // İzole moddaki bar etiketleri. Artık aynı takvimde birden fazla ürün ve
  // birden fazla parça bir arada olabildiği için düz "Üretim" yazmak yetmez:
  // hangi ürünün, hangi parçasının adımı olduğu bar üzerinde görünmeli.
  // Ayrım YALNIZCA gerektiğinde eklenir — tek kalemlik bir siparişte etiket
  // gereksiz yere uzamasın diye sade "Üretim" olarak kalır.
  const focusedBarLabels = useMemo(() => {
    const labels = new Map<string, { chip: string; full: string }>();
    if (!focusedStageTasks || focusedStageTasks.length === 0) return labels;

    // Bir "kalem" = tek bir parçalı teslimat ya da tek bir alt ürün parçası.
    // highlightScopeId bir parçanın tüm adımlarında aynıdır, yani doğal kalem anahtarı.
    const lines = new Map<string, DeliveryTask[]>();
    focusedStageTasks.forEach((task) => {
      const key = task.highlightScopeId || String(task.id);
      const list = lines.get(key) || [];
      list.push(task);
      lines.set(key, list);
    });

    const lineProduct = (key: string) => {
      const first = (lines.get(key) || [])[0];
      return (first?.productType || normalizeTaskText(first?.text || '') || '').trim();
    };
    const lineStart = (key: string) =>
      Math.min(...(lines.get(key) || []).map((task) => task.start.getTime()));

    const keysByProduct = new Map<string, string[]>();
    lines.forEach((_list, key) => {
      const product = lineProduct(key);
      const arr = keysByProduct.get(product) || [];
      arr.push(key);
      keysByProduct.set(product, arr);
    });
    // Aynı üründen birden fazla parça varsa numara ver — sıra en erken başlangıca göre.
    keysByProduct.forEach((keys) => keys.sort((a, b) => lineStart(a) - lineStart(b)));

    const hasMultipleProducts = keysByProduct.size > 1;

    lines.forEach((list, key) => {
      const product = lineProduct(key);
      const siblings = keysByProduct.get(product) || [];
      const partNo = siblings.length > 1 ? siblings.indexOf(key) + 1 : 0;
      const lineName = partNo ? `${product} #${partNo}` : product;
      const needsPrefix = hasMultipleProducts || partNo > 0;
      list.forEach((task) => {
        const stage = getTaskStageLabel(task);
        // Adım adı BAŞTA: yıllık görünümde bar yalnızca birkaç gün hücresi
        // genişliğinde olduğu için etiket kırpılıyor. Ürün adı başa alınsaydı
        // ("ANT-4011-P2 #2 · Üre…") her barda tekrar eden önekler yüzünden asıl
        // bilgi olan adım adı kaybolurdu. Ürün, kırpılsa bile renk ve tooltip
        // (aşağıdaki `full`) üzerinden ayırt edilebiliyor.
        labels.set(String(task.id), {
          chip: needsPrefix && lineName ? `${stage} · ${lineName}` : stage,
          full: lineName ? `${lineName} — ${stage}` : stage,
        });
      });
    });
    return labels;
  }, [focusedStageTasks]);

  const focusedLineCount = useMemo(() => {
    if (!focusedStageTasks) return 0;
    return new Set(focusedStageTasks.map((task) => task.highlightScopeId || String(task.id))).size;
  }, [focusedStageTasks]);

  const filteredOrders = useMemo(() => {
    // İzole moddayken metin/müşteri filtreleri ve "yalnızca Teslimat adımı"
    // kuralı BİLİNÇLİ olarak atlanır: kullanıcı açıkça tek bir teslimatı seçti,
    // bir de üstüne filtre uygulamak onu boş takvimle baş başa bırakırdı.
    if (focusedStageTasks) return focusedStageTasks;

    const customerQuery = customerFilter.trim().toLocaleLowerCase('tr-TR');
    const activeTextFilters = taskTextFilters
      .map((filter) => ({
        field: filter.field,
        query: String(filter.query || '').trim(),
      }))
      .filter((filter) => filter.query.length > 0);
    const hasTextFilter = activeTextFilters.length > 0;
    const hasCustomerFilter = customerQuery.length > 0;

    const source = tasks
      .filter((task) => task.type === 'task')
      .filter((task) => {
        const isComponentTask = componentFinalStageTaskIds.has(String(task.id));
        if (hideComponentSubProducts && isComponentTask) return false;
        return isTaskCalendarVisible(task) || isComponentTask;
      });
    if (!hasTextFilter && !hasCustomerFilter) return source;

    const matchesCustomer = (value: string) => String(value || '').toLocaleLowerCase('tr-TR') === customerQuery;

    return source.filter((task) => {
      const customerValue = `${task.customerName || ''}`;

      if (hasCustomerFilter && !matchesCustomer(customerValue)) return false;
      if (!hasTextFilter) return true;
      return matchesTaskTextFilters(task, activeTextFilters);
    });
  }, [customerFilter, taskTextFilters, tasks, componentFinalStageTaskIds, hideComponentSubProducts, focusedStageTasks]);

  const enterFocusMode = useCallback((task: DeliveryTask) => {
    const familyId = task.rootOrderId || String(task.parent || task.id);
    if (!familyId) return;
    // Bant başlığı, tıklanan barın değil SİPARİŞİN adını taşır — kapsam artık
    // tüm aile olduğu için alt ürün barına sağ tıklandığında da ana siparişin
    // adı yazmalı.
    const rootSummary = tasks.find((item) => item.type === 'summary' && String(item.id) === familyId);
    // İzole mod adımların bulunduğu aya/yıla atlayabildiği için (aşağıdaki
    // effect), çıkışta kullanıcıyı bıraktığı yere geri döndürebilmek üzere
    // mevcut konum saklanır — aksi halde "normale dön" başka bir aya düşürürdü.
    preFocusViewRef.current = { date: calendarDate, year: yearViewYear };
    setFocusedScope({
      familyId,
      title:
        normalizeTaskText(rootSummary?.text || '') ||
        task.productType ||
        normalizeTaskText(task.text || '') ||
        String(task.text || ''),
      orderNo: rootSummary?.externalId || task.orderNo || task.externalId || '',
    });
    setBarMenu(null);
  }, [calendarDate, yearViewYear, tasks]);

  const exitFocusMode = useCallback(() => {
    const previous = preFocusViewRef.current;
    if (previous) {
      setCalendarDate(previous.date);
      setYearViewYear(previous.year);
      preFocusViewRef.current = null;
    }
    setFocusedScope(null);
  }, []);

  // İzole edilen adımların ilk/son tarihi — bandda gösterilir. Adımlar birden
  // fazla aya yayılabildiği için, görünen ayda hepsi olmayabilir; aralık
  // kullanıcıya kalanların nerede olduğunu söyler.
  const focusedRangeLabel = useMemo(() => {
    if (!focusedStageTasks || focusedStageTasks.length === 0) return '';
    const times = focusedStageTasks.map((task) => task.deliveryDate.getTime());
    const fmt = (value: number) =>
      new Date(value).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const first = fmt(Math.min(...times));
    const last = fmt(Math.max(...times));
    return first === last ? first : `${first} – ${last}`;
  }, [focusedStageTasks]);

  // İzole edilen adımların hepsi görüntülenen ayın/yılın dışında kalabilir
  // (ör. Tedarik Haziran'da biterken bara Ağustos'ta sağ tıklandıysa) — o durumda
  // kullanıcı bomboş bir takvimle karşılaşırdı. Görünen aralıkta hiç adım yoksa
  // ilk adımın dönemine atlanır; en az bir adım görünüyorsa konum KORUNUR.
  useEffect(() => {
    if (!focusedScope || !focusedStageTasks || focusedStageTasks.length === 0) return;
    const earliest = focusedStageTasks.reduce(
      (min, task) => (task.deliveryDate < min ? task.deliveryDate : min),
      focusedStageTasks[0].deliveryDate,
    );
    if (timelineMode === 'yearly') {
      setYearViewYear((prev) =>
        focusedStageTasks.some((task) => task.deliveryDate.getFullYear() === prev) ? prev : earliest.getFullYear(),
      );
    } else {
      setCalendarDate((prev) =>
        focusedStageTasks.some(
          (task) =>
            task.deliveryDate.getFullYear() === prev.getFullYear() &&
            task.deliveryDate.getMonth() === prev.getMonth(),
        )
          ? prev
          : new Date(earliest.getFullYear(), earliest.getMonth(), 1),
      );
    }
  }, [focusedScope, focusedStageTasks, timelineMode]);

  // Esc: önce sağ tık menüsünü, sonra izole modu kapatır. Bir modal/panel açıkken
  // ya da bir metin alanına yazılırken devreye GİRMEZ — o bağlamlarda Esc'in
  // kendi anlamı var.
  useEffect(() => {
    if (!barMenu && !focusedScope) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      if (
        active?.tagName === 'INPUT' ||
        active?.tagName === 'TEXTAREA' ||
        (active as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      if (barMenu) {
        setBarMenu(null);
        return;
      }
      if (isCreateModalOpen || rightPanelState.mode !== 'closed') return;
      // Doğrudan setFocusedScope(null) DEĞİL: çıkış, takvimi izole moda
      // girmeden önceki aya/yıla geri döndürmeyi de kapsıyor.
      exitFocusMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [barMenu, focusedScope, isCreateModalOpen, rightPanelState.mode, exitFocusMode]);

  // Menü; dışarı tıklama, kaydırma ve pencere yeniden boyutlandırmada kapanır —
  // `position: fixed` olduğu için kaydırmada barın üzerinden kayardı.
  useEffect(() => {
    if (!barMenu) return;
    const close = () => setBarMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [barMenu]);

  const addTaskTextFilterRow = useCallback(() => {
    setTaskTextFilters((prev) => [...prev, createEmptyTaskTextFilter()]);
  }, []);

  const removeTaskTextFilterRow = useCallback((index: number) => {
    setTaskTextFilters((prev) => {
      if (prev.length <= 1) return [createEmptyTaskTextFilter()];
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const updateTaskTextFilterRow = useCallback((index: number, patch: Partial<TaskTextFilter>) => {
    setTaskTextFilters((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }, []);

  const activeOrders = useActiveOrders(tasks);

  useEffect(() => {
    if (!tableContainerRef.current || activeOrders.length === 0) return;
    const observer = new ResizeObserver(() => {
      if (tableContainerRef.current) {
        setTableScrollWidth(tableContainerRef.current.scrollWidth);
      }
    });
    observer.observe(tableContainerRef.current);
    if (tableRef.current) observer.observe(tableRef.current);
    return () => observer.disconnect();
  }, [activeOrders.length, isSidebarCollapsed]);

  const loadSavedFilters = useCallback(async () => {
    setIsLoadingSavedFilters(true);
    setSavedFilterError('');
    try {
      const { data } = await api.get('/saved-filters/');
      setSavedFilters(Array.isArray(data) ? data : []);
    } catch {
      setSavedFilters([]);
      setSavedFilterError('Kayitli filtreler yuklenemedi.');
    } finally {
      setIsLoadingSavedFilters(false);
    }
  }, []);

  const applySavedFilter = useCallback((savedFilter: SavedFilterItem) => {
    const criteria = savedFilter.criteria || {};
    const savedTaskFilters = Array.isArray(criteria.task_filters)
      ? criteria.task_filters
        .map((filter) => ({
          field: (filter?.field || 'all') as TaskFilterField,
          query: String(filter?.query || ''),
        }))
        .filter((filter) => TASK_FILTER_FIELD_OPTIONS.some((option) => option.value === filter.field))
      : [];

    if (savedTaskFilters.length > 0) {
      setTaskTextFilters(savedTaskFilters);
    } else {
      const fallbackField = criteria.task_filter_field || 'all';
      setTaskTextFilters([
        {
          field: TASK_FILTER_FIELD_OPTIONS.some((option) => option.value === fallbackField) ? fallbackField : 'all',
          query: String(criteria.task_filter_query || ''),
        },
      ]);
    }

    setCustomerFilter(String(criteria.customer_filter || ''));
    setSelectedSavedFilterId(savedFilter.id);
  }, []);

  const clearAllFilters = useCallback(() => {
    setTaskTextFilters([createEmptyTaskTextFilter()]);
    setCustomerFilter('');
    setSelectedSavedFilterId('');
  }, []);

  const handleSaveCurrentFilter = useCallback(async () => {
    const trimmedName = newSavedFilterName.trim();
    if (!trimmedName) {
      setSavedFilterError('Filtre adi bos olamaz.');
      return;
    }

    setIsSavingFilter(true);
    setSavedFilterError('');
    try {
      const payload = {
        name: trimmedName,
        criteria: {
          task_filters: taskTextFilters,
          task_filter_field: taskTextFilters[0]?.field || 'all',
          task_filter_query: taskTextFilters[0]?.query || '',
          customer_filter: customerFilter,
        },
      };
      const { data } = await api.post('/saved-filters/', payload);
      setSavedFilters((prev) => [data, ...prev]);
      setSelectedSavedFilterId(String(data.id));
      setNewSavedFilterName('');
    } catch (err: any) {
      setSavedFilterError(err?.response?.data?.detail || 'Filtre kaydedilemedi.');
    } finally {
      setIsSavingFilter(false);
    }
  }, [customerFilter, newSavedFilterName, taskTextFilters]);

  const handleDeleteSavedFilter = useCallback(async () => {
    if (!selectedSavedFilterId) return;

    setSavedFilterError('');
    try {
      await api.delete(`/saved-filters/${selectedSavedFilterId}`);
      setSavedFilters((prev) => prev.filter((item) => String(item.id) !== selectedSavedFilterId));
      setSelectedSavedFilterId('');
    } catch (err: any) {
      setSavedFilterError(err?.response?.data?.detail || 'Filtre silinemedi.');
    }
  }, [selectedSavedFilterId]);

  useEffect(() => {
    loadSavedFilters();
  }, [loadSavedFilters]);

  // SSE: Listen for real-time updates from other users
  useEffect(() => {
    tasksRef.current = tasks;

    // Track recent local parent updates to avoid reacting to server SSE
    const recentLocalParentUpdates = new Map<string, number>();

    const token = localStorage.getItem('access_token');
    if (!token) return;

    const baseURL = api.defaults.baseURL || '/api/v1';
    const eventURL = `${baseURL}/events?token=${token}`;
    const eventSource = new EventSource(eventURL);

    eventSource.onopen = () => {
      console.log('[SSE] Connected');
    };

    eventSource.onerror = () => {
      console.warn('[SSE] Connection lost, will auto-reconnect...');
    };

    eventSource.addEventListener('TASK_UPDATED', (event) => {
      console.log('[SSE] Task updated:', event.data);
      // Delay and check for recent local updates
      setTimeout(() => {
        try {
          let eventData: any = {};
          try {
            eventData = JSON.parse(event.data);
          } catch {
            // If not JSON, treat as simple update
          }

          // If this is a manual_steps_updated event, derive the scope (split or order)
          // directly from task_id so we do not need a stale task lookup.
          if (eventData?.data?.action === 'manual_steps_updated') {
            const taskId = String(eventData?.data?.task_id || '');
            if (taskId) {
              console.log('[SSE] Manual steps updated for task:', taskId);
              const scopeId = getManualStepScopeIdForTask(taskId, null);
              console.log('[SSE] Fetching manual steps for scope:', scopeId);
              void fetchManualStepsForScope(scopeId, matchTaskForScope(scopeId));
              return;
            }
            // Fallback: fetch all if we can't derive the scope
            console.log('[SSE] Could not derive scope from task_id, falling back to fetchTasks');
            fetchTasks();
            return;
          }

          const now = Date.now();
          let hasRecentLocal = false;
          for (const ts of recentLocalParentUpdates.values()) {
            if (now - ts < 2000) {
              hasRecentLocal = true;
              break;
            }
          }
          if (!hasRecentLocal) {
            fetchTasks();
          } else {
            for (const [k, v] of Array.from(recentLocalParentUpdates.entries())) {
              if (now - v > 5000) recentLocalParentUpdates.delete(k);
            }
          }
        } catch (err) {
          fetchTasks();
        }
      }, 250);
    });

    eventSource.addEventListener('TASK_SPLIT', () => {
      console.log('[SSE] Task split');
      fetchTasks();
    });

    eventSource.addEventListener('TASK_CREATED', () => fetchTasks());
    eventSource.addEventListener('TASK_DELETED', () => fetchTasks());
    // Tatil listesi eskiden sayfa açılışında bir kez yükleyip cache'leniyordu —
    // biri tatil eklerken/silerken sayfa açık kalan kullanıcılar eski listeyle
    // yanlış hesaba (yıllık iş günü sayımı, addBusinessDays fallback'i) devam
    // ederdi. Backend artık her tatil değişikliğinde bu event'i yayınlıyor.
    eventSource.addEventListener('HOLIDAY_UPDATED', () => fetchHolidays());

    // scopeId is either "split_<uuid>" (one independent delivery split) or
    // "order_<uuid>" (whole order, for tasks without an explicit split).
    const matchTaskForScope = (scopeId: string) => {
      const rootId = getSplitRootId(scopeId);
      if (rootId) {
        return (task: DeliveryTask) => Boolean(task.stage) && getSplitRootId(String(task.id)) === rootId;
      }
      return (task: DeliveryTask) => Boolean(task.stage) && Boolean(task.parent) && String(task.parent) === scopeId;
    };

    const fetchManualStepsForScope = async (scopeId: string, matchTask: (task: DeliveryTask) => boolean) => {
      try {
        const { data } = await api.get(`/gantt/tasks/${scopeId}/manual-steps`);
        const steps = data?.steps || {};
        setTasks((prev) =>
          prev.map((task) => {
            if (!matchTask(task)) return task;
            const stepMeta = steps[task.stage as string] || {};
            const prefix = stepMeta.checked ? '✅ ' : '';
            const cleanChip = String(task.chipLabel || task.calendarLabel || task.text || '').replace(/^✅\s*/, '');
            const cleanCalendar = String(task.calendarLabel || task.text || '').replace(/^✅\s*/, '');
            return { ...task, chipLabel: `${prefix}${cleanChip}`, calendarLabel: `${prefix}${cleanCalendar}` };
          }),
        );
      } catch (err) {
        console.warn('manual-steps fetch failed for scope', scopeId, err);
      }
    };

    const handleStatusChange = (ev: Event) => {
      try {
        const detail = (ev as CustomEvent)?.detail;
        const splitId = detail?.splitId as string | null | undefined;
        const parentIdFromDetail = detail?.parentId;

        if (splitId) {
          recentLocalParentUpdates.set(String(splitId), Date.now());
          void fetchManualStepsForScope(String(splitId), matchTaskForScope(String(splitId)));
          return;
        }

        if (parentIdFromDetail) {
          const pid = String(parentIdFromDetail);
          recentLocalParentUpdates.set(pid, Date.now());
          void fetchManualStepsForScope(pid, matchTaskForScope(pid));
          return;
        }

        fetchTasks();
      } catch (err) {
        fetchTasks();
      }
    };

    window.addEventListener('dps-task-status-changed', handleStatusChange);

    return () => {
      eventSource.close();
      window.removeEventListener('dps-task-status-changed', handleStatusChange);
    };
  }, [fetchTasks, fetchHolidays]);
  const monthGrid = useMemo(() => buildMonthGrid(calendarDate), [calendarDate]);
  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(calendarDate),
    [calendarDate],
  );

  const monthlyEventsByDay = useMemo(() => {
    const map = new Map<string, DeliveryTask[]>();
    filteredOrders.forEach((task) => {
      const key = dateKey(task.deliveryDate);
      const list = map.get(key) || [];
      list.push(task);
      map.set(key, list);
    });
    map.forEach((list) => list.sort(compareTasksByOrderAndStage));
    return map;
  }, [filteredOrders]);

  const yearlyMonths = useMemo(() => {
    return Array.from({ length: 12 }, (_, monthIndex) => {
      const monthStart = new Date(yearViewYear, monthIndex, 1);
      const monthEndExclusive = new Date(yearViewYear, monthIndex + 1, 1);
      return {
        monthIndex,
        shortLabel: YEAR_MONTHS[monthIndex],
        fullLabel: YEAR_MONTHS_LONG[monthIndex],
        daysInMonth: new Date(yearViewYear, monthIndex + 1, 0).getDate(),
        workdayCount: countWorkdaysInRange(monthStart, monthEndExclusive, holidayKeySet),
      };
    });
  }, [holidayKeySet, yearViewYear]);

  const yearlyMonthLayouts = useMemo(() => {
    return yearlyMonths.map((month) => {
      const entriesByDay = new Map<number, DeliveryTask[]>();

      filteredOrders.forEach((task) => {
        if (task.deliveryDate.getFullYear() !== yearViewYear) return;
        if (task.deliveryDate.getMonth() !== month.monthIndex) return;
        const dayNumber = task.deliveryDate.getDate();
        const list = entriesByDay.get(dayNumber) || [];
        list.push(task);
        entriesByDay.set(dayNumber, list);

      });

      entriesByDay.forEach((list) => list.sort(compareTasksByOrderAndStage));

      const lanesByTaskId = new Map<string, number>();
      let maxLaneInMonth = -1;

      if (timelineMode === 'yearly') {
        const monthEventsList: { task: DeliveryTask; day: number }[] = [];
        entriesByDay.forEach((list, dayNumber) => {
          list.forEach((task) => {
            monthEventsList.push({ task, day: dayNumber });
          });
        });

        monthEventsList.sort((a, b) => {
          if (a.day !== b.day) return a.day - b.day;
          return compareTasksByOrderAndStage(a.task, b.task);
        });

        const laneEnds: number[] = [];
        monthEventsList.forEach((item) => {
          const startDay = Math.max(1, item.day - 1);
          const endDay = Math.min(month.daysInMonth, item.day + 1);
          let lane = 0;
          while (laneEnds[lane] !== undefined && laneEnds[lane] >= startDay) {
            lane++;
          }
          laneEnds[lane] = endDay;
          lanesByTaskId.set(String(item.task.id), lane);
          if (lane > maxLaneInMonth) maxLaneInMonth = lane;
        });
      }

      return {
        ...month,
        entriesByDay,
        totalCount: Array.from(entriesByDay.values()).reduce((acc, list) => acc + list.length, 0),
        lanesByTaskId,
        maxLaneInMonth,
      };
    });
  }, [filteredOrders, yearViewYear, yearlyMonths, timelineMode]);


  const goPrevMonth = useCallback(() => {
    setCalendarDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }, []);

  const goNextMonth = useCallback(() => {
    setCalendarDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }, []);

  const goPrevYear = useCallback(() => setYearViewYear((prev) => prev - 1), []);
  const goNextYear = useCallback(() => setYearViewYear((prev) => prev + 1), []);

  const toggleSidebarCollapse = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
      window.dispatchEvent(new Event('sidebarCollapseSync'));
      return next;
    });
    setIsSidebarResizing(false);
  }, []);

  useEffect(() => {
    const handleSync = () => {
      try {
        setIsSidebarCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
      } catch { /* ignore */ }
    };
    window.addEventListener('sidebarCollapseSync', handleSync);
    return () => window.removeEventListener('sidebarCollapseSync', handleSync);
  }, []);

  // "Aktif Siparişler" paneli sabit piksel genişlikte (varsayılan 260px) — sol app
  // navigasyonuyla (bkz. Layout.tsx'teki aynı düzeltme) birlikte dar ekranlarda
  // (telefon, küçültülmüş pencere) asıl takvim/Gantt alanına yer bırakmayıp
  // ekranın tamamen boş/siyah görünmesine yol açıyordu. Dar viewport'ta bu panel
  // otomatik kapatılır — ama kullanıcı "Aktif Siparişler" düğmesiyle TEKRAR
  // açtığında (bkz. ilgili bildirim) sabit genişlik sorunu geri geliyordu, çünkü
  // panel hâlâ bir grid sütunu olarak render ediliyordu. `isNarrowViewport`
  // sürekli (bir kerelik değil) takip edilir — dar ekranda panel açıkken grid
  // sütunu yerine ana içeriğin ÜZERİNİ kaplayan kapatılabilir bir "çekmece"
  // (overlay) olarak gösterilir (bkz. renderActiveOrdersSidebar).
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  useEffect(() => {
    // Mevcut CSS'teki "@media (max-width: 1100px) { .calendar-sidebar { display: none } }"
    // kuralıyla (index.css) AYNI eşik — ikisi arasında fark olursa 768-1100px
    // aralığında JS "geniş" sanıp grid sütunu render ederken CSS onu gizler,
    // boş bir sütun boşluğu kalırdı.
    const mql = window.matchMedia('(max-width: 1100px)');
    const handleChange = () => {
      setIsNarrowViewport(mql.matches);
      if (mql.matches) {
        setIsSidebarCollapsed(true);
        try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true'); } catch { /* ignore */ }
      }
    };
    handleChange();
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  const startSidebarResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isSidebarCollapsed) return;
    event.preventDefault();
    setIsSidebarResizing(true);
  }, [isSidebarCollapsed]);

  const startRightPanelResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (rightPanelState.mode === 'closed') return;
    event.preventDefault();
    setIsRightPanelResizing(true);
  }, [rightPanelState.mode]);

  useEffect(() => {
    if (!isSidebarResizing) return;

    const handleMove = (event: MouseEvent) => {
      const shellRect = calendarShellRef.current?.getBoundingClientRect();
      if (!shellRect) return;

      const nextWidth = Math.max(180, Math.min(460, event.clientX - shellRect.left));
      sidebarPendingWidthRef.current = nextWidth;

      if (sidebarResizeFrameRef.current !== null) return;

      sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
        sidebarResizeFrameRef.current = null;
        const pendingWidth = sidebarPendingWidthRef.current;
        if (pendingWidth !== null) {
          setSidebarWidth(pendingWidth);
        }
      });
    };

    const handleUp = () => {
      setIsSidebarResizing(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      sidebarPendingWidthRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    if (!isRightPanelResizing) return;

    const handleMove = (event: MouseEvent) => {
      const shellRect = contentShellRef.current?.getBoundingClientRect();
      if (!shellRect) return;

      const nextWidth = Math.max(280, Math.min(640, shellRect.right - event.clientX));
      rightPanelPendingWidthRef.current = nextWidth;

      if (rightPanelResizeFrameRef.current !== null) return;

      rightPanelResizeFrameRef.current = window.requestAnimationFrame(() => {
        rightPanelResizeFrameRef.current = null;
        const pendingWidth = rightPanelPendingWidthRef.current;
        if (pendingWidth !== null) {
          setRightPanelWidth(pendingWidth);
        }
      });
    };

    const handleUp = () => {
      setIsRightPanelResizing(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (rightPanelResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(rightPanelResizeFrameRef.current);
        rightPanelResizeFrameRef.current = null;
      }
      rightPanelPendingWidthRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isRightPanelResizing]);

  const renderActiveOrdersSidebar = () => {
    if (isSidebarCollapsed) return null;

    const listContent = (
      <>
        <div className="calendar-sidebar-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="calendar-sidebar-title">Aktif Siparişler</div>
            <span className="calendar-active-count">{activeOrders.length}</span>
          </div>
          {isNarrowViewport && (
            <button
              type="button"
              className="calendar-sidebar-overlay-close"
              onClick={() => setIsSidebarCollapsed(true)}
              aria-label="Kapat"
              title="Kapat"
            >
              ✕
            </button>
          )}
        </div>

          <div className="calendar-active-list calendar-active-list--sidebar">
            {activeOrders.length === 0 ? (
              <div className="calendar-active-empty">Aktif sipariş bulunmuyor.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div
                  ref={topScrollContainerRef}
                  onScroll={handleTopScroll}
                  className="active-orders-top-scrollbar"
                  style={{ overflowX: 'auto', overflowY: 'hidden', flexShrink: 0 }}
                >
                  <div style={{ width: `${tableScrollWidth}px`, height: '1px' }} />
                </div>
                <div
                  ref={tableContainerRef}
                  onScroll={handleBottomScroll}
                  style={{ overflow: 'auto', flex: 1 }}
                >
                  <table className="active-orders-table" ref={tableRef}>
                    <thead>
                      <tr>
                        <th>Sipariş No</th>
                        <th>Ürün</th>
                        <th>Müşteri</th>
                        <th>Adet</th>
                        <th>Başlangıç</th>
                        <th>Bitiş</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeOrders.map((task) => (
                        <tr
                          key={`active-${task.id}`}
                          className={`active-orders-row${task.isSplitChild ? ' active-orders-row--child' : ''}${task.isOrderGroupChild ? ' active-orders-row--groupchild' : ''}${task.isOrderGroupHead ? ' active-orders-row--grouphead' : ''}`}
                          title={task.isOrderGroupHead ? `Sipariş ${task.orderNo} - ${task.orderGroupSize} ürün` : (task.calendarLabel || task.text)}
                          onClick={task.isOrderGroupHead ? undefined : () => openTaskDetail(task)}
                        >
                          <td
                            className="active-orders-td active-orders-td--orderno"
                            data-product={task.isOrderGroupChild ? (task.productType || '—') : undefined}
                          >
                            {task.isOrderGroupChild ? null : (task.orderNo || '—')}
                          </td>
                          <td className="active-orders-td active-orders-td--product">
                            {!task.isOrderGroupChild && task.orderGroupSize && task.orderGroupSize > 1 ? (
                              <span className="active-orders-groupcount-badge">{task.orderGroupSize} ürün</span>
                            ) : (
                              task.productType || '—'
                            )}
                          </td>
                          <td className="active-orders-td active-orders-td--customer">
                            {task.customerName || '—'}
                          </td>
                          <td className="active-orders-td active-orders-td--qty">
                            {task.quantity ? `${formatQuantity(task.quantity)} adet` : '—'}
                          </td>
                          <td className="active-orders-td active-orders-td--date">
                            {task.start.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                          </td>
                          <td className="active-orders-td active-orders-td--date">
                            {task.deliveryDate.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
      </>
    );

    // Dar ekranda (telefon, küçültülmüş pencere) panel bir grid sütunu değil,
    // ana içeriğin üzerini kaplayan kapatılabilir bir çekmece (overlay) olarak
    // gösterilir — sabit genişlik (sidebarWidth) burada kullanılmaz, aksi halde
    // dar container'ı taşırıp takvimi görünmez hale getiriyordu.
    if (isNarrowViewport) {
      return (
        <>
          <div
            className="calendar-sidebar-overlay-backdrop"
            onClick={() => setIsSidebarCollapsed(true)}
          />
          <aside className="calendar-sidebar calendar-sidebar--overlay">
            {listContent}
          </aside>
        </>
      );
    }

    return (
      <>
        <aside className="calendar-sidebar" style={{ width: `${sidebarWidth}px`, contain: 'layout paint', willChange: 'width' }}>
          {listContent}
        </aside>

        <div
          className={`calendar-splitter ${isSidebarResizing ? 'is-dragging' : ''}`}
          onMouseDown={startSidebarResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Sol panel boyut ayirici"
        />
      </>
    );
  };


  const openTaskDetail = (task: any) => {
    // Force reset if same ID clicked
    setTaskIdToOpenInGantt(null);
    setTimeout(() => {
      setTaskIdToOpenInGantt(task.id);
      setRightPanelState({ mode: 'task', taskId: task.id });
    }, 0);
  };

  const handleSelectPanelTask = useCallback((newTaskId: string) => {
    if (rightPanelState.mode !== 'task' || String(rightPanelState.taskId) === String(newTaskId)) return;
    if (panelSwitchTimeoutRef.current) clearTimeout(panelSwitchTimeoutRef.current);
    setIsPanelSwitching(true);
    panelSwitchTimeoutRef.current = setTimeout(() => {
      setRightPanelState({ mode: 'task', taskId: newTaskId });
      setIsPanelSwitching(false);
    }, 250);
  }, [rightPanelState.mode, rightPanelState.taskId]);

  useEffect(() => () => {
    if (panelSwitchTimeoutRef.current) clearTimeout(panelSwitchTimeoutRef.current);
  }, []);

  const renderCreateModal = () => {
    if (isAdvancedCreateModalOpen) {
      return (
        <CreateDeliveryModal
          productInfos={productInfos}
          isLoadingProductInfos={isLoadingProductInfos}
          holidayKeySet={holidayKeySet}
          onClose={() => setIsAdvancedCreateModalOpen(false)}
          onCreated={() => fetchTasks(true)}
          onProductCreated={() => void fetchProductInfos()}
        />
      );
    }

    if (!isCreateModalOpen) return null;

    return (
      <QuickAddDeliveryWizard
        productInfos={productInfos}
        isLoadingProductInfos={isLoadingProductInfos}
        holidayKeySet={holidayKeySet}
        onClose={() => setIsCreateModalOpen(false)}
        // BİLEREK fetchTasks(false): (true) tam sayfa yükleme spinner'ını
        // tetikler (bkz. aşağıdaki "if (isLoading) return ..." early-return) —
        // bu da hâlâ AÇIK olan wizard'ı (başarı sonrası kasıtlı olarak
        // kapanmıyor, "Tamamlandı" adımını gösteriyor) unmount edip isCreateModalOpen
        // hâlâ true olduğu için SIFIRDAN yeniden mount ederdi, wizard'ı 1. adıma
        // resetlerdi (canlı bug: "oluştur"a basınca 'Tamamlandı' yerine 1. adım
        // açılıyordu). Liste hâlâ arka planda sessizce yenilenir.
        onCreated={() => fetchTasks(false)}
        onOpenAdvanced={() => {
          setIsCreateModalOpen(false);
          setIsAdvancedCreateModalOpen(true);
        }}
        onEditRequested={(taskId) => {
          setTaskIdToOpenInGantt(taskId);
          setAutoEditTaskId(taskId);
          setRightPanelState({ mode: 'task', taskId });
        }}
      />
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <svg className="animate-spin h-10 w-10 text-primary-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          <p className="text-surface-400 text-sm">Teslimat takvimi yükleniyor...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="glass-card p-8 max-w-md text-center">
          <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-red-400 mb-4">{error}</p>
          <button onClick={() => fetchTasks(true)} className="btn-primary">
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  // "Alt Ürünler" anahtarı YALNIZCA Özet takviminin veri hattında etkilidir, bu
  // yüzden Detay görünümlerinde hiç çizilmez. Sağ kümenin iç ucunda durduğu
  // için yokluğu sağındaki düğmeleri oynatmaz — bkz. viewControls.
  // Dolu/primary zemin (is-checked) BİLİNÇLİ olarak kullanılmıyor: kutucuk zaten
  // durumu gösteriyor ve bu anahtarın varsayılanı işaretli (alt ürünler görünür)
  // olduğundan, dolu renk header'da sürekli açık kalıp gereksiz gürültü yapardı.
  const hideComponentSubProductsToggle = (
    <label
      className="calendar-checkbox-toggle"
      title={
        hideComponentSubProducts
          ? 'İşaretsiz: alt ürünlerin (bileşenlerin) hazır olma barları takvimde GİZLİ. Göstermek için tıklayın. Parçalı teslimatlar bundan etkilenmez.'
          : 'İşaretli: alt ürünlerin (bileşenlerin) hazır olma barları takvimde GÖRÜNÜYOR. Gizlemek için tıklayın. Parçalı teslimatlar bundan etkilenmez.'
      }
    >
      {/* Gerçek checkbox görsel olarak gizli (tıklanabilirlik, klavye ve ekran
          okuyucu desteği bundan gelir); görünen kutucuk aşağıdaki span'dir.

          POLARİTE: kutucuk "alt ürünler GÖRÜNÜR mü?" sorusunu yanıtlar, yani
          state'in (hideComponentSubProducts) TERSİNİ gösterir — "Alt Ürünler ☑"
          etiketi doğal olarak "görünsün" diye okunduğu için. Depolanan mantık
          ve veri hattı değişmedi; yalnızca bu kutunun gösterimi/çevirisi ters.
          Bu yüzden checked={!hide...} ve onChange'de {!e.target.checked}. */}
      <input
        type="checkbox"
        className="calendar-checkbox-toggle-input"
        checked={!hideComponentSubProducts}
        onChange={(e) => setHideComponentSubProducts(!e.target.checked)}
      />
      <span className="calendar-checkbox-toggle-box">
        <svg className="calendar-checkbox-toggle-check" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </span>
      Alt Ürünler
    </label>
  );

  const isHierarchicalActive = displayMode === 'detail' && detailSubMode === 'hierarchical';

  /* Menü açılırken tetikleyici düğmenin viewport konumu ölçülür.
     DİKKAT — ölçüm `ref` ile YAPILAMAZ: Detay modunda `viewControls` aynı anda
     üç bileşene birden veriliyor (StageView + Gantt Dikey + Gantt Yatay; ikisi
     `display:none` ile gizli ama hepsi mount). Tek bir ref üçüne birden
     bağlanır, sonuncusu kazanır ve gizli olduğu için rect'i sıfır döner —
     menü ekranın sol üst köşesine düşer. Bunun yerine gerçekten hover edilen
     (yani görünür olan) eleman ölçülür. */
  const openDetailDropdown = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    setDetailDropdownPos({ top: rect.bottom + 8, left: rect.left });
    setIsDetailDropdownOpen(true);
  };

  /* Sağ kümenin sırası bilinçli: görünüme göre GELİP GİDEN denetimler
     (Dikey/Yatay, Alt Ürünler) en SOLDA — yani ortadaki başlığa bakan
     iç uçta — durur. Küme header'ın sağına yapışık olduğu için, bunlar
     kaybolunca sağlarındaki Özet/Detay, Aylık/Yıllık, Filtre ve + Teslimat
     düğmelerinin hiçbiri yerinden oynamaz; boşalan yeri esneyen başlık yutar.
     Bu yüzden görünmez yer tutucuya (placeholder) gerek yok — kümenin
     ortasında hiçbir zaman boşluk açılmaz. */
  const viewControls = (
    <div className="flex items-center gap-2">
      {/* Dikey/Yatay yalnızca Hiyerarşik Gantt'ta anlamlıdır. */}
      {isHierarchicalActive && (
        <div className="calendar-segmented">
          <button
            type="button"
            onClick={() => setHierarchicalOrientation('vertical')}
            className={`calendar-segmented-btn ${hierarchicalOrientation === 'vertical' ? 'is-active' : ''}`}
          >
            Dikey
          </button>
          <button
            type="button"
            onClick={() => setHierarchicalOrientation('horizontal')}
            className={`calendar-segmented-btn ${hierarchicalOrientation === 'horizontal' ? 'is-active' : ''}`}
          >
            Yatay
          </button>
        </div>
      )}

      {/* "Alt Ürünler" anahtarı yalnızca Özet'in veri hattında etkilidir. */}
      {displayMode === 'overview' && hideComponentSubProductsToggle}

      <div className="calendar-segmented">
        <button
          type="button"
          onClick={() => setDisplayMode('overview')}
          className={`calendar-segmented-btn ${displayMode === 'overview' ? 'is-active' : ''}`}
        >
          Özet
        </button>
        {/* STAGE_VIEW_ENABLED kapalıyken "Detay" düz bir düğmedir: hover menüsü
            hiç bağlanmaz (fareyle üzerinde beklemek bir şey açmaz) ve tıklayınca
            doğrudan Hiyerarşik Gantt'a geçer. Menülü sürüm aşağıda olduğu gibi
            duruyor, bayrak açılınca geri gelir. */}
        {!STAGE_VIEW_ENABLED ? (
          <button
            type="button"
            onClick={() => {
              setDisplayMode('detail');
              setDetailSubMode('hierarchical');
            }}
            className={`calendar-segmented-btn ${displayMode === 'detail' ? 'is-active' : ''}`}
          >
            Detay
          </button>
        ) : (
        <div
          className="relative flex items-center"
          onMouseEnter={(e) => {
            // DOM düğümü senkron yakalanır; zamanlayıcı tetiklendiğinde
            // event nesnesine güvenilemez.
            const anchor = e.currentTarget;
            if (detailHoverTimerRef.current) clearTimeout(detailHoverTimerRef.current);
            detailHoverTimerRef.current = setTimeout(() => openDetailDropdown(anchor), 300);
          }}
          onMouseLeave={() => {
            if (detailHoverTimerRef.current) clearTimeout(detailHoverTimerRef.current);
            detailHoverTimerRef.current = setTimeout(() => setIsDetailDropdownOpen(false), 200);
          }}
        >
          <button
            type="button"
            onClick={() => {
              if (detailHoverTimerRef.current) clearTimeout(detailHoverTimerRef.current);
              setDisplayMode('detail');
              setDetailSubMode('hierarchical');
              setIsDetailDropdownOpen(false);
            }}
            className={`calendar-segmented-btn ${displayMode === 'detail' ? 'is-active' : ''}`}
          >
            Detay
          </button>
          {isDetailDropdownOpen && detailDropdownPos && (
            <div
              className="detail-mode-dropdown"
              /* Konum JS ile ölçülür ve `position: fixed` kullanılır: header
                 dar pencerede yatay kaydırılabilir olduğu için `overflow`
                 kırpması var; absolute kalsaydı menü header'ın 60px'lik
                 kutusunda kesilir, arkada kalmış gibi görünürdü. */
              style={{ top: detailDropdownPos.top, left: detailDropdownPos.left }}
              onMouseEnter={() => {
                if (detailHoverTimerRef.current) clearTimeout(detailHoverTimerRef.current);
              }}
              onMouseLeave={() => {
                if (detailHoverTimerRef.current) clearTimeout(detailHoverTimerRef.current);
                detailHoverTimerRef.current = setTimeout(() => setIsDetailDropdownOpen(false), 200);
              }}
            >
              <button
                type="button"
                className={`detail-mode-dropdown-item ${detailSubMode === 'hierarchical' ? 'selected' : ''}`}
                onClick={() => { setDetailSubMode('hierarchical'); setDisplayMode('detail'); setIsDetailDropdownOpen(false); }}
              >
                Hiyerarşik Gantt
              </button>
              <button
                type="button"
                className={`detail-mode-dropdown-item ${detailSubMode === 'stageview' ? 'selected' : ''}`}
                onClick={() => { setDetailSubMode('stageview'); setDisplayMode('detail'); setIsDetailDropdownOpen(false); }}
              >
                Adım
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      <div className="calendar-segmented">
        <button
          type="button"
          onClick={() => setTimelineMode('monthly')}
          className={`calendar-segmented-btn ${timelineMode === 'monthly' ? 'is-active' : ''}`}
        >
          Aylık
        </button>
        <button
          type="button"
          onClick={() => setTimelineMode('yearly')}
          className={`calendar-segmented-btn ${timelineMode === 'yearly' ? 'is-active' : ''}`}
        >
          Yıllık
        </button>
      </div>
      <button
        type="button"
        className="calendar-nav-toggle calendar-header-filter-toggle"
        onClick={() => setIsFilterPanelCollapsed((prev) => !prev)}
        aria-label={isFilterPanelCollapsed ? 'Filtre panelini aç' : 'Filtre panelini kapat'}
      >
        {isFilterPanelCollapsed ? 'Filtreyi Aç' : 'Filtreyi Kapat'}
      </button>
    </div>
  );

  // "+ Teslimat" — her görünümde header'ın EN SAĞINDA, aynı yerde. Yetkisi
  // olmayan kullanıcıda hiç çizilmez (bu, kullanıcı bazında sabit olduğu için
  // görünümler arası tutarlılığı bozmaz).
  const handleCreateDelivery = (user?.role === 'ADMIN' || user?.role === 'PLANNER')
    ? () => setIsCreateModalOpen(true)
    : undefined;

  return (
    <div className="delivery-calendar-shell is-overview">
      {(displayMode === 'overview' || (displayMode === 'detail' && detailSubMode === 'hierarchical')) && !isFilterPanelCollapsed && (
        <div className="border-b border-surface-700/50 bg-surface-900/60 backdrop-blur-sm">
          <div className="px-4 py-3 flex flex-col gap-3">
            {/* Metin filtreleri */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold text-surface-500 uppercase tracking-widest">Metin Filtresi</span>
              {taskTextFilters.map((filter, index) => (
                <div key={`task-filter-${index}`} className="flex items-center gap-2">
                  <select
                    className="input-field !py-2 !text-sm flex-shrink-0 w-44"
                    value={filter.field}
                    onChange={(e) => updateTaskTextFilterRow(index, { field: e.target.value as TaskFilterField })}
                  >
                    {TASK_FILTER_FIELD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <input
                    className="input-field !py-2 !text-sm w-64"
                    placeholder="Ara..."
                    value={filter.query}
                    onChange={(e) => updateTaskTextFilterRow(index, { query: e.target.value })}
                  />
                  <button type="button" onClick={addTaskTextFilterRow}
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-700/50 hover:bg-primary-600/30 border border-surface-600/50 hover:border-primary-500/50 text-surface-300 hover:text-primary-300 text-base font-bold transition-all flex items-center justify-center">+</button>
                  <button type="button" onClick={() => removeTaskTextFilterRow(index)} disabled={taskTextFilters.length <= 1}
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-700/50 hover:bg-red-600/20 border border-surface-600/50 hover:border-red-500/50 text-surface-400 hover:text-red-400 text-sm font-bold transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed">✕</button>
                </div>
              ))}
            </div>

            {/* Alt bar */}
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-surface-700/40">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-surface-500 uppercase tracking-widest whitespace-nowrap">Müşteri</span>
                <select className="input-field !py-2 !text-sm w-48" value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)}>
                  <option value="">Tümü</option>
                  {customerOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="calendar-filter-divider hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-surface-500 uppercase tracking-widest whitespace-nowrap">Kayıtlı</span>
                <select className="input-field !py-2 !text-sm w-48" value={selectedSavedFilterId}
                  onChange={(e) => { const found = savedFilters.find((f) => String(f.id) === e.target.value); if (found) applySavedFilter(found); else setSelectedSavedFilterId(e.target.value); }}
                  disabled={isLoadingSavedFilters}>
                  <option value="">Filtre seç...</option>
                  {savedFilters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                <button type="button" onClick={handleDeleteSavedFilter} disabled={!selectedSavedFilterId}
                  className="flex-shrink-0 h-8 px-3 rounded-lg bg-surface-700/50 hover:bg-red-600/20 border border-surface-600/50 hover:border-red-500/50 text-surface-400 hover:text-red-400 text-xs font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed">Sil</button>
              </div>
              <div className="calendar-filter-divider hidden sm:block" />
              <div className="flex items-center gap-1.5">
                <input className="input-field !py-2 !text-sm w-40" placeholder="Filtre adı..." value={newSavedFilterName} onChange={(e) => setNewSavedFilterName(e.target.value)} />
                <button type="button" onClick={handleSaveCurrentFilter} disabled={isSavingFilter}
                  className="flex-shrink-0 h-8 px-3 rounded-lg bg-primary-600/20 hover:bg-primary-600/40 border border-primary-500/30 hover:border-primary-500/60 text-primary-300 text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
                  {isSavingFilter ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
              </div>
              <div className="ml-auto">
                <button type="button" onClick={clearAllFilters}
                  className="h-8 px-3 rounded-lg bg-surface-700/30 hover:bg-surface-700/60 border border-surface-600/30 text-surface-400 hover:text-surface-200 text-xs font-medium transition-all">Temizle</button>
              </div>
            </div>
            {savedFilterError && <p className="text-xs text-red-400 text-right -mt-1">{savedFilterError}</p>}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-row" ref={contentShellRef}>
        <div className="flex-1 min-w-0 h-full flex flex-col relative overflow-hidden">
          {displayMode === 'overview' ? (
            <>
              {/* Tek ve ortak header — .calendar-shell'in DIŞINDA, tam genişlikte.
                  Eskiden .calendar-main'in içindeydi: yan panel açılıp kapandıkça
                  sağa/sola kayıyor, Aylık ile Yıllık farklı yükseklikte iki ayrı
                  çubuk kullanıyordu. */}
              <CalendarHeader
                sidebar={{ collapsed: isSidebarCollapsed, onToggle: toggleSidebarCollapse }}
                onPrev={timelineMode === 'monthly' ? goPrevMonth : goPrevYear}
                onNext={timelineMode === 'monthly' ? goNextMonth : goNextYear}
                prevAriaLabel={timelineMode === 'monthly' ? 'Önceki ay' : 'Önceki yıl'}
                nextAriaLabel={timelineMode === 'monthly' ? 'Sonraki ay' : 'Sonraki yıl'}
                title={timelineMode === 'monthly' ? monthTitle : yearViewYear}
                controls={viewControls}
                onCreateDelivery={handleCreateDelivery}
              />
              {/* İzole mod bandı — modun açık olduğu her an görünür ve çıkış
                  düğmesini taşır. Kullanıcının "neden takvimde başka bir şey yok"
                  diye şaşırmaması için bilinçli olarak takvimin TAM ÜSTÜNDE. */}
              {focusedScope && (
                <div className="calendar-focus-banner">
                  <span className="calendar-focus-banner-badge">Alt adım görünümü</span>
                  <span className="calendar-focus-banner-title" title={focusedScope.title}>
                    {focusedScope.title || 'Teslimat'}
                  </span>
                  {focusedScope.orderNo && (
                    <span className="calendar-focus-banner-meta">Sipariş {focusedScope.orderNo}</span>
                  )}
                  <span className="calendar-focus-banner-meta">
                    {focusedLineCount > 1 ? `${focusedLineCount} kalem · ` : ''}
                    {focusedStageTasks?.length || 0} adım
                    {focusedRangeLabel ? ` · ${focusedRangeLabel}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={exitFocusMode}
                    className="calendar-focus-banner-exit"
                    title="Normal takvime dön (Esc)"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Normale dön
                    <kbd className="calendar-focus-banner-kbd">Esc</kbd>
                  </button>
                </div>
              )}
              <div
                ref={calendarShellRef}
                className={`calendar-shell is-below-header ${isSidebarCollapsed || focusedScope ? 'is-collapsed' : ''}`}
                style={{
                  gridTemplateColumns:
                    (isSidebarCollapsed || isNarrowViewport || focusedScope) ? '1fr' : `${sidebarWidth}px 8px 1fr`,
                }}
              >
                {/* İzole moddayken "Aktif Siparişler" listesi de gizlenir — tüm
                    siparişleri sayan bir panel, "sadece bu teslimat" vaadiyle
                    çelişirdi. Çıkışta olduğu gibi geri gelir. */}
                {!focusedScope && renderActiveOrdersSidebar()}

                <section ref={calendarMainRef} className="calendar-main overflow-auto">
                  {timelineMode === 'monthly' ? (
                    <>
                      {(
                        <>
                          <div
                            className="calendar-grid delivery-calendar-grid"
                          >
                            {WEEK_DAYS.map((d) => (
                              <div key={`weekday-${d}`} className="calendar-weekday">{d}</div>
                            ))}

                            {monthGrid.map((day) => {
                              const key = dateKey(day);
                              const isToday = key === dateKey(new Date());
                              const inMonth = day.getMonth() === calendarDate.getMonth();
                              const isHoliday = holidayKeySet.has(key);
                              const isWeekendDay = isWeekend(day);
                              const holidayName = holidayNameByDate.get(key);
                              const dayEvents = monthlyEventsByDay.get(key) || [];
                              const visibleCount = dayEvents.length;

                              return (
                                <div
                                  key={key}
                                  className={`calendar-day delivery-calendar-day ${inMonth ? '' : 'is-out'} ${isWeekendDay || isHoliday ? 'is-offday' : ''} ${isToday ? 'is-today' : ''} cursor-pointer hover:bg-surface-800/30 transition-colors`}
                                  title={buildTooltip(day, isToday, isHoliday, isWeekendDay, holidayName, dayEvents)}
                                  onClick={() => setRightPanelState({ mode: 'day', date: day, events: dayEvents })}
                                >
                                  <div className={`calendar-day-number ${isToday ? 'is-today' : ''}`}>{day.getDate()}</div>
                                  <div className="calendar-day-events delivery-calendar-day-events">
                                    {dayEvents.slice(0, visibleCount).map((task) => {
                                      const color = getChipColor(task);
                                      const isPanelHighlighted = !!task.highlightScopeId && task.highlightScopeId === activeHighlightScopeId;
                                      const isGroupHighlighted = isPanelHighlighted || (!!task.rootOrderId && task.rootOrderId === hoveredRootOrderId);
                                      const groupHighlightClass = isGroupHighlighted
                                        ? (task.isComponentBar ? 'is-group-highlighted-component' : 'is-group-highlighted-main')
                                        : '';
                                      return (
                                        <button
                                          type="button"
                                          key={task.id}
                                          className={`delivery-calendar-chip flex items-center justify-center ${groupHighlightClass}`}
                                          style={{ backgroundColor: color.bg, color: color.fg }}
                                          onMouseEnter={() => setHoveredRootOrderId(task.rootOrderId || null)}
                                          onMouseLeave={() => setHoveredRootOrderId(null)}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            openTaskDetail(task);
                                          }}
                                          onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setBarMenu({ x: e.clientX, y: e.clientY, task });
                                          }}
                                          title={focusedScope ? focusedBarLabels.get(String(task.id))?.full : undefined}
                                        >
                                          <span className="truncate text-center">
                                            {focusedScope
                                              ? focusedBarLabels.get(String(task.id))?.chip || getTaskStageLabel(task)
                                              : task.chipLabel || task.calendarLabel || task.text}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Yıllık görünümün kendi header'ı yok — yukarıdaki ortak
                          CalendarHeader Aylık ile birebir aynısını kullanır. */}
                      <div
                        className="yearly-planner-grid delivery-calendar-yearly-grid"
                        style={{}}
                      >
                          <div className="yearly-planner-head-label">Ay</div>
                          <div className="yearly-planner-head-days">
                            {Array.from({ length: YEARLY_PLANNER_COLS }, (_, dayIdx) => (
                              <div key={`head-day-${dayIdx + 1}`} className="yearly-planner-head-day">{dayIdx + 1}</div>
                            ))}
                          </div>

                          {yearlyMonthLayouts.map((month) => {
                            let slotCount = 1;
                            if (timelineMode === 'yearly') {
                              slotCount = Math.max(1, (month.maxLaneInMonth || 0) + 1);
                            } else {
                              let maxEventsInDay = 0;
                              month.entriesByDay.forEach((list) => {
                                if (list.length > maxEventsInDay) maxEventsInDay = list.length;
                              });
                              slotCount = Math.max(1, maxEventsInDay);
                            }
                            const rowHeightMultiplier = timelineMode === 'yearly' ? 22 : 18;
                            const dynamicMinHeight = 26 + 6 + slotCount * rowHeightMultiplier + 4;
                            const rowStyle = { minHeight: `${dynamicMinHeight}px` };

                            return (
                              <Fragment key={`planner-month-${month.monthIndex}`}>
                                <div className="yearly-planner-month-label" style={rowStyle} title={`${month.fullLabel} · ${month.workdayCount} iş günü`}>
                                  <div className="flex flex-col items-center justify-center leading-none">
                                    <span>{month.shortLabel}</span>
                                    <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'none', color: '#7f8aa3', marginTop: '2px' }}>
                                      {month.workdayCount} iş günü
                                    </span>
                                  </div>
                                </div>
                                <div className="yearly-planner-month-row">
                                  {Array.from({ length: YEARLY_PLANNER_COLS }, (_, colIdx) => {
                                    const dayNumber = colIdx + 1;
                                    const isEmpty = dayNumber > month.daysInMonth;
                                    if (isEmpty) {
                                      return <div key={`empty-${month.monthIndex}-${dayNumber}`} className="yearly-planner-cell is-empty" style={rowStyle} />;
                                    }

                                    const cellDate = new Date(yearViewYear, month.monthIndex, dayNumber);
                                    const key = dateKey(cellDate);
                                    const isToday = key === dateKey(new Date());
                                    const isHoliday = holidayKeySet.has(key);
                                    const isWeekendDay = isWeekend(cellDate);
                                    const holidayName = holidayNameByDate.get(key);
                                    const dayEvents = month.entriesByDay.get(dayNumber) || [];
                                    const visibleCount = dayEvents.length;

                                    const weekendColor = weekendColorPalette[month.monthIndex];
                                    const weekendBg = isWeekendDay
                                      ? ({
                                        backgroundColor: weekendColor,
                                        '--weekend-tint': weekendColor,
                                      } as React.CSSProperties)
                                      : {};
                                    const cellStyle = { ...rowStyle, ...weekendBg };

                                    return (
                                      <div
                                        key={`cell-${month.monthIndex}-${dayNumber}`}
                                        className={`yearly-planner-cell ${isWeekendDay ? 'is-weekend delivery-calendar-yearly-weekend' : ''} ${isHoliday ? 'is-holiday' : ''} ${isToday ? 'is-today' : ''} cursor-pointer hover:bg-surface-800/30 transition-colors`}
                                        title={buildTooltip(cellDate, isToday, isHoliday, isWeekendDay, holidayName, dayEvents)}
                                        style={cellStyle}
                                        onClick={() => setRightPanelState({ mode: 'day', date: cellDate, events: dayEvents })}
                                      >
                                        <span className="yearly-planner-cell-day">{dayNumber}</span>
                                        <span className="yearly-planner-cell-weekday">{WEEK_DAYS[(cellDate.getDay() + 6) % 7]}</span>
                                        <div className="yearly-planner-cell-events delivery-calendar-yearly-events">
                                          {dayEvents.slice(0, visibleCount).map((task) => {
                                            const color = getChipColor(task);
                                            const chipStyle: React.CSSProperties = {
                                              backgroundColor: color.bg,
                                              color: color.fg,
                                            };

                                            if (timelineMode === 'yearly') {
                                              const lane = month.lanesByTaskId?.get(String(task.id)) || 0;
                                              chipStyle.position = 'absolute';

                                              const isFirstDay = dayNumber === 1;
                                              const isLastDay = dayNumber === month.daysInMonth;

                                              if (isFirstDay && isLastDay) {
                                                chipStyle.width = '100%';
                                                chipStyle.marginLeft = '0';
                                              } else if (isFirstDay) {
                                                chipStyle.width = 'calc(200% + 1px)';
                                                chipStyle.marginLeft = '0';
                                              } else if (isLastDay) {
                                                chipStyle.width = 'calc(200% + 1px)';
                                                chipStyle.marginLeft = 'calc(-100% - 1px)';
                                              } else {
                                                chipStyle.width = 'calc(300% + 2px)';
                                                chipStyle.marginLeft = 'calc(-100% - 1px)';
                                              }

                                              chipStyle.top = `${lane * 22}px`;
                                              chipStyle.height = '18px';
                                              chipStyle.zIndex = 10;
                                            }

                                            const isPanelHighlighted = !!task.highlightScopeId && task.highlightScopeId === activeHighlightScopeId;
                                            const isGroupHighlighted = isPanelHighlighted || (!!task.rootOrderId && task.rootOrderId === hoveredRootOrderId);
                                            const groupHighlightClass = isGroupHighlighted
                                              ? (task.isComponentBar ? 'is-group-highlighted-component' : 'is-group-highlighted-main')
                                              : '';
                                            return (
                                              <button
                                                type="button"
                                                key={task.id}
                                                className={`delivery-calendar-chip flex items-center justify-center ${isToday ? 'is-today' : ''} ${groupHighlightClass}`}
                                                style={chipStyle}
                                                onMouseEnter={() => setHoveredRootOrderId(task.rootOrderId || null)}
                                                onMouseLeave={() => setHoveredRootOrderId(null)}
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  openTaskDetail(task);
                                                }}
                                                onContextMenu={(e) => {
                                                  e.preventDefault();
                                                  e.stopPropagation();
                                                  setBarMenu({ x: e.clientX, y: e.clientY, task });
                                                }}
                                                title={focusedScope ? focusedBarLabels.get(String(task.id))?.full : undefined}
                                              >
                                                <span className="truncate text-center">
                                                  {focusedScope
                                                    ? focusedBarLabels.get(String(task.id))?.chip || getTaskStageLabel(task)
                                                    : task.chipLabel || task.calendarLabel || task.text}
                                                </span>
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </Fragment>
                            );
                          })}
                        </div>
                    </>
                  )}
                </section>
              </div>

            </>
          ) : null}

          {displayMode === 'detail' && (
            <div className="h-full">
              {/* Bayrak kapalıyken StageView hiç mount EDİLMEZ — sadece CSS ile
                  gizlemek yetmezdi: bileşen kendi verisini çekiyor ve kaydırma/
                  senkronizasyon işleri kuruyor, yani görünmese bile ağ isteği ve
                  iş yapmaya devam ederdi. */}
              {STAGE_VIEW_ENABLED && (
              <div className={detailSubMode === 'stageview' ? 'h-full' : 'hidden h-full'}>
                <StageView
                  isActive={detailSubMode === 'stageview'}
                  timelineMode={timelineMode}
                  headerExtra={viewControls}
                  taskIdToOpen={taskIdToOpenInGantt}
                  onTaskIdHandled={() => setTaskIdToOpenInGantt(null)}
                  onViewStateChanged={handleGanttViewStateChanged}
                  filterPanelOpen={detailSubMode === 'stageview' ? !isFilterPanelCollapsed : undefined}
                  highlightScopeId={activeHighlightScopeId}
                  onTaskDoubleClicked={(taskId) => {
                    setTaskIdToOpenInGantt(taskId);
                    setRightPanelState({ mode: 'task', taskId });
                  }}
                  onEditRequested={(taskId) => {
                    setTaskIdToOpenInGantt(taskId);
                    setAutoEditTaskId(taskId);
                    setRightPanelState({ mode: 'task', taskId });
                  }}
                />
              </div>
              )}
              <div className={detailSubMode === 'hierarchical' && hierarchicalOrientation === 'vertical' ? 'h-full' : 'hidden h-full'}>
                <HierarchicalGantt
                  zoomLevel={timelineMode}
                  refreshKey={ganttRefreshKey}
                  taskTextFilters={taskTextFilters}
                  customerFilter={customerFilter}
                  onTaskClick={(taskId) => setRightPanelState({ mode: 'task', taskId })}
                  headerExtra={viewControls}
                  onCreateDelivery={handleCreateDelivery}
                  highlightScopeId={activeHighlightScopeId}
                />
              </div>
              {/* Yatay görünüm de HierarchicalGantt'tır (orientation="horizontal"):
                  sol ağaç paneli, aç/kapa ve etiketler Dikey ile BİREBİR aynı;
                  yalnızca sağ gövde kesintisiz zaman eksenine dönüşür. */}
              <div className={detailSubMode === 'hierarchical' && hierarchicalOrientation === 'horizontal' ? 'h-full' : 'hidden h-full'}>
                <HierarchicalGantt
                  orientation="horizontal"
                  zoomLevel={timelineMode}
                  refreshKey={ganttRefreshKey}
                  taskTextFilters={taskTextFilters}
                  customerFilter={customerFilter}
                  onTaskClick={(taskId) => setRightPanelState({ mode: 'task', taskId })}
                  headerExtra={viewControls}
                  onCreateDelivery={handleCreateDelivery}
                  highlightScopeId={activeHighlightScopeId}
                  holidayKeySet={holidayKeySet}
                />
              </div>
            </div>
          )}

          {/* "Teslimat Ekle" penceresi — HER görünümde (Özet, Adım, Hiyerarşik
              Dikey/Yatay) açılabilmesi için görünüm bloklarının DIŞINDA duruyor.
              Eskiden yalnızca Özet bloğunun içinde render ediliyordu, bu yüzden
              Detay modunda düğmeye basınca hiçbir şey olmuyordu. */}
          {renderCreateModal()}

          {/* Bar sağ tık menüsü. `position: fixed` — takvim gövdesi kaydırılabilir
              olduğu için absolute konumlandırma menüyü kırpardı. Dışarı tıklama,
              kaydırma ve Esc ile kapanır (yukarıdaki effect'ler). */}
          {barMenu && (
            <div
              className="calendar-bar-menu"
              style={{
                // Menü sağ/alt kenardan taşmasın diye viewport'a göre sıkıştırılır.
                top: Math.min(barMenu.y, window.innerHeight - 90),
                left: Math.min(barMenu.x, window.innerWidth - 230),
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="calendar-bar-menu-title" title={barMenu.task.calendarLabel || barMenu.task.text}>
                {barMenu.task.productType || normalizeTaskText(barMenu.task.text || '') || barMenu.task.text}
              </div>
              <button type="button" className="calendar-bar-menu-item" onClick={() => enterFocusMode(barMenu.task)}>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M7 12h10M10 18h4" />
                </svg>
                Alt adımları göster
              </button>
              <button
                type="button"
                className="calendar-bar-menu-item"
                onClick={() => {
                  setBarMenu(null);
                  openTaskDetail(barMenu.task);
                }}
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z" />
                </svg>
                Detayları aç
              </button>
            </div>
          )}
        </div>

        {rightPanelState.mode !== 'closed' && (
          <div
            className={`calendar-splitter ${isRightPanelResizing ? 'is-dragging' : ''}`}
            onMouseDown={startRightPanelResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Sag panel boyut ayirici"
          />
        )}

        {rightPanelState.mode !== 'closed' && (
          <RightPanel
            mode={rightPanelState.mode}
            taskId={rightPanelState.taskId}
            dayDate={rightPanelState.date}
            dayEvents={rightPanelState.events}
            panelWidth={rightPanelWidth}
            isResizing={isRightPanelResizing}
            isSwitching={isPanelSwitching}
            onClose={() => {
              if (panelSwitchTimeoutRef.current) clearTimeout(panelSwitchTimeoutRef.current);
              setIsPanelSwitching(false);
              setRightPanelState({ mode: 'closed' });
            }}
            onUpdate={() => fetchTasks(false)}
            onTaskStatusChanged={handleTaskStatusChanged}
            onSelectTask={handleSelectPanelTask}
            tasks={tasks}
            holidays={holidays}
            isOverview={displayMode === 'overview'}
            autoEditTaskId={autoEditTaskId}
          />
        )}
      </div>
    </div>
  );
}
