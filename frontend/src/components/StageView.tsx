/**
 * StageView component — event-only monthly and yearly delivery-date view.
 * Independent from GanttChart. Only uses custom-built calendar grids.
 */

import { useState, useEffect, useCallback, useMemo, useRef, Fragment, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import api from '../lib/api';
import { getTaskStageLabel } from '../lib/stageLabels';
import { dateKey, toDateInput, startOfDay, isWeekend, addBusinessDays, countWorkdaysInRange } from '../lib/dateUtils';
import {
  TASK_FILTER_FIELD_OPTIONS,
  createEmptyTaskTextFilter,
  matchesTaskTextFilters,
  type TaskFilterField,
  type TaskTextFilter,
} from '../lib/taskFilters';
import { useAuth } from '../contexts/AuthContext';
import {
  YEARLY_MONTH_WEEKEND_COLORS_DARK,
  YEARLY_MONTH_WEEKEND_COLORS_LIGHT,
  getTaskColor,
} from '../lib/colorPalette';
import CreateDeliveryModal, { type ProductInfoItem } from './CreateDeliveryModal';
import QuickAddDeliveryWizard from './QuickAddDeliveryWizard';
import { useActiveOrders } from '../hooks/useActiveOrders';
import CalendarHeader from './CalendarHeader';

const DAY_MS = 86400000;
// Aylık Adım takviminde bir adım barı, etiketi okunabilsin diye kendi gününün
// her iki yanına bu kadar hücre taşar (yani normalde 1 + 1 + 1 = 3 hücre,
// günün üzerinde ORTALI). Adımlar tek güne düştüğü için bu genişlik SÜREYİ
// değil, yalnızca "ANT-4220-P2 - Fason (Dış Dizgi)" gibi uzun etiketlerin
// sığmasını sağlar. Izgara kenarındaki günlerde (pazartesi/pazar) taşma
// kırpılır. Lane ataması bu taşmayı hesaba katar — bkz. LANE_GAP_MS.
const LABEL_BLEED_CELLS = 1;
const WEEK_DAYS = ['PZT', 'SAL', 'CAR', 'PER', 'CUM', 'CMT', 'PAZ'];
const YEAR_MONTHS = ['Oca', 'Sub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Agu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const YEAR_MONTHS_LONG = ['Ocak', 'Subat', 'Mart', 'Nisan', 'Mayis', 'Haziran', 'Temmuz', 'Agustos', 'Eylul', 'Ekim', 'Kasim', 'Aralik'];
const YEARLY_PLANNER_COLS = 31;
const TIMELINE_MODE_STORAGE_KEY = 'deliveryCalendarTimelineMode';
const SIDEBAR_COLLAPSED_KEY = 'deliveryCalendarSidebarCollapsed';


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


const buildTaskBarLabel = (productType: string, task: any) => {
  const productLabel = String(productType || normalizeTaskText(task?.text || '') || task?.text || '').trim();
  const stageLabel = getTaskStageLabel(task);
  if (productLabel && stageLabel) return `${productLabel} - ${stageLabel}`;
  return productLabel || stageLabel || String(task?.text || '');
};

const getTaskOrderGroupKey = (task: any) =>
  String(task?.orderNo || task?.parent || task?.externalId || task?.id || '');

const getTaskStageOrder = (task: any) => {
  const stage = String(task?.stage || '').trim().toLowerCase();
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

const compareTasksByOrderAndStage = (a: any, b: any) => {
  const aGroup = getTaskOrderGroupKey(a);
  const bGroup = getTaskOrderGroupKey(b);
  if (aGroup !== bGroup) return aGroup.localeCompare(bGroup, 'tr');

  const aStage = getTaskStageOrder(a);
  const bStage = getTaskStageOrder(b);
  if (aStage !== bStage) return aStage - bStage;

  const aStart = a.start instanceof Date ? a.start.getTime() : 0;
  const bStart = b.start instanceof Date ? b.start.getTime() : 0;
  if (aStart !== bStart) return aStart - bStart;

  return String(a.id).localeCompare(String(b.id));
};

const getSplitRootId = (taskId: string) => {
  if (!taskId.startsWith('split_') || taskId.startsWith('split_fake_')) return null;
  const raw = taskId.slice('split_'.length);
  const parts = raw.split('_');
  return parts[0] || null;
};

// Sağ panelde açık olan görevle AYNI parçalı teslimata (split) ait bar'ları
// bulmak için — bkz. DeliveryCalendarPage.tsx içindeki aynı isimli fonksiyon.
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

const formatQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '');
};


const toIsoStart = (dateInput: string) => `${dateInput}T00:00:00Z`;
const toIsoEndExclusive = (dateInput: string) => {
  const d = new Date(`${dateInput}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return toDateInput(d) + "T00:00:00Z";
};


const buildDayTooltip = (date: Date, isToday: boolean, isHoliday: boolean, isWeekendDay: boolean, holidayName: string | undefined, dayEvents: any[]) => {
  const lines = [];
  lines.push(date.toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  if (isToday) lines.push('📌 Bugün');
  if (isHoliday) lines.push(`🏖️ Resmi Tatil: ${holidayName || 'Tatil'}`);
  else if (isWeekendDay) lines.push('🛋️ Hafta Sonu');

  if (dayEvents && dayEvents.length > 0) {
    if (lines.length > 0) lines.push('----------');
    lines.push('📦 Teslimatlar:');

    const uniqueTasks = new Map();
    dayEvents.forEach((e) => uniqueTasks.set(e.task.id, e.task));

    uniqueTasks.forEach((task) => {
      const qtyStr = task.quantityLabel ? ` (${task.quantityLabel})` : '';
      const label = task.chipLabel || task.productType || task.text;
      const orderMatch = task.calendarLabel ? task.calendarLabel.match(/Siparis [^|]+/) : null;
      const orderStr = orderMatch ? ` - ${orderMatch[0]}` : '';
      lines.push(`• ${label}${orderStr}${qtyStr}`);
    });
  } else {
    if (lines.length > 0) lines.push('----------');
    lines.push('Teslimat yok.');
  }

  return lines.join('\n');
};

interface HolidayItem {
  id: string;
  holiday_date: string;
  name: string;
  is_active: boolean;
}

interface SavedFilterCriteria {
  task_filter_field?: TaskFilterField;
  task_filter_query?: string;
  customer_filter?: string;
  task_filters?: TaskTextFilter[];
  supply_days_min?: number | '';
  supply_days_max?: number | '';
  production_days_min?: number | '';
  production_days_max?: number | '';
}

interface SavedFilterItem {
  id: string;
  name: string;
  criteria: SavedFilterCriteria;
  created_by_username?: string;
}

const getInitialTimelineMode = (): 'yearly' | 'monthly' => {
  if (typeof window === 'undefined') return 'monthly';
  try {
    const saved = window.localStorage.getItem(TIMELINE_MODE_STORAGE_KEY);
    if (saved === 'yearly') return saved;
    return 'monthly';
  } catch {
    return 'monthly';
  }
};

interface StageViewProps {
  onTaskDoubleClicked?: (taskId: string) => void;
  // QuickAddDeliveryWizard'daki "Detayları Düzenle" için — onTaskDoubleClicked'dan
  // AYRI tutulur çünkü o özet paneli açar, bu ise sağ panelin doğrudan düzenleme
  // ekranını (OrderDetailModal) göstermesini ister (bkz. RightPanel.tsx autoEditTaskId).
  onEditRequested?: (taskId: string) => void;
  taskIdToOpen?: string | null;
  onTaskIdHandled?: () => void;
  onViewStateChanged?: () => void;
  isActive?: boolean;
  timelineMode?: 'monthly' | 'yearly';
  filterPanelOpen?: boolean;
  headerExtra?: ReactNode;
  highlightScopeId?: string | null;
}

export default function StageView({ onTaskDoubleClicked, onEditRequested, taskIdToOpen, onTaskIdHandled, onViewStateChanged, isActive = true, timelineMode: timelineModeProp, filterPanelOpen, headerExtra, highlightScopeId }: StageViewProps) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<any[]>([]);
  // Bir bara hover olununca ana sipariş + tüm alt ürünleri + parçalı
  // teslimatları birlikte vurgulamak için — Özet takvim, Hiyerarşik Gantt ve
  // Yatay Timeline ile aynı davranış.
  const [hoveredRootOrderId, setHoveredRootOrderId] = useState<string | null>(null);
  const tasksRef = useRef<any[]>([]);
  const [holidays, setHolidays] = useState<HolidayItem[]>([]);
  const [holidaysLoaded, setHolidaysLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const renderStartOnly = true;
  const [timelineMode, setTimelineMode] = useState<'yearly' | 'monthly'>(() => timelineModeProp || getInitialTimelineMode());

  useEffect(() => {
    if (timelineModeProp) setTimelineMode(timelineModeProp);
  }, [timelineModeProp]);

  const [calendarDate, setCalendarDate] = useState<Date>(() => new Date());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [taskTextFilters, setTaskTextFilters] = useState<TaskTextFilter[]>([createEmptyTaskTextFilter()]);
  const [customerFilter, setCustomerFilter] = useState('');
  const [isFilterPanelCollapsedInternal] = useState(true);
  const isFilterPanelCollapsed = filterPanelOpen !== undefined ? !filterPanelOpen : isFilterPanelCollapsedInternal;
  const [savedFilters, setSavedFilters] = useState<SavedFilterItem[]>([]);
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState('');
  const [newSavedFilterName, setNewSavedFilterName] = useState('');
  const [isSavingFilter, setIsSavingFilter] = useState(false);
  const [isLoadingSavedFilters, setIsLoadingSavedFilters] = useState(false);
  const [savedFilterError, setSavedFilterError] = useState('');
  const [yearViewYear, setYearViewYear] = useState<number>(() => new Date().getFullYear());
  const [isLightMode, setIsLightMode] = useState(() => document.documentElement.classList.contains('theme-light'));

  const [undoInfo, setUndoInfo] = useState<{ taskId: string; label: string } | null>(null);
  const [undoSubmitting, setUndoSubmitting] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // "Gelişmiş ekleme" — yeni ürün tanımlama / abonelik gibi QuickAddDeliveryWizard'ın
  // kapsamadığı durumlar için wizard'ın 1. adımından açılan eski tam form.
  const [isAdvancedCreateModalOpen, setIsAdvancedCreateModalOpen] = useState(false);
  const [productInfos, setProductInfos] = useState<ProductInfoItem[]>([]);
  const [isLoadingProductInfos, setIsLoadingProductInfos] = useState(false);
  const undoTimerRef = useRef<number | null>(null);
  const isFirstViewStateSyncRef = useRef(true);
  const calendarShellRef = useRef<HTMLDivElement | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const sidebarPendingWidthRef = useRef<number | null>(null);
  const topScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [tableScrollWidth, setTableScrollWidth] = useState(0);

  const handleTopScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (tableContainerRef.current) tableContainerRef.current.scrollLeft = e.currentTarget.scrollLeft;
  };

  const handleBottomScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (topScrollContainerRef.current) topScrollContainerRef.current.scrollLeft = e.currentTarget.scrollLeft;
  };

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLightMode(document.documentElement.classList.contains('theme-light'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const weekendColorPalette = isLightMode ? YEARLY_MONTH_WEEKEND_COLORS_LIGHT : YEARLY_MONTH_WEEKEND_COLORS_DARK;

  const holidayKeySet = useMemo(
    () => new Set(holidays.filter((h) => h.is_active).map((h) => h.holiday_date)),
    [holidays],
  );

  const holidayNameByDate = useMemo(() => {
    const map = new Map<string, string>();
    holidays.forEach((h) => {
      if (h.is_active) {
        map.set(h.holiday_date, h.name || 'Resmi Tatil');
      }
    });
    return map;
  }, [holidays]);

  /** Find holidays that fall within a date range (inclusive start, exclusive end) */
  const findHolidaysInRange = useCallback((startDateStr: string, endDateStr: string): Array<{ date: string; name: string }> => {
    if (!startDateStr || !endDateStr) return [];
    const start = new Date(`${startDateStr}T00:00:00`);
    const end = new Date(`${endDateStr}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
    if (end < start) return [];

    const results: Array<{ date: string; name: string }> = [];
    const cursor = new Date(start);
    const endTime = end.getTime();
    while (cursor.getTime() <= endTime) {
      const key = dateKey(cursor);
      const name = holidayNameByDate.get(key);
      if (name) {
        results.push({ date: key, name });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return results;
  }, [holidayNameByDate]);

  /** Count weekends that fall within a date range. */
  const countWeekendsInRange = useCallback((startDateStr: string, endDateStr: string): number => {
    if (!startDateStr || !endDateStr) return 0;
    const start = new Date(`${startDateStr}T00:00:00`);
    const end = new Date(`${endDateStr}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
    if (end < start) return 0;

    let count = 0;
    const cursor = new Date(start);
    const endTime = end.getTime();
    while (cursor.getTime() <= endTime) {
      if (isWeekend(cursor)) count += 1;
      cursor.setDate(cursor.getDate() + 1);
    }
    return count;
  }, []);

  // Suppress TS unused warnings: these are kept for reference
  void findHolidaysInRange;
  void countWeekendsInRange;

  // Suppress TS unused warnings: top-level helper functions kept for reference
  void toDateInput;
  void toIsoStart;
  void toIsoEndExclusive;

  const clearUndoBanner = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoInfo(null);
    setUndoSubmitting(false);
  }, []);

  useEffect(() => {
    if (!taskIdToOpen) return;
    onTaskDoubleClicked?.(String(taskIdToOpen));
    onTaskIdHandled?.();
  }, [onTaskDoubleClicked, onTaskIdHandled, taskIdToOpen]);

  useEffect(() => {
    if (!isActive) return;
    if (isFirstViewStateSyncRef.current) {
      isFirstViewStateSyncRef.current = false;
      return;
    }
    onViewStateChanged?.();
  }, [calendarDate, isActive, onViewStateChanged, timelineMode, yearViewYear]);

  const customerOptions = useMemo(() => {
    const options = new Set<string>();
    tasks.forEach((task) => {
      const customer = String(task.customerName || '').trim();
      if (customer) {
        options.add(customer);
      }
    });
    return Array.from(options).sort((a, b) => a.localeCompare(b, 'tr'));
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const customerQuery = customerFilter.trim().toLocaleLowerCase('tr-TR');
    const activeTextFilters = taskTextFilters
      .map((filter) => ({
        field: filter.field,
        query: String(filter.query || '').trim(),
      }))
      .filter((filter) => filter.query.length > 0);
    const hasTextFilter = activeTextFilters.length > 0;
    const hasCustomerFilter = customerQuery.length > 0;

    if (!hasTextFilter && !hasCustomerFilter) return tasks;

    const matchesCustomer = (value: string) =>
      String(value || '').toLocaleLowerCase('tr-TR') === customerQuery;

    const matchesTask = (task: any) => {
      const customerValue = `${task.customerName || ''}`;

      if (hasCustomerFilter && !matchesCustomer(customerValue)) return false;

      if (!hasTextFilter) return true;
      return matchesTaskTextFilters(task, activeTextFilters);
    };

    const childrenByParent = new Map<string, any[]>();
    tasks
      .filter((task) => task.type === 'task' && task.parent)
      .forEach((task) => {
        const parentId = String(task.parent);
        const list = childrenByParent.get(parentId) || [];
        list.push(task);
        childrenByParent.set(parentId, list);
      });

    const includedTaskIds = new Set<string>();
    const includedSummaryIds = new Set<string>();

    tasks.forEach((task) => {
      if (task.type === 'summary' && matchesTask(task)) {
        includedSummaryIds.add(String(task.id));
        (childrenByParent.get(String(task.id)) || []).forEach((child) => {
          includedTaskIds.add(String(child.id));
        });
      }
      if (task.type === 'task' && matchesTask(task)) {
        includedTaskIds.add(String(task.id));
      }
    });

    tasks.forEach((task) => {
      if (task.type === 'task' && includedTaskIds.has(String(task.id)) && task.parent) {
        includedSummaryIds.add(String(task.parent));
      }
    });

    return tasks.filter((task) => {
      if (task.type === 'summary') return includedSummaryIds.has(String(task.id));
      return includedTaskIds.has(String(task.id));
    });
  }, [customerFilter, taskTextFilters, tasks]);

  const displayTasks = useMemo(() => {
    if (!renderStartOnly) return filteredTasks;

    return filteredTasks.map((task) => {
      if (task.type !== 'task') return task;
      if (!(task.start instanceof Date)) return task;

      const start = startOfDay(task.start);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);

      return {
        ...task,
        start,
        end,
        duration: 1,
      };
    });
  }, [filteredTasks, renderStartOnly]);

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

  const monthGrid = useMemo(() => buildMonthGrid(calendarDate), [calendarDate]);

  const monthTitle = useMemo(
    () =>
      new Intl.DateTimeFormat('tr-TR', {
        month: 'long',
        year: 'numeric',
      }).format(calendarDate),
    [calendarDate],
  );

  const monthLaneInfo = useMemo(() => {
    const laneByTaskId = new Map<string, number>();
    if (monthGrid.length === 0) return { laneByTaskId, laneCount: 0 };

    const gridStart = startOfDay(monthGrid[0]).getTime();
    const gridEndExclusiveDate = new Date(monthGrid[monthGrid.length - 1]);
    gridEndExclusiveDate.setDate(gridEndExclusiveDate.getDate() + 1);
    gridEndExclusiveDate.setHours(0, 0, 0, 0);
    const gridEndExclusive = gridEndExclusiveDate.getTime();

    const visibleTasks = displayTasks
      .filter((task) => task.type === 'task')
      .filter((task) => task.start instanceof Date && task.end instanceof Date)
      .map((task) => {
        const start = Math.max(startOfDay(task.start).getTime(), gridStart);
        const end = Math.min(startOfDay(task.end).getTime(), gridEndExclusive);
        return { task, start, end };
      })
      .filter((item) => item.end > item.start)
      .sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        if (a.end !== b.end) return a.end - b.end;
        return String(a.task.id).localeCompare(String(b.task.id));
      });

    type LaneItem = { task: any; start: number; end: number };
    const groups = new Map<string, { start: number; end: number; items: LaneItem[] }>();
    visibleTasks.forEach((item) => {
      const groupKey = getTaskOrderGroupKey(item.task);
      const group = groups.get(groupKey);
      if (group) {
        group.start = Math.min(group.start, item.start);
        group.end = Math.max(group.end, item.end);
        group.items.push(item);
      } else {
        groups.set(groupKey, { start: item.start, end: item.end, items: [item] });
      }
    });

    const orderedGroups = Array.from(groups.entries()).sort((a, b) => {
      if (a[1].start !== b[1].start) return a[1].start - b[1].start;
      if (a[1].end !== b[1].end) return a[1].end - b[1].end;
      return a[0].localeCompare(b[0]);
    });

    // Bar, etiket sığsın diye kendi gününün her iki yanına LABEL_BLEED_CELLS
    // hücre taşar (bkz. render). Lane ataması bunu hesaba katmazsa aynı satıra
    // düşen farklı siparişler — tarihleri çakışmasa bile — ekranda üst üste
    // biner. Önceki grubun görsel bitişi (end + taşma) ile yeninin görsel
    // başlangıcı (start - taşma) arasında boşluk kalmalı → start >= end + 2×taşma.
    const LANE_GAP_MS = 2 * LABEL_BLEED_CELLS * DAY_MS;
    // Bir satır, ancak öncekinin görsel bitişinden sonra yeniden kullanılabilir.
    const laneIsFree = (laneEnd: number | undefined, startTime: number) =>
      laneEnd === undefined || startTime >= laneEnd + LANE_GAP_MS;

    const lanesEnd: number[] = [];
    orderedGroups.forEach(([groupKey, group]) => {
      // 1) GRUP İÇİ: aynı siparişin adımları normalde tek satırda akar, ama
      //    iki ardışık adım birbirine yakınsa (ör. biri çarşamba biri cuma)
      //    3 hücrelik etiket taşmaları çakışır. Bu durumda ikinci adım grubun
      //    bir ALT satırına iner — sipariş yine bitişik bir blok olarak kalır.
      const items = [...group.items].sort((a, b) => a.start - b.start || a.end - b.end);
      const subEnds: number[] = [];
      const subLaneOf = new Map<string, number>();
      items.forEach((item) => {
        let sub = subEnds.findIndex((end) => laneIsFree(end, item.start));
        if (sub === -1) sub = subEnds.length;
        subEnds[sub] = item.end;
        subLaneOf.set(String(item.task.id), sub);
      });
      const height = Math.max(1, subEnds.length);

      // 2) Grubu `height` kadar BİTİŞİK satırdan oluşan bir blok olarak yerleştir.
      let base = 0;
      for (;;) {
        let blockedAt = -1;
        for (let i = base; i < base + height; i += 1) {
          if (!laneIsFree(lanesEnd[i], group.start)) { blockedAt = i; break; }
        }
        if (blockedAt === -1) break;
        base = blockedAt + 1;
      }
      for (let i = 0; i < height; i += 1) {
        const prev = lanesEnd[base + i];
        lanesEnd[base + i] = Math.max(prev ?? Number.NEGATIVE_INFINITY, subEnds[i] ?? group.end);
      }

      items.forEach((item) => {
        laneByTaskId.set(String(item.task.id), base + (subLaneOf.get(String(item.task.id)) ?? 0));
      });
      void groupKey;
    });

    return { laneByTaskId, laneCount: lanesEnd.length };
  }, [displayTasks, monthGrid]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    if (monthGrid.length === 0) return map;

    const gridStart = startOfDay(monthGrid[0]);
    const gridEndExclusive = new Date(monthGrid[monthGrid.length - 1]);
    gridEndExclusive.setDate(gridEndExclusive.getDate() + 1);
    gridEndExclusive.setHours(0, 0, 0, 0);

    const orderedTasks = [...displayTasks].sort(compareTasksByOrderAndStage);

    const taskOrder = new Map<string, number>();
    orderedTasks.forEach((t, i) => taskOrder.set(String(t.id), i));

    displayTasks.forEach((task) => {
      if (task.type !== 'task') return;
      if (!(task.start instanceof Date) || !(task.end instanceof Date)) return;

      const start = startOfDay(task.start);
      const endExclusive = startOfDay(task.end);
      if (endExclusive <= gridStart || start >= gridEndExclusive) return;

      const iterStart = new Date(Math.max(start.getTime(), gridStart.getTime()));
      const iterEnd = new Date(Math.min(endExclusive.getTime(), gridEndExclusive.getTime()));

      const visibleStart = iterStart.getTime();
      const visibleEnd = iterEnd.getTime() - DAY_MS;

      for (let time = iterStart.getTime(); time < iterEnd.getTime(); time += DAY_MS) {
        const day = new Date(time);
        const key = dateKey(day);
        const list = map.get(key) || [];
        const isVisibleStart = time === visibleStart;
        const isVisibleEnd = time === visibleEnd;

        const dayOfWeekMon = (day.getDay() + 6) % 7; // 0=Mon .. 6=Sun
        const isMonday = dayOfWeekMon === 0;
        const isRowStart = isVisibleStart || (isMonday && !isVisibleStart && time > visibleStart);

        let spanFromHere = 0;
        if (isRowStart) {
          const totalVisibleDays = Math.round((iterEnd.getTime() - time) / DAY_MS);
          const remainingInRow = 7 - dayOfWeekMon;
          spanFromHere = Math.min(totalVisibleDays, remainingInRow);
        }

        list.push({
          task,
          isStart: isRowStart,
          isEnd: isVisibleEnd,
          order: taskOrder.get(String(task.id)) ?? 0,
          lane: monthLaneInfo.laneByTaskId.get(String(task.id)) ?? 0,
          spanFromHere,
        });
        map.set(key, list);
      }
    });

    map.forEach((list) => {
      list.sort((a, b) => a.lane - b.lane || a.order - b.order);
    });

    return map;
  }, [displayTasks, monthGrid, monthLaneInfo.laneByTaskId]);

  // Her hafta için gerçekten çizilecek yuva (lane) sayısı. Lane indeksleri AY
  // genelinde atandığı için bir haftada 5. lane kullanılıyorsa o hücre 6 yuva
  // çizmek zorundadır — yoksa bar, satırın dışına, bir alttaki haftanın üzerine
  // taşar. Satır yüksekliği ile hücre içindeki yuva sayısı BU AYNI değerden
  // türetilir; ikisi ayrı hesaplanırsa (eskiden yükseklik "gündeki olay sayısı",
  // hücre ise "global lane sayısı" kullanıyordu) haftalar birbirine biner.
  const weekLaneCounts = useMemo(() => {
    return Array.from({ length: 6 }, (_, wi) => {
      let need = 0;
      for (let d = 0; d < 7; d += 1) {
        const day = monthGrid[wi * 7 + d];
        if (!day) continue;
        const dayEvents = eventsByDay.get(dateKey(day)) || [];
        dayEvents.forEach((e: any) => {
          const slots = (e.lane ?? 0) + 1;
          if (slots > need) need = slots;
        });
        if (dayEvents.length > need) need = dayEvents.length;
      }
      return need;
    });
  }, [eventsByDay, monthGrid]);

  const monthWeekRowStyle = useMemo(() => {
    const eventRowHeight = 20; // includes event min-height + gap
    const baseline = 70; // space for day number and padding
    const heights = weekLaneCounts.map((cnt) => `${Math.max(100, baseline + cnt * eventRowHeight)}px`);
    return { gridTemplateRows: `36px ${heights.join(' ')}` } as React.CSSProperties;
  }, [weekLaneCounts]);

  const todayKey = dateKey(new Date());

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

  const yearlyMonths = useMemo(() => {
    return Array.from({ length: 12 }, (_, monthIndex) => {
      const daysInMonth = new Date(yearViewYear, monthIndex + 1, 0).getDate();
      const monthStart = new Date(yearViewYear, monthIndex, 1);
      const monthEndExclusive = new Date(yearViewYear, monthIndex + 1, 1);
      return {
        monthIndex,
        shortLabel: YEAR_MONTHS[monthIndex],
        fullLabel: YEAR_MONTHS_LONG[monthIndex],
        daysInMonth,
        workdayCount: countWorkdaysInRange(monthStart, monthEndExclusive, holidayKeySet),
      };
    });
  }, [holidayKeySet, yearViewYear]);

  const yearlyMonthLayouts = useMemo(() => {
    return yearlyMonths.map((month) => {
      const monthStart = new Date(yearViewYear, month.monthIndex, 1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEndExclusive = new Date(yearViewYear, month.monthIndex + 1, 1);
      monthEndExclusive.setHours(0, 0, 0, 0);

      const visibleTasks = displayTasks
        .filter((task) => task.type === 'task')
        .filter((task) => task.start instanceof Date && task.end instanceof Date)
        .map((task) => {
          const start = Math.max(startOfDay(task.start).getTime(), monthStart.getTime());
          const end = Math.min(startOfDay(task.end).getTime(), monthEndExclusive.getTime());
          return { task, start, end };
        })
        .filter((item) => item.end > item.start)
        .sort((a, b) => {
          if (a.start !== b.start) return a.start - b.start;
          if (a.end !== b.end) return a.end - b.end;
          return String(a.task.id).localeCompare(String(b.task.id));
        });

      const groups = new Map<string, { start: number; end: number; tasks: any[] }>();
      visibleTasks.forEach((item) => {
        const groupKey = getTaskOrderGroupKey(item.task);
        const group = groups.get(groupKey);
        if (group) {
          group.start = Math.min(group.start, item.start);
          group.end = Math.max(group.end, item.end);
          group.tasks.push(item.task);
        } else {
          groups.set(groupKey, { start: item.start, end: item.end, tasks: [item.task] });
        }
      });

      const orderedGroups = Array.from(groups.entries()).sort((a, b) => {
        if (a[1].start !== b[1].start) return a[1].start - b[1].start;
        if (a[1].end !== b[1].end) return a[1].end - b[1].end;
        return a[0].localeCompare(b[0]);
      });

      const lanesEnd: number[] = [];
      const laneByTaskId = new Map<string, number>();
      orderedGroups.forEach(([, group]) => {
        let lane = lanesEnd.findIndex((end) => group.start >= end);
        if (lane === -1) {
          lane = lanesEnd.length;
          lanesEnd.push(group.end);
        } else {
          lanesEnd[lane] = group.end;
        }
        group.tasks.forEach((task) => laneByTaskId.set(String(task.id), lane));
      });

      const wide3dayLanesByTaskId = new Map<string, number>();
      let wide3dayMaxLaneInMonth = -1;
      {
        const monthEventsList: { task: any; day: number }[] = [];
        visibleTasks.forEach((item) => {
          for (let time = item.start; time < item.end; time += DAY_MS) {
            monthEventsList.push({ task: item.task, day: new Date(time).getDate() });
          }
        });

        monthEventsList.sort((a, b) => {
          if (a.day !== b.day) return a.day - b.day;
          const aGroup = getTaskOrderGroupKey(a.task);
          const bGroup = getTaskOrderGroupKey(b.task);
          if (aGroup !== bGroup) return aGroup.localeCompare(bGroup, 'tr');
          const aStage = getTaskStageOrder(a.task);
          const bStage = getTaskStageOrder(b.task);
          if (aStage !== bStage) return aStage - bStage;
          return String(a.task.id).localeCompare(String(b.task.id));
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
          wide3dayLanesByTaskId.set(String(item.task.id), lane);
          if (lane > wide3dayMaxLaneInMonth) wide3dayMaxLaneInMonth = lane;
        });
      }

      const entriesByDay = new Map<number, any[]>();

      visibleTasks.forEach((item, order) => {
        const visibleStart = item.start;
        const visibleEnd = item.end - DAY_MS;
        const totalSpan = Math.round((item.end - item.start) / DAY_MS);

        for (let time = item.start; time < item.end; time += DAY_MS) {
          const dayNumber = new Date(time).getDate();
          const list = entriesByDay.get(dayNumber) || [];
          list.push({
            task: item.task,
            lane: laneByTaskId.get(String(item.task.id)) ?? 0,
            isStart: time === visibleStart,
            isEnd: time === visibleEnd,
            order,
            spanFromHere: time === visibleStart ? totalSpan : 0,
          });
          entriesByDay.set(dayNumber, list);
        }
      });

      entriesByDay.forEach((list) => {
        list.sort((a, b) => a.lane - b.lane || a.order - b.order);
      });

      return {
        ...month,
        laneCount: lanesEnd.length,
        entriesByDay,
        wide3dayLanesByTaskId,
        wide3dayMaxLaneInMonth,
      };
    });
  }, [displayTasks, yearlyMonths, yearViewYear]);

  const eventColorByTaskId = useMemo(() => {
    const colorMap = new Map<string, { bg: string; fg: string }>();
    displayTasks
      .filter((task) => task.type === 'task')
      .forEach((task) => {
        const dds = task.deliveryGroupDate ? task.deliveryGroupDate.slice(0, 10) : '';
        const colorKey = `${task.orderNo || ''}|${task.productType || ''}|${dds}`;
        colorMap.set(String(task.id), getTaskColor(colorKey));
      });
    return colorMap;
  }, [displayTasks]);

  const goPrevMonth = useCallback(() => {
    setCalendarDate((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }, []);

  const goNextMonth = useCallback(() => {
    setCalendarDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }, []);

  const goPrevYear = useCallback(() => {
    setYearViewYear((prev) => prev - 1);
  }, []);

  const goNextYear = useCallback(() => {
    setYearViewYear((prev) => prev + 1);
  }, []);

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

  const startSidebarResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isSidebarCollapsed) return;
    event.preventDefault();
    setIsSidebarResizing(true);
  }, [isSidebarCollapsed]);

  const renderActiveOrdersSidebar = useCallback(() => {
    if (isSidebarCollapsed) return null;

    return (
      <>
        <aside className="calendar-sidebar" style={{ width: `${sidebarWidth}px`, contain: 'layout paint', willChange: 'width' }}>
          <div className="calendar-sidebar-header">
            <div className="calendar-sidebar-title">Aktif Siparişler</div>
            <span className="calendar-active-count">{activeOrders.length}</span>
          </div>

          <div
            ref={topScrollContainerRef}
            onScroll={handleTopScroll}
            className="active-orders-top-scrollbar"
            style={{ overflowX: 'auto', overflowY: 'hidden', flexShrink: 0 }}
            aria-hidden="true"
          >
            <div style={{ width: `${tableScrollWidth}px`, height: '1px' }} />
          </div>

          <div ref={tableContainerRef} onScroll={handleBottomScroll} style={{ overflow: 'auto', flex: 1 }}>
            <table ref={tableRef} className="active-orders-table">
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
                {activeOrders.map((order) => (
                  <tr
                    key={`active-${order.id}`}
                    className={`active-orders-row${order.isSplitChild ? ' active-orders-row--child' : ''}${order.isOrderGroupChild ? ' active-orders-row--groupchild' : ''}${order.isOrderGroupHead ? ' active-orders-row--grouphead' : ''}`}
                    title={order.isOrderGroupHead ? `Sipariş ${order.orderNo} - ${order.orderGroupSize} ürün` : (order.calendarLabel || order.text)}
                    onClick={order.isOrderGroupHead ? undefined : () => onTaskDoubleClicked?.(String(order.id))}
                  >
                    <td
                      className="active-orders-td active-orders-td--orderno"
                      data-product={order.isOrderGroupChild ? (order.productType || '—') : undefined}
                    >
                      {order.isOrderGroupChild ? null : (order.orderNo || '—')}
                    </td>
                    <td className="active-orders-td active-orders-td--product">
                      {!order.isOrderGroupChild && order.orderGroupSize && order.orderGroupSize > 1 ? (
                        <span className="active-orders-groupcount-badge">{order.orderGroupSize} ürün</span>
                      ) : (
                        order.productType || '—'
                      )}
                    </td>
                    <td className="active-orders-td active-orders-td--customer">{order.customerName || '—'}</td>
                    <td className="active-orders-td active-orders-td--qty">{order.quantity ? `${formatQuantity(order.quantity)} adet` : '—'}</td>
                    <td className="active-orders-td active-orders-td--date">{order.start.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                    <td className="active-orders-td active-orders-td--date">{order.end instanceof Date ? order.end.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          className={`calendar-splitter ${isSidebarResizing ? 'is-dragging' : ''}`}
          onMouseDown={startSidebarResize}
        />
      </>
    );
  }, [activeOrders, handleBottomScroll, handleTopScroll, isSidebarCollapsed, onTaskDoubleClicked, sidebarWidth, startSidebarResize, tableScrollWidth]);

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

  // Fetch tasks from backend
  const fetchTasks = useCallback(async (withLoading = false) => {
    try {
      console.log('[StageView] Fetching tasks...');
      if (withLoading) {
        setIsLoading(true);
      }
      const { data } = await api.get('/gantt/tasks');
      console.log('[StageView] Tasks fetched successfully:', data.tasks?.length || 0, 'tasks');
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

          const res: any = {
            id: t.id,
            text: t.text,
            rawText: t.text,
            start: startDate,
            end: endDate,
            deliveryDate: new Date(endDate.getTime() - 86400000), // 86400000 ms = 1 day
            duration: t.duration,
            type: t.type === 'project' ? 'summary' : 'task',
            progress: t.progress || 0,
            quantity: t.quantity,
            status: t.status || null,
            manual_edit: t.manual_edit,
            externalId: t.external_id,
            calendarLabel: t.text,
            chipLabel: t.text,
            productType: '',
            orderNo: '',
            quantityLabel: '',
            customerName: t.customer_name || '',
            responsiblePersonnel: t.responsible_personnel || '',
            orderDate: t.order_date || '',
            promisedDate: t.promised_date || '',
            requirementDate: t.requirement_date || '',
            penaltyDate: t.penalty_date || '',
            createdByUsername: t.created_by_username || '',
            lastInteractedByUsername: t.last_interacted_by_username || '',
            isOutsourced: t.is_outsourced ?? null,
            stage: t.stage ?? null,
            deliveryGroupDate: t.delivery_date || '',
            completion_percentage: typeof t.completion_percentage === 'number' ? t.completion_percentage : undefined,
            stage_counts: t.stage_counts || {},
            // Yeni parametreler
            supplyDays: t.supply_days ?? null,
            productionDays: t.production_days ?? null,
            outsourceDays: t.outsource_days ?? null,
            durationMode: t.duration_mode ?? null,
            productionFlatDays: t.production_flat_days ?? null,
            testFlatDays: t.test_flat_days ?? null,
            assemblyFlatDays: t.assembly_flat_days ?? null,
            is_explicit_split: t.is_explicit_split === true,
          };
          if (t.parent !== null && t.parent !== undefined) {
            res.parent = t.parent;
          }
          return res;
        })
        .filter((task: any) => task !== null);

      const splitRootsByParent = new Map<string, Set<string>>();
      parsedTasks.forEach((t: any) => {
        if (!t.parent || t.type !== 'task') return;
        const rootId = getSplitRootId(String(t.id));
        if (!rootId) return;
        const parentId = String(t.parent);
        const roots = splitRootsByParent.get(parentId) || new Set<string>();
        roots.add(rootId);
        splitRootsByParent.set(parentId, roots);
      });

      const parentsById = new Map<string, any>();
      parsedTasks.forEach((task: any) => {
        if (task.type === 'summary') {
          parentsById.set(task.id, task);
        }
      });

      const enrichedTasks = parsedTasks.map((task: any) => {
        if (task.type !== 'task') return task;

        const parent = task.parent ? parentsById.get(task.parent) : null;
        const productType = parent ? normalizeTaskText(parent.rawText || parent.text) : normalizeTaskText(task.rawText || task.text);
        const orderNo = parent?.externalId ? String(parent.externalId) : '';
        const customerName = task.customerName || parent?.customerName || '';
        const isOutsourced = task.isOutsourced ?? parent?.isOutsourced ?? null;
        const quantityText = formatQuantity(task.quantity);
        const barLabel = buildTaskBarLabel(productType, task);

        const labelParts = [
          barLabel,
          orderNo ? `Siparis ${orderNo}` : '',
          customerName ? `Müşteri ${customerName}` : '',
          quantityText ? `${quantityText} adet` : '',
        ].filter(Boolean);

        const parentTask = task.parent ? parentsById.get(String(task.parent)) : null;
        const isPartial = parentTask?.is_explicit_split || (task.parent ? (splitRootsByParent.get(String(task.parent))?.size || 0) > 1 : false);
        const partialPrefix = isPartial ? '🧩 ' : '';

        // Ana siparişin barları için parentTask kendi "proje" satırıdır ve
        // parent taşımaz. Alt ürün (BOM bileşeni) barları için parentTask
        // BİLEŞENİN proje satırıdır, o da ana siparişin proje satırını parent
        // olarak taşır — bir kademe daha yukarı çıkılır. Böylece ana sipariş ve
        // tüm alt ürünleri AYNI rootOrderId'yi paylaşır; hover'da hepsi birlikte
        // vurgulanır (bkz. DeliveryCalendarPage.tsx'teki aynı hesap).
        const rootOrderId = parentTask?.parent
          ? String(parentTask.parent)
          : (task.parent ? String(task.parent) : String(task.id));
        const isSubProduct = !!parentTask?.parent;

        return {
          ...task,
          text: partialPrefix + barLabel,
          status: task.status || parent?.status || null,
          calendarLabel: partialPrefix + (labelParts.join(' | ') || normalizeTaskText(task.text) || task.text),
          chipLabel: partialPrefix + (barLabel || productType || normalizeTaskText(task.text) || task.text),
          productType,
          orderNo,
          customerName,
          isOutsourced,
          completion_percentage: task.completion_percentage ?? parent?.completion_percentage ?? 0,
          stage_counts: task.stage_counts && Object.keys(task.stage_counts).length > 0
            ? task.stage_counts
            : (parent?.stage_counts || {}),
          quantityLabel: quantityText ? `${quantityText} adet` : '',
          isPartial,
          rootOrderId,
          isSubProduct,
        };
      });

      // Set tasks immediately so UI renders quickly; then fetch manual-step
      // states in background and update labels for checked stages.
      console.log('[StageView] Setting tasks state with', enrichedTasks.length, 'tasks');
      setTasks(enrichedTasks);

      (async () => {
        const formatErr = (e: unknown) => (e instanceof Error ? e.message : String(e));
        try {
          const scopeIds: string[] = Array.from(
            new Set<string>(
              enrichedTasks
                .filter((t: any) => t.stage)
                .map((t: any) => getManualStepScopeIdForTask(String(t.id), t.parent)),
            ),
          );
          const manualStepsByScope = new Map<string, any>();

          await Promise.all(
            scopeIds.map(async (scopeId) => {
              try {
                const { data } = await api.get(`/gantt/tasks/${scopeId}/manual-steps`);
                manualStepsByScope.set(scopeId, data?.steps || {});
              } catch (e) {
                // log and continue
                // eslint-disable-next-line no-console
                console.warn('manual-steps fetch failed for', scopeId, formatErr(e));
              }
            }),
          );

          const updated = enrichedTasks.map((task: any) => {
            try {
              if (task.stage) {
                const scopeId = getManualStepScopeIdForTask(String(task.id), task.parent);
                const steps = manualStepsByScope.get(scopeId) || {};
                const stepMeta = steps[task.stage] || {};
                if (stepMeta.checked) {
                  const prefix = '✅ ';
                  const cleanChip = String(task.chipLabel || task.text || '').replace(/^✅\s*/, '');
                  const cleanText = String(task.text || '').replace(/^✅\s*/, '');
                  return { ...task, chipLabel: `${prefix}${cleanChip}`, text: `${prefix}${cleanText}` };
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
      const msg = err instanceof Error ? err.message : 'Görevler yüklenemedi';
      console.error('[StageView] fetchTasks error:', msg);
      setError(msg);
    } finally {
      if (withLoading) {
        setIsLoading(false);
      }
    }
  }, [holidayKeySet]);

  const handleUndoDelete = useCallback(async () => {
    if (!undoInfo || undoSubmitting) return;

    setUndoSubmitting(true);
    try {
      await api.post(`/gantt/tasks/${undoInfo.taskId}/restore`);
      await fetchTasks();
      clearUndoBanner();
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Geri alma basarisiz oldu.');
      setUndoSubmitting(false);
    }
  }, [clearUndoBanner, fetchTasks, undoInfo, undoSubmitting]);

  useEffect(() => {
    fetchHolidays();
    fetchProductInfos();
  }, [fetchHolidays, fetchProductInfos]);

  useEffect(() => {
    if (!holidaysLoaded) return;
    fetchTasks(true);
  }, [fetchTasks, holidaysLoaded]);

  useEffect(() => {
    loadSavedFilters();
  }, [loadSavedFilters]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
      }
    };
  }, []);

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
    try {
      window.localStorage.setItem(TIMELINE_MODE_STORAGE_KEY, timelineMode);
    } catch {
      // Ignore storage failures (e.g., private mode/storage restrictions)
    }
  }, [timelineMode]);

  // SSE: Listen for real-time updates from other users
  useEffect(() => {
    tasksRef.current = tasks;

    // Track recent local parent updates to avoid reacting to server SSE that echoes
    // our own change and causing a full reload flicker. Map parentId -> timestamp(ms).
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
      // Delay slightly to ensure server state is updated
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
          // Check for recent local updates to avoid reacting to our own changes
          for (const ts of recentLocalParentUpdates.values()) {
            if (now - ts < 2000) {
              hasRecentLocal = true;
              break;
            }
          }
          if (!hasRecentLocal) {
            console.log('[SSE] Fetching tasks (no recent local updates)');
            fetchTasks();
          } else {
            console.log('[SSE] Skipping fetch (recent local update detected)');
            // cleanup old entries
            for (const [k, v] of Array.from(recentLocalParentUpdates.entries())) {
              if (now - v > 5000) recentLocalParentUpdates.delete(k);
            }
          }
        } catch (err) {
          console.error('[SSE] Error in TASK_UPDATED handler:', err);
          fetchTasks();
        }
      }, 250);
    });

    eventSource.addEventListener('TASK_SPLIT', (event) => {
      console.log('[SSE] Task split:', event.data);
      fetchTasks();
    });

    eventSource.addEventListener('TASK_CREATED', () => fetchTasks());
    eventSource.addEventListener('TASK_DELETED', () => fetchTasks());
    // Tatil listesi eskiden sayfa açılışında bir kez yükleyip cache'leniyordu —
    // backend artık her tatil değişikliğinde bu event'i yayınlıyor (bkz. holidays.py).
    eventSource.addEventListener('HOLIDAY_UPDATED', () => fetchHolidays());

    // scopeId is either "split_<uuid>" (one independent delivery split) or
    // "order_<uuid>" (whole order, for tasks without an explicit split).
    const matchTaskForScope = (scopeId: string) => {
      const rootId = getSplitRootId(scopeId);
      if (rootId) {
        return (task: any) => Boolean(task.stage) && getSplitRootId(String(task.id)) === rootId;
      }
      return (task: any) => Boolean(task.stage) && Boolean(task.parent) && String(task.parent) === scopeId;
    };

    const fetchManualStepsForScope = async (scopeId: string, matchTask: (task: any) => boolean) => {
      try {
        const { data } = await api.get(`/gantt/tasks/${scopeId}/manual-steps`);
        const steps = data?.steps || {};
        const completedCount = Number(data?.completed_count || 0);
        const totalCount = Number(data?.total_count || 0);
        const resolvedStatus = totalCount > 0 && completedCount === totalCount
          ? 'COMPLETED'
          : completedCount > 0
            ? 'APPROVED'
            : 'PENDING';
        // apply to current tasks belonging to this exact scope only
        setTasks((prev) =>
          prev.map((task) => {
            if (!matchTask(task)) return task;
            const stepMeta = steps[task.stage] || {};
            const prefix = stepMeta.checked ? '✅ ' : '';
            const cleanChip = String(task.chipLabel || task.text || '').replace(/^✅\s*/, '');
            const cleanText = String(task.text || '').replace(/^✅\s*/, '');
            return { ...task, chipLabel: `${prefix}${cleanChip}`, text: `${prefix}${cleanText}`, status: resolvedStatus };
          }),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('manual-steps fetch failed for scope', scopeId, err);
      }
    };

    const handleStatusChange = (ev: Event) => {
      try {
        const detail = (ev as CustomEvent)?.detail;
        const orderId = detail?.orderId;
        const splitId = detail?.splitId as string | null | undefined;
        const parentIdFromDetail = detail?.parentId;

        // A specific delivery split changed — only update that split's own bars.
        if (splitId) {
          recentLocalParentUpdates.set(String(splitId), Date.now());
          void fetchManualStepsForScope(String(splitId), matchTaskForScope(String(splitId)));
          return;
        }

        // Whole-order change (no explicit split) — the emitter provided its parentId.
        if (parentIdFromDetail) {
          const pid = String(parentIdFromDetail);
          recentLocalParentUpdates.set(pid, Date.now());
          void fetchManualStepsForScope(pid, matchTaskForScope(pid));
          return;
        }

        if (!orderId) {
          fetchTasks();
          return;
        }

        const currentTasks = tasksRef.current || [];

        // Prefer finding the summary (parent) task by externalId or id
        const summary = currentTasks.find((t) =>
          t.type === 'summary' && (String(t.externalId) === String(orderId) || String(t.id) === String(orderId) || String(t.id) === `order_${orderId}`),
        );

        if (summary && summary.id) {
          void fetchManualStepsForScope(String(summary.id), matchTaskForScope(String(summary.id)));
          return;
        }

        // Fallback: find any task whose parent matches common formats
        const match = currentTasks.find((t) => {
          const parent = String(t.parent || '');
          if (!parent) return false;
          if (parent === String(orderId)) return true;
          if (parent === `order_${orderId}`) return true;
          if (parent.endsWith(`_${orderId}`)) return true;
          return false;
        });

        if (match && match.parent) {
          void fetchManualStepsForScope(String(match.parent), matchTaskForScope(String(match.parent)));
        } else {
          fetchTasks();
        }
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

  /* Özet ve Hiyerarşik Gantt ile BİREBİR aynı header bileşeni
     (bkz. CalendarHeader) — görünüm değişince yeri/yüksekliği oynamasın diye.
     Yükleniyor/hata dallarının da ÜSTÜNDE render edilir. */
  const header = (
    <CalendarHeader
      sidebar={{ collapsed: isSidebarCollapsed, onToggle: toggleSidebarCollapse }}
      onPrev={timelineMode === 'monthly' ? goPrevMonth : goPrevYear}
      onNext={timelineMode === 'monthly' ? goNextMonth : goNextYear}
      prevAriaLabel={timelineMode === 'monthly' ? 'Önceki ay' : 'Önceki yıl'}
      nextAriaLabel={timelineMode === 'monthly' ? 'Sonraki ay' : 'Sonraki yıl'}
      title={timelineMode === 'monthly' ? monthTitle : yearViewYear}
      controls={headerExtra}
      onCreateDelivery={
        (user?.role === 'ADMIN' || user?.role === 'PLANNER')
          ? () => setIsCreateModalOpen(true)
          : undefined
      }
    />
  );

  if (isLoading) {
    return (
      <div className="h-full flex flex-col relative w-full bg-surface-900 overflow-hidden">
        {header}
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <svg className="animate-spin h-10 w-10 text-primary-500" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <p className="text-surface-400 text-sm">Stage verisi yükleniyor...</p>
          </div>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full flex flex-col relative w-full bg-surface-900 overflow-hidden">
        {header}
        <div className="flex-1 min-h-0 flex items-center justify-center">
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
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col relative w-full bg-surface-900 overflow-hidden">

      {!isFilterPanelCollapsed && (
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
                  <button
                    type="button"
                    onClick={addTaskTextFilterRow}
                    title="Satir ekle"
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-700/50 hover:bg-primary-600/30 border border-surface-600/50 hover:border-primary-500/50 text-surface-300 hover:text-primary-300 text-base font-bold transition-all flex items-center justify-center"
                  >+</button>
                  <button
                    type="button"
                    onClick={() => removeTaskTextFilterRow(index)}
                    disabled={taskTextFilters.length <= 1}
                    title="Satiri kaldir"
                    className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-700/50 hover:bg-red-600/20 border border-surface-600/50 hover:border-red-500/50 text-surface-400 hover:text-red-400 text-sm font-bold transition-all flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
                  >✕</button>
                </div>
              ))}
            </div>

            {/* Alt satır: müşteri + temizle + kayıtlı filtreler */}
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-surface-700/40">
              {/* Müşteri filtresi */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-surface-500 uppercase tracking-widest whitespace-nowrap">Müşteri</span>
                <select
                  className="input-field !py-2 !text-sm w-48"
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
                >
                  <option value="">Tümü</option>
                  {customerOptions.map((customer) => (
                    <option key={customer} value={customer}>{customer}</option>
                  ))}
                </select>
              </div>

              <div className="w-px h-5 bg-surface-700/60 hidden sm:block" />

              {/* Kayıtlı filtreler */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-surface-500 uppercase tracking-widest whitespace-nowrap">Kayıtlı</span>
                <select
                  className="input-field !py-2 !text-sm w-48"
                  value={selectedSavedFilterId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedSavedFilterId(id);
                    const saved = savedFilters.find((item) => String(item.id) === id);
                    if (saved) applySavedFilter(saved);
                  }}
                  disabled={isLoadingSavedFilters}
                >
                  <option value="">Filtre seç...</option>
                  {savedFilters.map((saved) => (
                    <option key={saved.id} value={String(saved.id)}>
                      {saved.name}{saved.created_by_username ? ` (${saved.created_by_username})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleDeleteSavedFilter}
                  disabled={!selectedSavedFilterId}
                  className="flex-shrink-0 h-8 px-3 rounded-lg bg-surface-700/50 hover:bg-red-600/20 border border-surface-600/50 hover:border-red-500/50 text-surface-400 hover:text-red-400 text-xs font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >Sil</button>
              </div>

              <div className="w-px h-5 bg-surface-700/60 hidden sm:block" />

              {/* Kaydet */}
              <div className="flex items-center gap-2">
                <input
                  className="input-field !py-2 !text-sm w-40"
                  placeholder="Filtre adı..."
                  value={newSavedFilterName}
                  onChange={(e) => setNewSavedFilterName(e.target.value)}
                />
                <button
                  type="button"
                  onClick={handleSaveCurrentFilter}
                  disabled={isSavingFilter}
                  className="flex-shrink-0 h-8 px-3 rounded-lg bg-primary-600/20 hover:bg-primary-600/40 border border-primary-500/30 hover:border-primary-500/60 text-primary-300 text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {isSavingFilter ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
              </div>

              <div className="ml-auto">
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="h-8 px-3 rounded-lg bg-surface-700/30 hover:bg-surface-700/60 border border-surface-600/30 text-surface-400 hover:text-surface-200 text-xs font-medium transition-all"
                >
                  Temizle
                </button>
              </div>
            </div>

            {savedFilterError && (
              <p className="text-xs text-red-400 text-right -mt-1">{savedFilterError}</p>
            )}
          </div>
        </div>
      )}

      {header}

      {/* Stage View Wrapper */}
      <div className="flex-1 min-h-0 w-full relative">
        {timelineMode === 'monthly' ? (
          <div
            ref={calendarShellRef}
            className={`absolute inset-0 rounded-t-xl overflow-hidden calendar-shell ${isSidebarCollapsed ? 'is-collapsed' : ''}`}
            style={{ gridTemplateColumns: isSidebarCollapsed ? '1fr' : `${sidebarWidth}px 8px 1fr` }}
          >
            {renderActiveOrdersSidebar()}

            <section className="calendar-main">
              {/* Header yukarıda, kabuğun DIŞINDA — tüm görünümlerde aynı yerde. */}
              {
                <>
                  {
                    /* compute per-week heights so each week grows with its event count */
                  }
                  <div
                    className="calendar-grid"
                    style={{
                      ...monthWeekRowStyle,
                      gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
                    }}
                  >
                    {WEEK_DAYS.map((d) => (
                      <div key={`weekday-${d}`} className="calendar-weekday">{d}</div>
                    ))}

                    {monthGrid.map((day, gridIndex) => {
                      const key = dateKey(day);
                      const isToday = key === todayKey;
                      const inMonth = day.getMonth() === calendarDate.getMonth();
                      const isHoliday = holidayKeySet.has(key);
                      const isWeekendDay = isWeekend(day);
                      const isOffDay = isHoliday || isWeekendDay;
                      const holidayName = holidayNameByDate.get(key);
                      const dayTasks = eventsByDay.get(key) || [];
                      // Satır yüksekliğiyle AYNI kaynaktan — bkz. weekLaneCounts.
                      const visibleLaneCount = weekLaneCounts[Math.floor(gridIndex / 7)] ?? dayTasks.length;
                      const taskByLane = new Map<number, any>();
                      dayTasks.forEach((entry) => {
                        if (!taskByLane.has(entry.lane)) {
                          taskByLane.set(entry.lane, entry);
                        }
                      });
                      return (
                        <div
                          key={key}
                          className={`calendar-day ${inMonth ? '' : 'is-out'} ${isOffDay ? 'is-offday' : ''} ${isToday ? 'is-today' : ''}`}
                          title={buildDayTooltip(day, isToday, isHoliday, isWeekendDay, holidayName, dayTasks)}
                        >
                          <div className={`calendar-day-number ${isToday ? 'is-today' : ''}`}>{day.getDate()}</div>
                          <div className="calendar-day-events">
                            {Array.from({ length: visibleLaneCount }).map((_, laneIndex) => {
                              const entry = taskByLane.get(laneIndex);
                              if (!entry) {
                                return <div key={`${key}-placeholder-${laneIndex}`} className="calendar-event-placeholder" />;
                              }

                              // Bar yalnızca başladığı hücrede çizilir; devam günleri
                              // yer tutucu bırakır (satır hizası korunsun diye).
                              if (!entry.isStart) {
                                return <div key={`${key}-cont-${laneIndex}`} className="calendar-event-placeholder" />;
                              }
                              // Bu görünümde her adım TEK bir güne düşer; chip'in
                              // kendi gününden fazla genişliği SÜREYİ değil, yalnızca
                              // ETİKET yerini sağlar (dar bir hücreye
                              // "ANT-4220-P2 - Fason (Dış Dizgi)" sığmıyor).
                              // Bar kendi gününde ORTALANIR: bir hücre sola, bir hücre
                              // sağa taşar (3 hücre). Izgaranın kenarındaki günlerde
                              // (pazartesi/pazar) dışarı taşmak yerine kırpılır, yani
                              // 2 hücre olur — eskiden pazartesi barları ızgara dışına
                              // çıkıp etiketleri görünmez oluyordu.
                              const col = gridIndex % 7; // 0 = Pazartesi ... 6 = Pazar
                              const ownCells = Math.max(1, entry.spanFromHere || 1);
                              const bleedLeft = Math.min(LABEL_BLEED_CELLS, col);
                              const bleedRight = Math.min(LABEL_BLEED_CELLS, 6 - (col + ownCells - 1));
                              const span = bleedLeft + ownCells + bleedRight;

                              const isPanelHighlighted = !!highlightScopeId && getHighlightScopeId(String(entry.task.id)) === highlightScopeId;
                              const isGroupHighlighted = isPanelHighlighted
                                || (!!entry.task.rootOrderId && entry.task.rootOrderId === hoveredRootOrderId);
                              const groupHighlightClass = isGroupHighlighted
                                ? (entry.task.isSubProduct ? 'is-group-highlighted-component' : 'is-group-highlighted-main')
                                : '';

                              return (
                                <div
                                  key={`${key}-${entry.task.id}`}
                                  className={`delivery-calendar-chip flex items-center ${groupHighlightClass}`}
                                  title={entry.task.calendarLabel || entry.task.text}
                                  onClick={() => onTaskDoubleClicked?.(String(entry.task.id))}
                                  onMouseEnter={() => setHoveredRootOrderId(entry.task.rootOrderId || null)}
                                  onMouseLeave={() => setHoveredRootOrderId(null)}
                                  style={{
                                    backgroundColor: eventColorByTaskId.get(String(entry.task.id))?.bg,
                                    color: eventColorByTaskId.get(String(entry.task.id))?.fg,
                                    // Kapsadığı hücre sayısı + aradaki 1px'lik boşluklar.
                                    width: `calc(${span * 100}% + ${span - 1}px)`,
                                    marginLeft: bleedLeft > 0 ? `calc(${-bleedLeft * 100}% - ${bleedLeft}px)` : 0,
                                    position: 'relative' as const,
                                    zIndex: 4,
                                  }}
                                >
                                      {entry.isStart && (
                                        <div className="flex items-center gap-1 overflow-hidden">
                                          <span className="truncate">{entry.task.chipLabel || entry.task.calendarLabel || entry.task.text}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              }
            </section>
          </div>
        ) : timelineMode === 'yearly' ? (
          <div className="absolute inset-0 rounded-t-xl overflow-hidden yearly-shell">
            {/* Yıllık görünümün kendi header'ı yok — yukarıdaki ortak
                CalendarHeader Aylık ile birebir aynısını kullanır. */}
              <div
                ref={calendarShellRef}
                className={`flex-1 relative calendar-shell ${isSidebarCollapsed ? 'is-collapsed' : ''}`}
                style={{ gridTemplateColumns: isSidebarCollapsed ? '1fr' : `${sidebarWidth}px 8px 1fr` }}
              >
                {renderActiveOrdersSidebar()}
                <section className="calendar-main overflow-auto">
                  <div className="yearly-planner-grid">
                    <div className="yearly-planner-head-label">Ay</div>
                    <div className="yearly-planner-head-days">
                      {Array.from({ length: YEARLY_PLANNER_COLS }, (_, dayIdx) => (
                        <div key={`head-day-${dayIdx + 1}`} className="yearly-planner-head-day">{dayIdx + 1}</div>
                      ))}
                    </div>

                    {yearlyMonthLayouts.map((month) => {
                      // Dynamic row height: header area ~26px + each lane 18px (16px chip + 2px margin)
                      const laneCount = Math.max(1, (month.wide3dayMaxLaneInMonth ?? -1) + 1);
                      const HEADER_PX = 26;
                      const EVENTS_TOP_PX = 6;
                      const LANE_PX = 22;
                      const dynamicMinHeight = HEADER_PX + EVENTS_TOP_PX + laneCount * LANE_PX + 4;
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
                                return <div key={`empty-${month.monthIndex}-${colIdx + 1}`} className="yearly-planner-cell is-empty" style={rowStyle} />;
                              }

                              const cellDate = new Date(yearViewYear, month.monthIndex, dayNumber);
                              const weekDayLabel = WEEK_DAYS[(cellDate.getDay() + 6) % 7];
                              const key = dateKey(cellDate);
                              const isToday = key === todayKey;
                              const isHoliday = holidayKeySet.has(key);
                              const isWeekendDay = isWeekend(cellDate);
                              const holidayName = holidayNameByDate.get(key);
                              const dayEntries = month.entriesByDay.get(dayNumber) || [];
                              const entryByLane = new Map<number, any>();
                              dayEntries.forEach((entry) => {
                                if (!entryByLane.has(entry.lane)) {
                                  entryByLane.set(entry.lane, entry);
                                }
                              });

                              const weekendBg = isWeekendDay ? { backgroundColor: weekendColorPalette[month.monthIndex] } : {};
                              const cellStyle = { ...rowStyle, ...weekendBg };

                              return (
                                <div
                                  key={`cell-${month.monthIndex}-${dayNumber}`}
                                  className={`yearly-planner-cell ${isWeekendDay ? 'is-weekend' : ''} ${isHoliday ? 'is-holiday' : ''} ${isToday ? 'is-today' : ''}`}
                                  title={buildDayTooltip(cellDate, isToday, isHoliday, isWeekendDay, holidayName, dayEntries)}
                                  style={cellStyle}
                                >
                                  <span className="yearly-planner-cell-day">{dayNumber}</span>
                                  <span className="yearly-planner-cell-weekday">{weekDayLabel}</span>
                                  <div className="yearly-planner-cell-events">
                                    {Array.from({ length: laneCount }).map((_, laneIndex) => {
                                      const entry = entryByLane.get(laneIndex);
                                      if (!entry) {
                                        return <div key={`${month.monthIndex}-${dayNumber}-placeholder-${laneIndex}`} className="yearly-planner-event-placeholder" />;
                                      }

                                      const color = eventColorByTaskId.get(String(entry.task.id));
                                      const isWide3Day = true;
                                      const isFirstDay = dayNumber === 1;
                                      const isLastDay = dayNumber === month.daysInMonth;
                                      const w3Lane = month.wide3dayLanesByTaskId?.get(String(entry.task.id)) ?? 0;
                                      const isPanelHighlighted = !!highlightScopeId && getHighlightScopeId(String(entry.task.id)) === highlightScopeId;
                                      const isGroupHighlighted = isPanelHighlighted
                                        || (!!entry.task.rootOrderId && entry.task.rootOrderId === hoveredRootOrderId);
                                      const groupHighlightClass = isGroupHighlighted
                                        ? (entry.task.isSubProduct ? 'is-group-highlighted-component' : 'is-group-highlighted-main')
                                        : '';
                                      return (
                                        <span
                                          key={`${month.monthIndex}-${dayNumber}-${entry.task.id}`}
                                          className={`delivery-calendar-yearly-chip flex items-center ${isToday ? 'is-today' : ''} ${groupHighlightClass}`}
                                          onMouseEnter={() => setHoveredRootOrderId(entry.task.rootOrderId || null)}
                                          onMouseLeave={() => setHoveredRootOrderId(null)}
                                          style={{
                                            backgroundColor: color?.bg,
                                            color: color?.fg,
                                            ...(isWide3Day ? {
                                              position: 'absolute',
                                              width: isFirstDay && isLastDay ? '100%'
                                                : isFirstDay || isLastDay ? 'calc(200% + 1px)'
                                                : 'calc(300% + 2px)',
                                              marginLeft: isFirstDay ? '0' : 'calc(-100% - 1px)',
                                              top: `${w3Lane * 22}px`,
                                              height: '18px',
                                              zIndex: 50,
                                            } : {}),
                                          }}
                                          title={entry.task.calendarLabel || entry.task.text}
                                          onClick={() => onTaskDoubleClicked?.(String(entry.task.id))}
                                        >
                                          {entry.isStart ? (
                                            <div className="flex items-center gap-0.5 overflow-hidden">
                                              <span className="truncate">{entry.task.chipLabel || entry.task.calendarLabel || entry.task.text}</span>
                                            </div>
                                          ) : '\u00A0'}
                                        </span>
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
                </section>
              </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <svg className="w-16 h-16 text-surface-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2m0-10a2 2 0 012 2v10a2 2 0 01-2 2h-2a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
              </svg>
              <p className="text-surface-500 text-lg font-medium">Henüz görev yok</p>
              <p className="text-surface-600 text-sm mt-1">
                Excel dosyası yükleyerek siparişleri içe aktarın
              </p>
            </div>
          </div>
        )}
      </div>

      {undoInfo && (
        <div className="absolute bottom-5 right-5 z-[120] rounded-xl border border-amber-400/40 bg-surface-900/95 px-4 py-3 shadow-xl backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="text-sm text-surface-100">{undoInfo.label} silindi.</div>
            <button
              type="button"
              className="btn-ghost py-1.5 px-3 text-sm"
              onClick={handleUndoDelete}
              disabled={undoSubmitting}
            >
              {undoSubmitting ? 'Geri aliniyor...' : 'Geri Al'}
            </button>
            <button
              type="button"
              className="text-surface-400 hover:text-surface-100 text-sm"
              onClick={clearUndoBanner}
              aria-label="Kapat"
            >
              x
            </button>
          </div>
        </div>
      )}

      {isAdvancedCreateModalOpen && (
        <CreateDeliveryModal
          productInfos={productInfos}
          isLoadingProductInfos={isLoadingProductInfos}
          holidayKeySet={holidayKeySet}
          onClose={() => setIsAdvancedCreateModalOpen(false)}
          onCreated={() => fetchTasks(true)}
          onProductCreated={() => void fetchProductInfos()}
        />
      )}
      {isCreateModalOpen && (
        <QuickAddDeliveryWizard
          productInfos={productInfos}
          isLoadingProductInfos={isLoadingProductInfos}
          holidayKeySet={holidayKeySet}
          onClose={() => setIsCreateModalOpen(false)}
          // BİLEREK fetchTasks(false) — (true) tam sayfa yükleme spinner'ını
          // (bkz. "if (isLoading) return ..." early-return) tetikleyip hâlâ
          // AÇIK olan wizard'ı (başarı sonrası "Tamamlandı" adımını göstermek
          // için kasıtlı olarak kapanmıyor) unmount edip 1. adıma resetlerdi.
          onCreated={() => fetchTasks(false)}
          onOpenAdvanced={() => {
            setIsCreateModalOpen(false);
            setIsAdvancedCreateModalOpen(true);
          }}
          onEditRequested={(taskId) => onEditRequested?.(taskId)}
        />
      )}
    </div>
  );
}
