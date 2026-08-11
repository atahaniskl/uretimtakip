import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { toast } from 'react-hot-toast';
import { computeNativeBlockDays, type ScheduleParams, type EmployeeCounts } from '../lib/scheduleMath';
import { startOfDay, isWorkday } from '../lib/dateUtils';
import { STAGE_LABELS } from '../lib/stageLabels';
import OrderDetailModal from './OrderDetailModal';
import {
  CORE_COLUMNS,
  BASE_DATA_COLUMN_KEYS,
  READ_ONLY_COLUMN_KEYS,
  type OrderGroup,
  type OrderDetailRow,
  type Column,
  type InputType,
} from '../pages/OrderDetailsPage';


const DAY_MS = 86400000;

const MANUAL_STEP_DEFS = [
  { key: 'supply', label: 'Tedarik' },
  { key: 'assembly', label: 'Dizgi' },
  { key: 'production', label: 'Üretim' },
  { key: 'test', label: 'Test' },
  { key: 'delivery', label: 'Teslimat' },
] as const;

type ManualStepKey = (typeof MANUAL_STEP_DEFS)[number]['key'];

type ManualStepMeta = {
  checked: boolean;
  checked_by?: string | null;
  checked_by_username?: string | null;
  checked_at?: string | null;
};

type ManualStepState = Record<ManualStepKey, ManualStepMeta>;

const buildDefaultManualStepState = () =>
  MANUAL_STEP_DEFS.reduce((acc, step) => {
    acc[step.key] = { checked: false, checked_by: null, checked_by_username: null, checked_at: null };
    return acc;
  }, {} as ManualStepState);

const formatManualStepTimestamp = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};


const MANUAL_STAGE_ORDER = ['supply', 'assembly', 'production', 'test', 'delivery'] as const;

// Aşama zaman çizelgesi için etiket + renk (nokta/çizgi). Tailwind sınıfları.
const STAGE_TIMELINE_META: Record<string, { label: string; dot: string }> = {
  supply: { label: 'Tedarik', dot: 'bg-sky-400' },
  assembly: { label: 'Dizgi', dot: 'bg-violet-400' },
  production: { label: 'Üretim', dot: 'bg-amber-400' },
  test: { label: 'Test', dot: 'bg-pink-400' },
  delivery: { label: 'Teslimat', dot: 'bg-emerald-400' },
};

const formatDM = (d: Date | null) => d ? d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }) : '—';
const formatDMY = (d: Date | null) => d ? d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

const getManualStageProgress = (stageKey: string, stageCounts?: Record<string, number> | null) => {
  const counts = stageCounts ?? {};
  const total = Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0);
  if (total <= 0) return { completed: 0, total: 0 };

  const stageIndex = MANUAL_STAGE_ORDER.indexOf(stageKey as (typeof MANUAL_STAGE_ORDER)[number]);
  if (stageIndex < 0) return { completed: 0, total };

  const remainingCurrentAndBefore = MANUAL_STAGE_ORDER.slice(0, stageIndex + 1).reduce(
    (sum, stage) => sum + (Number(counts[stage]) || 0),
    0,
  );

  return {
    completed: Math.max(0, total - remainingCurrentAndBefore),
    total,
  };
};

const getStageLabel = (task: any) => {
  const stage = String(task?.stage || '').trim().toLowerCase();
  if (!stage) return '';
  return STAGE_LABELS[stage] || stage;
};


const getOrderIdFromTask = (task: any) => {
  const taskId = String(task?.id || '');
  if (taskId.startsWith('order_')) return taskId.replace('order_', '');
  if (taskId.startsWith('split_fake_')) return taskId.replace('split_fake_', '');

  const parentId = String(task?.parent || '');
  if (parentId.startsWith('order_')) return parentId.replace('order_', '');

  return null;
};

const isStageTaskId = (id: string): boolean => {
  if (!id.startsWith('split_') || id.startsWith('split_fake_')) return false;
  const parts = id.split('_');
  return parts.length > 2;
};

const getParentSplitId = (id: string): string => {
  const parts = id.split('_');
  return `split_${parts[1]}`;
};

const getSplitRootId = (task: any) => {
  const taskId = String(task?.id || '');
  if (!taskId.startsWith('split_') || taskId.startsWith('split_fake_')) return null;
  const raw = taskId.slice('split_'.length);
  const parts = raw.split('_');
  return parts[0] || null;
};

// Manuel adım takibi artık her parçalı teslimat (split) için ayrı tutuluyor.
// Bir split'in aşama alt-bar'ları (split_<uuid>_production gibi) hep aynı split'in
// kök id'sine ("split_<uuid>") normalize edilir ki hangi aşama bar'ına tıklanırsa
// tıklansın aynı teslimatın durumu okunup yazılsın.
const getManualStepScopeId = (task: any): string | null => {
  const taskId = String(task?.id || '');
  if (!taskId) return null;
  return isStageTaskId(taskId) ? getParentSplitId(taskId) : taskId;
};


// Backend date_utils._block_days'in gerçek aynası scheduleMath.ts'e devredilir —
// böylece bu tahmin, OrderDetailModal'ın canlı önizlemesi ve backend'in kendisiyle
// AYNI formülü kullanır. Eskiden burada elle tutulan ayrı bir kopya vardı ve iki
// hataya yol açıyordu: (1) fason (dış dizgi) süresi artık kullanılmayan
// `outsourceDays` alanından okunuyordu (gerçek değer `productionDays`'te), (2)
// "İş Günü (Toplam)" modu (duration_mode='flat') hiç hesaba katılmıyordu.
const calcTotalRequiredDays = (task: any, qty: number): number => {
  const q = Math.max(1, qty || 1);
  const workMinutes = (task.workHoursPerDay ?? 8) * 60;
  const emp: EmployeeCounts = {
    assembly: Math.max(1, task.assemblyEmployees ?? 1),
    production: Math.max(1, task.productionEmployees ?? 1),
    test: Math.max(1, task.testEmployees ?? 1),
  };
  const params: ScheduleParams = {
    supply_days: task.supplyDays ?? null,
    // GanttTaskOut.productionDays, backend'in aynı `production_days || assembly_days`
    // önceliğiyle zaten birleştirdiği etkin Dizgi süresidir (bkz. gantt.py
    // _build_product_params) — fason siparişlerde de geçerli olan asıl değer budur;
    // ayrı `outsourceDays` alanı artık backend hesabında hiç kullanılmıyor.
    assembly_days: task.productionDays ?? null,
    quality_minutes: task.qualityMinutes ?? null,
    epoxy_minutes: task.epoxyMinutes ?? null,
    conformal_minutes: task.conformalMinutes ?? null,
    montaj_minutes: task.montajMinutes ?? null,
    montaj_kalite_minutes: task.montajKaliteMinutes ?? null,
    test1_minutes: task.test1Minutes ?? null,
    test2_minutes: task.test2Minutes ?? null,
    final_test_minutes: task.finalTestMinutes ?? null,
    delivery_days: task.deliveryDays ?? null,
    duration_mode: task.durationMode === 'flat' ? 'flat' : 'per_unit',
    production_flat_days: task.productionFlatDays ?? null,
    test_flat_days: task.testFlatDays ?? null,
    assembly_flat_days: task.assemblyFlatDays ?? null,
  };
  const days = computeNativeBlockDays(params, q, emp, workMinutes, Boolean(task.isOutsourced));
  const total = Object.values(days).reduce((sum: number, d) => sum + (d || 0), 0);
  return Math.max(1, total);
};

const subtractBusinessDays = (end: Date, workdays: number, holidayKeys: Set<string>) => {
  let remaining = Math.max(1, workdays);
  const cursor = startOfDay(new Date(end));
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() - 1);
    if (isWorkday(cursor, holidayKeys)) remaining -= 1;
  }
  return cursor;
};

export default function RightPanel({
  mode,
  taskId,
  dayDate,
  dayEvents,
  panelWidth = 360,
  isResizing = false,
  isSwitching = false,
  onClose,
  onUpdate,
  onTaskStatusChanged,
  onSelectTask,
  tasks,
  holidays,
  isOverview = false,
  autoEditTaskId = null,
}: {
  mode: 'task' | 'day' | 'closed';
  taskId?: string | null;
  dayDate?: Date | null;
  dayEvents?: any[];
  panelWidth?: number;
  isResizing?: boolean;
  isSwitching?: boolean;
  onClose: () => void;
  onUpdate: () => void;
  onTaskStatusChanged?: (orderId: string | null, status: string) => void;
  onSelectTask?: (taskId: string) => void;
  tasks: any[];
  holidays: any[];
  isOverview?: boolean;
  // QuickAddDeliveryWizard'daki "Detayları Düzenle" gibi, panel açılır açılmaz
  // özet yerine doğrudan düzenleme ekranını (OrderDetailModal) göstermek
  // istenen akışlar için — taskId bu değere eşit olduğunda "Düzenle" tuşuna
  // (openPreview) hiç basılmadan bir kere otomatik tetiklenir.
  autoEditTaskId?: string | null;
}) {
  const { user } = useAuth();
  
  const [detailError, setDetailError] = useState('');

  // "Düzenle" tuşu artık kendi gömülü formu yerine sipariş detaylarındaki AYNI
  // önizleme modalını (OrderDetailModal) açar — iki ayrı düzenleme deneyimi
  // yerine tek bir yer.
  const [previewGroup, setPreviewGroup] = useState<OrderGroup | null>(null);
  const [previewColumns, setPreviewColumns] = useState<Column[]>([]);
  const [previewSplitId, setPreviewSplitId] = useState<string | null>(null);
  // BOM bilesenleri (alt urunler) — OrderDetailsPage.tsx'teki activeComponents ile
  // AYNI mantik, RightPanel'in kendi "Duzenle" (openPreview) yolu icin ayrica
  // hesaplanir (iki cagri yeri birbirinden bagimsiz, state paylasilmiyor).
  const [previewComponents, setPreviewComponents] = useState<OrderGroup[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [deliveryNotes, setDeliveryNotes] = useState<any[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [editingNoteId, setEditingNoteId] = useState('');
  const [editingNoteDraft, setEditingNoteDraft] = useState('');
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesSubmitting, setNotesSubmitting] = useState(false);
  const [notesError, setNotesError] = useState('');
  const [, setSerialNumbers] = useState<any[]>([]);
  const [serialInput, setSerialInput] = useState('');
  const [serialTags, setSerialTags] = useState<string[]>([]);
  const [serialLoading, setSerialLoading] = useState(false);
  const [serialSubmitting, setSerialSubmitting] = useState(false);
  const [serialError, setSerialError] = useState('');
  const [manualStepChecks, setManualStepChecks] = useState<ManualStepState>(buildDefaultManualStepState);
  const [manualStepLoading, setManualStepLoading] = useState(false);
  const [manualStepSaving, setManualStepSaving] = useState(false);
  const [manualStepsExpanded, setManualStepsExpanded] = useState(false);
  const loadedManualStepOrderIdRef = useRef<string | null>(null);

  const selectedTask = useMemo(() => {
    if (mode === 'task' && taskId) {
      return tasks.find(t => String(t.id) === String(taskId));
    }
    return null;
  }, [mode, taskId, tasks]);

  const selectedOrderId = useMemo(() => getOrderIdFromTask(selectedTask), [selectedTask]);
  const selectedOrderTask = useMemo(() => {
    if (!selectedOrderId) return null;
    return tasks.find(t => String(t.id) === `order_${selectedOrderId}`) || null;
  }, [selectedOrderId, tasks]);
  const selectedStageCounts = useMemo(() => {
    const taskCounts = selectedTask?.stage_counts as Record<string, number> | undefined;
    if (taskCounts && Object.keys(taskCounts).length > 0) return taskCounts;
    return (selectedOrderTask?.stage_counts as Record<string, number> | undefined) || {};
  }, [selectedOrderTask, selectedTask]);
  const selectedCompletionPercentage = useMemo(() => {
    const taskCounts = selectedTask?.stage_counts as Record<string, number> | undefined;
    if (
      taskCounts &&
      Object.keys(taskCounts).length > 0 &&
      typeof selectedTask?.completion_percentage === 'number'
    ) {
      return selectedTask.completion_percentage;
    }
    if (typeof selectedOrderTask?.completion_percentage === 'number') return selectedOrderTask.completion_percentage;
    if (typeof selectedTask?.completion_percentage === 'number') return selectedTask.completion_percentage;
    return 0;
  }, [selectedOrderTask, selectedTask]);

  const holidayKeySet = useMemo(() => new Set(holidays.filter(h => h.is_active).map(h => h.holiday_date)), [holidays]);

  const siblings = useMemo(() => {
    const parentId = selectedTask?.parent;
    if (mode !== 'task' || !selectedTask || parentId === null || parentId === undefined) return [];
    return tasks
      .filter(t => t.parent !== null && t.parent !== undefined && String(t.parent) === String(parentId))
      .sort((a, b) => {
        const da = (a.deliveryDate || a.start) instanceof Date ? (a.deliveryDate || a.start).getTime() : 0;
        const db = (b.deliveryDate || b.start) instanceof Date ? (b.deliveryDate || b.start).getTime() : 0;
        return da - db;
      });
  }, [mode, selectedTask, tasks]);

  const splitGroups = useMemo(() => {
    const groups = new Map<string, any[]>();
    siblings.forEach((task) => {
      const rootId = getSplitRootId(task);
      if (!rootId) return;
      const list = groups.get(rootId) || [];
      list.push(task);
      groups.set(rootId, list);
    });
    return groups;
  }, [siblings]);

  // Özet gösterimde seçili teslimat barının kardeş aşama görevleri (tedarik → teslimat),
  // backend'in geri-zamanlama ile hesapladığı gerçek tarihlerle, kronolojik sırada.
  const stageTimeline = useMemo(() => {
    if (mode !== 'task' || !selectedTask) return [];
    const rootId = getSplitRootId(selectedTask);
    if (!rootId) return [];
    const order: Record<string, number> = { supply: 0, assembly: 1, production: 2, test: 3, delivery: 4 };
    return tasks
      .filter(t => getSplitRootId(t) === rootId && t.stage && order[String(t.stage).toLowerCase()] !== undefined)
      .map(t => {
        const stageKey = String(t.stage).toLowerCase();
        const start = t.start instanceof Date ? t.start : null;
        // t.deliveryDate, siparişin GENEL teslimat tarihidir (split'in TÜM aşama
        // görevlerinde AYNI değeri taşır, bkz. gantt.py delivery_date=ds.end_date) —
        // bu aşamanın KENDİ bitişi DEĞİLDİR. Önceden burada tercih edilince (ör.
        // Tedarik) barda gösterilenden farklı, yanlış bir tarih görünüyordu. Barlar
        // t.end'i doğrudan kullandığı için burada da aynısı yapılır (tutarlılık).
        const end = t.end instanceof Date ? t.end : null;
        return { key: stageKey, start, end };
      })
      .sort((a, b) => (order[a.key] ?? 99) - (order[b.key] ?? 99));
  }, [mode, selectedTask, tasks]);

  const partialSplitItems = useMemo(() => {
    const pickRepresentative = (group: any[]) => {
      if (group.length === 0) return null;
      const deliveryStage = group.find((t) => String(t.stage || '').toLowerCase() === 'delivery');
      if (deliveryStage) return deliveryStage;
      return [...group].sort((a, b) => {
        const aTime = (a.deliveryDate || a.end || a.start) instanceof Date ? (a.deliveryDate || a.end || a.start).getTime() : 0;
        const bTime = (b.deliveryDate || b.end || b.start) instanceof Date ? (b.deliveryDate || b.end || b.start).getTime() : 0;
        return aTime - bTime;
      })[group.length - 1];
    };

    return Array.from(splitGroups.values())
      .map((group) => pickRepresentative(group))
      .filter((item) => item !== null)
      .sort((a, b) => {
        const aTime = (a.deliveryDate || a.start) instanceof Date ? (a.deliveryDate || a.start).getTime() : 0;
        const bTime = (b.deliveryDate || b.start) instanceof Date ? (b.deliveryDate || b.start).getTime() : 0;
        return aTime - bTime;
      });
  }, [splitGroups]);

  const totalQuantity = useMemo(() => {
    if (selectedOrderTask?.quantity != null) {
      return Number(selectedOrderTask.quantity);
    }
    return partialSplitItems.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
  }, [selectedOrderTask, partialSplitItems]);

  const isPartial = useMemo(() => {
    return selectedOrderTask?.is_explicit_split === true || splitGroups.size > 1;
  }, [selectedOrderTask, splitGroups]);

  // BOM bilesenleri (alt urunler) — bu siparisin altina nested "Bilesen: X" proje
  // satirlari olarak gelir (bkz. gantt.py /gantt/tasks). Parcali teslimatla
  // KARISTIRILMAMASI icin ayri, kendi karti var (splitGroups/partialSplitItems bu
  // satirlari zaten disliyor — HierarchicalGantt.tsx'teki ayni ayrimin bir esi).
  const componentOrders = useMemo(() => {
    if (!selectedOrderId) return [];
    const parentId = `order_${selectedOrderId}`;
    return tasks
      .filter((t) => t.type === 'summary' && String(t.parent) === parentId)
      .sort((a, b) => {
        const aTime = a.end instanceof Date ? a.end.getTime() : 0;
        const bTime = b.end instanceof Date ? b.end.getTime() : 0;
        return aTime - bTime;
      });
  }, [selectedOrderId, tasks]);

  // Alt ürün kartındaki bir satıra tıklanınca sağ paneli o alt ürüne geçirmek için —
  // comp.id ("order_<comp_order.id>", proje satırı) değil, o alt ürünün KENDİ aşama
  // görevlerinden biri (split_<uuid>_<stage>) hedeflenmeli, aksi halde İş Akışı
  // (stageTimeline, getSplitRootId'ye dayanıyor) boş kalır. Bileşenlerde Teslimat
  // aşaması yok — en geç biten aşama (genelde Test) temsilci seçilir.
  const componentRepresentativeByOrderId = useMemo(() => {
    const map = new Map<string, any>();
    componentOrders.forEach((comp) => {
      const children = tasks.filter((t) => t.type === 'task' && String(t.parent) === String(comp.id));
      if (children.length === 0) return;
      const representative = [...children].sort((a, b) => {
        const aTime = a.end instanceof Date ? a.end.getTime() : 0;
        const bTime = b.end instanceof Date ? b.end.getTime() : 0;
        return aTime - bTime;
      })[children.length - 1];
      map.set(String(comp.id), representative);
    });
    return map;
  }, [componentOrders, tasks]);

  // BOM ana siparişlerde (bileşenleri varsa) "Dizgi" ayrı/seçilebilir bir adım
  // değildir — bileşenlerin kendi Dizgi'siyle yapılmış sayılır (bkz. backend
  // gantt.py update_manual_step_state, date_utils.py component_ready_at
  // filtresi). Bu yüzden checklist'te ayrı bir buton olarak GÖSTERİLMEZ — Tedarik
  // tamamlanınca backend zaten Dizgi'yi otomatik işaretliyor. Sayaç/ilerleme
  // hesapları (MANUAL_STEP_DEFS'in tam hali) buradan ETKİLENMEZ, yalnızca render
  // edilen buton/rozet listesi daralır.
  const visibleManualStepDefs = useMemo(
    () => (componentOrders.length > 0 ? MANUAL_STEP_DEFS.filter((s) => s.key !== 'assembly') : MANUAL_STEP_DEFS),
    [componentOrders.length],
  );

  const componentsReadyAt = useMemo(() => {
    if (componentOrders.length === 0) return null;
    return componentOrders.reduce<Date | null>((latest, c) => {
      if (!(c.end instanceof Date)) return latest;
      if (!latest || c.end.getTime() > latest.getTime()) return c.end;
      return latest;
    }, null);
  }, [componentOrders]);

  // Manuel adım takibinin hangi kapsamda (hangi split, ya da tüm sipariş) çalıştığını
  // belirler — her split artık kendi bağımsız ilerlemesini taşıyor.
  const manualStepScopeId = useMemo(() => getManualStepScopeId(selectedTask), [selectedTask]);
  const manualStepSplitId = useMemo(() => {
    if (!manualStepScopeId) return null;
    return manualStepScopeId.startsWith('split_') && !manualStepScopeId.startsWith('split_fake_')
      ? manualStepScopeId
      : null;
  }, [manualStepScopeId]);

  // Sipariş detayları sayfasıyla (OrderDetailsPage.tsx) BİREBİR aynı mantıkla
  // /order-details/ verisini çeker, seçili siparişe ait satırları/sütunları
  // kurar ve önizleme modalını açar.
  const openPreview = useCallback(async () => {
    if (!selectedOrderId) return;
    setPreviewLoading(true);
    try {
      const { data } = await api.get<{ rows: OrderDetailRow[]; base_data_keys: string[] }>('/order-details/');
      const rows = data.rows.filter((row) => row.order_id === selectedOrderId);
      const dynamicColumns = data.base_data_keys
        .filter((key) => !BASE_DATA_COLUMN_KEYS.has(key))
        .map<Column>((key) => ({
          key: `base_data.${key}`,
          label: key,
          getValue: (row) => row.base_data[key],
          getRawValue: (row) => row.base_data[key],
          editable: !READ_ONLY_COLUMN_KEYS.has(key),
          inputType: 'text' as InputType,
          recordType: 'base_data' as const,
          fieldKey: key,
        }));
      setPreviewColumns([...CORE_COLUMNS, ...dynamicColumns]);
      setPreviewSplitId(manualStepSplitId);
      setPreviewGroup({
        orderId: selectedOrderId,
        externalId: rows[0]?.external_id ?? '',
        entries: rows.map((row, rowIndex) => ({ row, rowIndex })),
      });

      // BOM bilesenleri: parent_order_id bu siparise (selectedOrderId) esit olan
      // satirlar, kendi order_id'lerine gore ayri OrderGroup'lara toplanir.
      const componentGroups = new Map<string, OrderGroup>();
      data.rows
        .filter((row) => row.parent_order_id === selectedOrderId)
        .forEach((row, rowIndex) => {
          let g = componentGroups.get(row.order_id);
          if (!g) {
            g = { orderId: row.order_id, externalId: row.external_id, entries: [] };
            componentGroups.set(row.order_id, g);
          }
          g.entries.push({ row, rowIndex });
        });
      setPreviewComponents(Array.from(componentGroups.values()));
    } catch {
      toast.error('Sipariş detayları yüklenemedi.');
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedOrderId, manualStepSplitId]);

  const manualStepProgress = useMemo(() => {
    const completedCount = MANUAL_STEP_DEFS.reduce((count, step) => count + (manualStepChecks[step.key]?.checked ? 1 : 0), 0);
    return {
      completedCount,
      totalCount: MANUAL_STEP_DEFS.length,
      percent: Math.round((completedCount / MANUAL_STEP_DEFS.length) * 100),
    };
  }, [manualStepChecks]);

  // Sunucudan manuel adım durumunu çekip yerel state'e işler — hem ilk yükleme
  // (aşağıdaki effect) hem de modal üzerinden bir kayıt sonrası ZORLA yenileme
  // (bkz. reloadManualSteps) için ortak.
  const fetchManualSteps = useCallback(async (scopeId: string): Promise<boolean> => {
    try {
      const { data } = await api.get(`/gantt/tasks/${scopeId}/manual-steps`);
      const defaultState = buildDefaultManualStepState();
      const steps = data?.steps || {};
      setManualStepChecks(
        MANUAL_STEP_DEFS.reduce((acc, step) => {
          const stepMeta = steps[step.key] || {};
          acc[step.key] = {
            checked: Boolean(stepMeta.checked),
            checked_by: stepMeta.checked_by || null,
            checked_by_username: stepMeta.checked_by_username || null,
            checked_at: stepMeta.checked_at || null,
          };
          return acc;
        }, defaultState),
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!selectedTask || !manualStepScopeId) {
      loadedManualStepOrderIdRef.current = null;
      setManualStepLoading(false);
      setManualStepChecks(buildDefaultManualStepState());
      return;
    }

    let cancelled = false;

    if (loadedManualStepOrderIdRef.current === manualStepScopeId) {
      return () => {
        cancelled = true;
      };
    }

    setManualStepLoading(true);
    setManualStepChecks(buildDefaultManualStepState());

    fetchManualSteps(manualStepScopeId)
      .then((ok) => {
        if (cancelled) return;
        if (ok) {
          loadedManualStepOrderIdRef.current = manualStepScopeId;
        } else {
          setManualStepChecks(buildDefaultManualStepState());
          toast.error('Manuel adım durumu yüklenemedi.');
        }
      })
      .finally(() => {
        if (!cancelled) setManualStepLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [manualStepScopeId, fetchManualSteps]);

  // Önizleme modalinde "Durum" değiştirilip kaydedildiğinde, o siparişin manuel
  // adım kutucukları (checklist) sunucuda değişmiş olabilir — ama görev seçimi
  // AYNI kaldığı için yukarıdaki effect'in önbellek koruması (loadedManualStepOrderIdRef)
  // yeniden çekmeyi atlar. Modal kapatılıp açılana kadar checklist eskisini gösterirdi;
  // bu yüzden modal kaydından sonra doğrudan zorla yeniden çekilir.
  const reloadManualSteps = useCallback(async () => {
    if (!manualStepScopeId) return;
    const ok = await fetchManualSteps(manualStepScopeId);
    if (!ok) toast.error('Manuel adım durumu yüklenemedi.');
  }, [manualStepScopeId, fetchManualSteps]);

  const toggleManualStep = useCallback(async (stepKey: ManualStepKey) => {
    if (!selectedTask || !manualStepScopeId) return;

    const nextState = {
      ...manualStepChecks,
      [stepKey]: {
        ...manualStepChecks[stepKey],
        checked: !manualStepChecks[stepKey].checked,
      },
    };

    setManualStepChecks(nextState);
    setManualStepSaving(true);

    try {
      const { data } = await api.patch(`/gantt/tasks/${manualStepScopeId}/manual-steps`, {
        steps: nextState,
      });
      const serverSteps = data?.steps || nextState;
      const completedCount = MANUAL_STEP_DEFS.reduce((count, step) => count + (serverSteps[step.key]?.checked ? 1 : 0), 0);
      const resolvedStatus = completedCount === MANUAL_STEP_DEFS.length
        ? 'COMPLETED'
        : completedCount > 0
          ? 'APPROVED'
          : 'PENDING';
      setManualStepChecks(
        MANUAL_STEP_DEFS.reduce((acc, step) => {
          const stepMeta = serverSteps[step.key] || {};
          acc[step.key] = {
            checked: Boolean(stepMeta.checked),
            checked_by: stepMeta.checked_by || null,
            checked_by_username: stepMeta.checked_by_username || null,
            checked_at: stepMeta.checked_at || null,
          };
          return acc;
        }, buildDefaultManualStepState()),
      );
      // orderStatus, siparişin TÜM parçalarının toplam (roll-up) durumu; splitId varsa
      // sadece o parçanın durumu değişti, dinleyiciler ilgili bar'ı ayrı güncelleyebilir.
      const orderStatus = data?.order_status ?? resolvedStatus;
      onTaskStatusChanged?.(selectedOrderId, orderStatus);
      window.dispatchEvent(new CustomEvent('dps-task-status-changed', {
        detail: {
          orderId: selectedOrderId,
          splitId: manualStepSplitId,
          parentId: String(selectedTask?.parent ?? selectedTask?.id ?? ''),
          status: orderStatus,
          splitStatus: resolvedStatus,
        },
      }));
    } catch {
      setManualStepChecks(manualStepChecks);
      toast.error('Adım durumu kaydedilemedi.');
    } finally {
      setManualStepSaving(false);
    }
  }, [manualStepChecks, manualStepScopeId, manualStepSplitId, onTaskStatusChanged, selectedOrderId, selectedTask]);

  const resetManualSteps = useCallback(() => {
    void (async () => {
      if (!selectedTask || !manualStepScopeId) return;
      const previousState = manualStepChecks;
      const nextState = buildDefaultManualStepState();
      setManualStepChecks(nextState);
      setManualStepSaving(true);
      try {
        const { data } = await api.patch(`/gantt/tasks/${manualStepScopeId}/manual-steps`, {
          steps: nextState,
        });
        const serverSteps = data?.steps || nextState;
        setManualStepChecks(
          MANUAL_STEP_DEFS.reduce((acc, step) => {
            const stepMeta = serverSteps[step.key] || {};
            acc[step.key] = {
              checked: Boolean(stepMeta.checked),
              checked_by: stepMeta.checked_by || null,
              checked_by_username: stepMeta.checked_by_username || null,
              checked_at: stepMeta.checked_at || null,
            };
            return acc;
          }, buildDefaultManualStepState()),
        );
        const orderStatus = data?.order_status ?? 'PENDING';
        onTaskStatusChanged?.(selectedOrderId, orderStatus);
        window.dispatchEvent(new CustomEvent('dps-task-status-changed', {
          detail: {
            orderId: selectedOrderId,
            splitId: manualStepSplitId,
            parentId: String(selectedTask?.parent ?? selectedTask?.id ?? ''),
            status: orderStatus,
            splitStatus: 'PENDING',
          },
        }));
      } catch {
        // toggleManualStep'teki aynı kural: sunucu isteği başarısız olursa
        // ekranı (iyimser/optimistic olarak sıfırlanmış hâliyle) olduğu gibi
        // bırakmak yerine önceki duruma geri al — aksi halde kullanıcı
        // "sıfırlandı" sanıp aslında sunucuda değişmemiş bir duruma güvenir.
        setManualStepChecks(previousState);
        toast.error('Adım durumu sıfırlanamadı.');
      } finally {
        setManualStepSaving(false);
      }
    })();
  }, [manualStepChecks, manualStepScopeId, manualStepSplitId, onTaskStatusChanged, selectedOrderId, selectedTask]);

  const canManageSelectedTask = useMemo(() => {
    if (!user || !selectedTask) return false;
    return user.role === 'ADMIN' || user.role === 'PLANNER' || selectedTask.createdByUsername === user.username;
  }, [user, selectedTask]);

  // QuickAddDeliveryWizard'daki "Detayları Düzenle" gibi, panel açılır açılmaz
  // özet yerine doğrudan düzenleme ekranını (OrderDetailModal) göstermek
  // istenen akışlar için — taskId autoEditTaskId'ye eşit olduğunda "Düzenle"
  // tuşuna (openPreview) hiç basılmadan, eşleşme başına yalnızca BİR KEZ
  // otomatik tetiklenir (aksi halde previewGroup kullanıcı tarafından
  // kapatıldıktan sonra her re-render'da yeniden açılırdı).
  const autoEditTriggeredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'task' || !taskId || !autoEditTaskId || taskId !== autoEditTaskId) return;
    if (!selectedOrderId || !canManageSelectedTask) return;
    if (autoEditTriggeredForRef.current === taskId) return;
    autoEditTriggeredForRef.current = taskId;
    openPreview();
  }, [mode, taskId, autoEditTaskId, selectedOrderId, canManageSelectedTask, openPreview]);

  const canManageNote = useCallback((note: any) => {
    if (!user) return false;
    return user.role === 'ADMIN' || user.role === 'PLANNER' || note.created_by === user.id;
  }, [user]);

  const parsedSerialNumbers = serialTags;

  const loadSerialNumbers = useCallback(async (orderId: string | null) => {
    if (!orderId) {
      setSerialNumbers([]);
      setSerialTags([]);
      setSerialInput('');
      setSerialError('');
      return;
    }

    setSerialLoading(true);
    setSerialError('');
    try {
      const { data } = await api.get(`/orders/${orderId}/serial-numbers`);
      const items = Array.isArray(data) ? data : [];
      setSerialNumbers(items);
      setSerialTags(items.map(item => String(item.serial_number || '').trim()).filter(Boolean));
    } catch {
      setSerialNumbers([]);
      setSerialTags([]);
      setSerialError('Seri numaraları yüklenemedi.');
    } finally {
      setSerialLoading(false);
    }
  }, []);

  const handleAddSerial = useCallback(() => {
    const val = serialInput.trim();
    if (!val) return;
    setSerialTags(prev => prev.includes(val) ? prev : [...prev, val]);
    setSerialInput('');
  }, [serialInput]);

  const handleRemoveSerial = useCallback((idx: number) => {
    setSerialTags(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const saveSerialNumbers = useCallback(async (showToast = true) => {
    if (!selectedOrderId) return;

    setSerialSubmitting(true);
    setSerialError('');
    try {
      const { data } = await api.post(`/orders/${selectedOrderId}/serial-numbers/bulk`, {
        serial_numbers: serialTags,
      });
      const items = Array.isArray(data) ? data : [];
      setSerialNumbers(items);
      setSerialTags(items.map(item => String(item.serial_number || '').trim()).filter(Boolean));
      if (showToast) toast.success('Seri numaraları kaydedildi');
    } catch (err: any) {
      const message = err?.response?.data?.detail || 'Seri numaraları kaydedilemedi.';
      setSerialError(message);
      throw new Error(message);
    } finally {
      setSerialSubmitting(false);
    }
  }, [serialTags, selectedOrderId]);

  const loadDeliveryNotes = useCallback(async (id: string) => {
    if (!id) return;
    setNotesLoading(true);
    setNotesError('');
    try {
      const { data } = await api.get(`/gantt/tasks/${id}/notes`);
      setDeliveryNotes(Array.isArray(data) ? data : []);
    } catch {
      setDeliveryNotes([]);
      setNotesError('Notlar yuklenemedi.');
    } finally {
      setNotesLoading(false);
    }
  }, []);

  // Reset states when task changes
  useEffect(() => {
    if (mode === 'task' && selectedTask) {
      setDetailError('');
      loadDeliveryNotes(selectedTask.id);
      loadSerialNumbers(selectedOrderId);
    }
  }, [mode, selectedTask, selectedOrderId, loadDeliveryNotes, loadSerialNumbers]);

  // Notes
  const handleNoteSubmit = async () => {
    if (!noteDraft.trim() || !selectedTask) return;
    setNotesSubmitting(true);
    setNotesError('');
    try {
      const { data } = await api.post(`/gantt/tasks/${selectedTask.id}/notes`, { content: noteDraft.trim() });
      setDeliveryNotes(prev => [data, ...prev]);
      setNoteDraft('');
      toast.success('Not eklendi');
    } catch (err: any) {
      setNotesError(err?.response?.data?.detail || 'Not kaydedilemedi.');
    } finally {
      setNotesSubmitting(false);
    }
  };
  const handleNoteDelete = async (noteId: string) => {
    if (!selectedTask) return;
    if (!window.confirm('Notu silmek istediginize emin misiniz?')) return;
    setNotesSubmitting(true);
    setNotesError('');
    try {
      await api.delete(`/gantt/tasks/${selectedTask.id}/notes/${noteId}`);
      setDeliveryNotes(prev => prev.filter(n => n.id !== noteId));
      toast.success('Not silindi');
    } catch (err: any) {
      setNotesError(err?.response?.data?.detail || 'Not silinemedi.');
    } finally {
      setNotesSubmitting(false);
    }
  };
  const handleNoteEditStart = (note: any) => { setEditingNoteId(note.id); setEditingNoteDraft(note.content); };
  const handleNoteEditCancel = () => { setEditingNoteId(''); setEditingNoteDraft(''); };
  const handleNoteEditSave = async () => {
    if (!editingNoteDraft.trim() || !selectedTask || !editingNoteId) return;
    setNotesSubmitting(true);
    setNotesError('');
    try {
      const { data } = await api.put(`/gantt/tasks/${selectedTask.id}/notes/${editingNoteId}`, { content: editingNoteDraft.trim() });
      setDeliveryNotes(prev => prev.map(n => n.id === editingNoteId ? data : n));
      setEditingNoteId('');
      toast.success('Not güncellendi');
    } catch (err: any) {
      setNotesError(err?.response?.data?.detail || 'Not guncellenemedi.');
    } finally {
      setNotesSubmitting(false);
    }
  };

  if (mode === 'closed') return null;

  return (
    <>
    <div
      className={`right-panel relative flex flex-col h-full bg-surface-800 border-l border-surface-700 flex-shrink-0 ${isResizing ? 'is-resizing' : ''}`}
      style={{ width: panelWidth, contain: 'layout', willChange: 'width', transition: isResizing ? 'none' : 'width 120ms ease-out' }}
    >
      {isSwitching && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-800/95">
          <svg className="h-7 w-7 animate-spin text-primary-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}
      <div className="flex items-center justify-between p-4 border-b border-surface-700">
        <div className="flex flex-col leading-tight min-w-0 flex-1">
          {mode === 'task' && selectedTask ? (
            <>
              <h4 className="font-semibold text-lg text-white truncate">
                {selectedTask.orderNo || selectedTask.externalId || '—'}
              </h4>
              <span className="text-base font-medium text-white truncate">
                {selectedTask.productType || selectedTask.chipLabel || selectedTask.text}
              </span>
              {!isOverview && getStageLabel(selectedTask) && (
                <span className="text-[11px] font-medium rp-text-cyan mt-0.5">Adım: {getStageLabel(selectedTask)}</span>
              )}
            </>
          ) : mode === 'day' && dayDate ? (
            <h4 className="font-semibold text-lg text-white">
              {dayDate.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </h4>
          ) : null}
        </div>
        <button type="button" onClick={onClose} className="rp-close-btn p-1 rounded-md transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {mode === 'day' && dayDate && (
          <div className="flex flex-col gap-3">
            {dayEvents && dayEvents.length > 0 ? (
              dayEvents.map((ev, i) => {
                const task = ev.task || ev;
                return (
                  <div key={`day-ev-${task.id || i}`} className="p-3 bg-surface-900 rounded-lg border border-surface-700">
                    <div className="font-medium text-primary-400">{task.productType || task.chipLabel || task.text}</div>
                    {getStageLabel(task) && <div className="text-xs rp-text-cyan mt-1">Adım: {getStageLabel(task)}</div>}
                    {task.orderNo && <div className="text-sm text-surface-400">Sipariş: {task.orderNo}</div>}
                    {task.customerName && <div className="text-sm text-surface-400">Müşteri: {task.customerName}</div>}
                    {task.quantityLabel && <div className="text-sm text-surface-400 mt-1">Adet: {task.quantityLabel}</div>}
                  </div>
                );
              })
            ) : (
              <div className="text-surface-400 text-center py-4">Bu günde teslimat bulunmuyor.</div>
            )}
          </div>
        )}

        {mode === 'task' && selectedTask && (
          <>
            {canManageSelectedTask && (
              <>
                <button
                  type="button"
                  className="btn-primary w-full mb-2 py-4 text-sm font-semibold rounded-2xl"
                  disabled={previewLoading}
                  onClick={() => { setDetailError(''); openPreview(); }}
                >
                  {previewLoading ? '...' : 'Düzenle'}
                </button>
                {/* Panelin eski "Sil" sekmesi kaldırıldığında (bkz. sürüm notları
                    v1.15) silme işlemi yalnızca Düzenle ekranında kaldı; bu not
                    kullanıcının onu nerede arayacağını söylüyor. */}
                <p className="mb-4 flex items-start gap-1.5 text-[11px] leading-snug text-surface-500">
                  <svg className="mt-px h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z" />
                  </svg>
                  Siparişi ve teslimat parçalarını Düzenle ekranından silebilirsiniz.
                </p>
              </>
            )}

            <div className="mb-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 shadow-[0_18px_40px_rgba(8,15,30,0.35)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.24em] rp-text-cyan-soft">İş akışı</div>
                  <h5 className="mt-1 text-sm font-semibold text-white">Manuel adım takibi</h5>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-right">
                    <div className="text-2xl font-bold text-white">{manualStepProgress.completedCount}/{manualStepProgress.totalCount}</div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-surface-400">Tamamlandı</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setManualStepsExpanded(p => !p)}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-surface-600/50 bg-surface-800/60 text-surface-400 hover:border-cyan-500/40 hover:text-cyan-300 transition-all"
                    aria-label={manualStepsExpanded ? 'Adımları gizle' : 'Adımları göster'}
                  >
                    <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${manualStepsExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="mt-3 h-2 rounded-full bg-surface-800/80 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-sky-500 to-blue-500 transition-all duration-300"
                  style={{ width: `${manualStepProgress.percent}%` }}
                />
              </div>

              {!manualStepsExpanded && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {visibleManualStepDefs.map((step) => {
                    const checked = manualStepChecks[step.key]?.checked;
                    return (
                      <span key={step.key} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${checked ? 'bg-emerald-500/15 rp-text-emerald' : 'bg-surface-800 text-surface-500'}`}>
                        {checked && <span>✓</span>}
                        {step.label}
                      </span>
                    );
                  })}
                </div>
              )}

              {manualStepsExpanded && (
                <>
              <div className="mt-4 space-y-2">
                {visibleManualStepDefs.map((step) => {
                  const checked = manualStepChecks[step.key]?.checked;
                  const checkedBy = manualStepChecks[step.key]?.checked_by_username;
                  const checkedAt = manualStepChecks[step.key]?.checked_at;
                  const { completed, total } = getManualStageProgress(step.key, selectedStageCounts);
                  const liveTotal = serialTags.length > 0 ? serialTags.length : total;
                  const liveCompleted = Math.min(completed, liveTotal);

                  return (
                    <button
                      key={step.key}
                      type="button"
                      onClick={() => void toggleManualStep(step.key)}
                      disabled={manualStepLoading || manualStepSaving}
                      className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-all duration-200 ${checked ? 'border-emerald-500/40 bg-emerald-500/10' : 'rp-step-row border-surface-700 hover:border-cyan-500/40'}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-white">{step.label}</span>
                              {checked && (
                                <span className="text-[11px] rp-text-emerald-soft">
                                  {checkedBy || '-'} · {formatManualStepTimestamp(checkedAt)}
                                </span>
                              )}
                            </div>
                          </div>

                          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${checked ? 'bg-emerald-500/15 rp-text-emerald' : 'bg-surface-800 text-surface-400'}`}>
                            {liveCompleted}/{liveTotal}
                          </span>
                        </div>
                      </div>

                      <div className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border text-sm font-bold transition-colors ${checked ? 'border-emerald-400 bg-emerald-400 text-surface-950' : 'border-surface-600 text-transparent'}`}>
                        ✓
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 flex justify-end">
                <button type="button" className="text-[11px] rp-text-cyan hover:text-cyan-200 transition-colors disabled:opacity-50" onClick={resetManualSteps} disabled={manualStepLoading || manualStepSaving}>
                  Sıfırla
                </button>
              </div>
                </>
              )}
            </div>

            {selectedStageCounts && Object.keys(selectedStageCounts).length > 0 && (
              <div className="mb-4 rounded-2xl border border-violet-500/20 bg-violet-500/10 p-4 shadow-[0_18px_40px_rgba(8,15,30,0.35)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.24em] rp-text-violet-soft">Seri Numarası Takibi</div>
                    <h5 className="mt-1 text-sm font-semibold text-white">Üretim Aşamaları</h5>
                    <p className="mt-1 text-xs text-surface-400">Seri numaralarının mevcut dağılımı.</p>
                  </div>
                  {typeof selectedCompletionPercentage === 'number' && (
                    <div className="text-right">
                      <div className="text-2xl font-bold text-white">{Math.round(selectedCompletionPercentage)}%</div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-surface-400">Tamamlanma</div>
                    </div>
                  )}
                </div>

                {typeof selectedCompletionPercentage === 'number' && (
                  <div className="mt-3 h-2 rounded-full bg-surface-800/80 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-400 via-purple-500 to-pink-500 transition-all duration-300"
                      style={{ width: `${selectedCompletionPercentage}%` }}
                    />
                  </div>
                )}

                <div className="mt-4 space-y-2">
                  {(() => {
                    const stageOrder = ['supply', 'assembly', 'kalite', 'test1', 'epoxy', 'conformal', 'test2', 'montaj', 'montaj_kalite', 'final_test', 'delivery', 'completed'];
                    const stageLabels: Record<string, string> = {
                      supply: 'Tedarik',
                      assembly: 'Dizgi',
                      kalite: 'Kalite',
                      test1: 'Test1',
                      epoxy: 'Epoxy',
                      conformal: 'Conformal',
                      test2: 'Test2',
                      montaj: 'Montaj',
                      montaj_kalite: 'M.Kalite',
                      final_test: 'F.Test',
                      delivery: 'Teslimat',
                      completed: 'Tamamlandı',
                    };
                    const counts = selectedStageCounts as Record<string, number>;
                    const totalSerialNumbers = counts ? Object.values(counts).reduce((sum: number, count: unknown) => sum + (Number(count) || 0), 0) : 0;

                    return stageOrder
                      .filter(stage => counts?.[stage] > 0)
                      .map(stage => {
                        const count = counts?.[stage] || 0;
                        const percentage = totalSerialNumbers > 0 ? Math.round((count / totalSerialNumbers) * 100) : 0;

                        return (
                          <div key={stage} className="flex items-center gap-3 rounded-xl border border-surface-700/50 bg-surface-900/50 px-3 py-2.5 text-left">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm font-semibold text-surface-200">{stageLabels[stage] || stage}</span>
                                <span className="text-[11px] font-bold rp-text-violet">
                                  {count}/{totalSerialNumbers}
                                </span>
                              </div>
                              <div className="mt-1.5 h-1 rounded-full bg-surface-800/60 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-gradient-to-r from-violet-400 to-purple-500 transition-all duration-300"
                                  style={{ width: `${percentage}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      });
                  })()}
                </div>
              </div>
            )}

            {componentOrders.length > 0 && (
              <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 shadow-lg">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.3)]">
                    <span className="text-lg">📦</span>
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-400/80">Sipariş Bilgisi</div>
                    <div className="text-sm font-bold text-white">Bu siparişin alt ürünleri var</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-surface-800/50 rounded-xl p-2.5 border border-surface-700/50">
                    <div className="text-[10px] text-surface-500 uppercase tracking-wider mb-1">Alt Ürün Sayısı</div>
                    <div className="text-sm font-bold text-white">{componentOrders.length} <span className="text-[10px] font-normal text-surface-400">ürün</span></div>
                  </div>
                  <div className="bg-surface-800/50 rounded-xl p-2.5 border border-surface-700/50">
                    <div className="text-[10px] text-surface-500 uppercase tracking-wider mb-1">Ana Ürün Üretimi Başlar</div>
                    <div className="text-sm font-bold text-white">
                      {componentsReadyAt ? componentsReadyAt.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—'}
                    </div>
                  </div>
                </div>

                <p className="text-[10px] text-surface-500 mb-2 leading-relaxed">
                  Dizgi, bu alt ürünlerin kendi üretimiyle yapılmış sayılır — ana ürünün Üretimi, alt ürünlerin en geç bitişinden önce başlamaz.
                </p>

                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-surface-500 ml-1 mb-2">Alt Ürünler</div>
                  {componentOrders.map((comp) => {
                    const label = String(comp.text || '').replace(/^📦\s*/, '');
                    const representative = componentRepresentativeByOrderId.get(String(comp.id));
                    const isSelected = !!representative && String(representative.id) === String(selectedTask.id);
                    const canNavigate = !!representative && !isSelected;
                    return (
                      <div
                        key={comp.id}
                        role={canNavigate ? 'button' : undefined}
                        tabIndex={canNavigate ? 0 : undefined}
                        onClick={() => { if (canNavigate) onSelectTask?.(String(representative.id)); }}
                        onKeyDown={(e) => {
                          if (!canNavigate) return;
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTask?.(String(representative.id)); }
                        }}
                        className={`flex items-center justify-between p-2.5 rounded-xl border transition-all duration-200 ${isSelected ? 'bg-primary-500/20 border-primary-500/40 shadow-[0_0_15px_rgba(59,130,246,0.1)]' : `rp-hover-row ${canNavigate ? 'cursor-pointer' : ''}`}`}
                      >
                        <div className="flex flex-col">
                          <span className="text-[11px] text-surface-200 font-medium">{label}</span>
                          <span className="text-[9px] text-surface-500">
                            {comp.start instanceof Date ? comp.start.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }) : '—'}
                            {' → '}
                            {comp.end instanceof Date ? comp.end.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—'}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-[12px] text-surface-300 font-semibold">{comp.quantity ?? '—'}</span>
                          <span className="text-[9px] text-surface-500 ml-1">adet</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {isPartial && partialSplitItems.length > 0 && (
              <div className="mb-6 rounded-2xl border border-primary-500/20 bg-primary-500/10 p-4 shadow-lg">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-500/20 text-primary-400 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
                    <span className="text-lg">🧩</span>
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary-400/80">Sipariş Bilgisi</div>
                    <div className="text-sm font-bold text-white">Bu bir parçalı teslimattır</div>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-surface-800/50 rounded-xl p-2.5 border border-surface-700/50">
                    <div className="text-[10px] text-surface-500 uppercase tracking-wider mb-1">Toplam Sipariş</div>
                    <div className="text-sm font-bold text-white">{totalQuantity} <span className="text-[10px] font-normal text-surface-400">adet</span></div>
                  </div>
                  <div className="bg-surface-800/50 rounded-xl p-2.5 border border-surface-700/50">
                    <div className="text-[10px] text-surface-500 uppercase tracking-wider mb-1">Parça Sayısı</div>
                    <div className="text-sm font-bold text-white">{partialSplitItems.length} <span className="text-[10px] font-normal text-surface-400">teslimat</span></div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-surface-500 ml-1 mb-2">Teslimat Akışı</div>
                  {partialSplitItems.map((sib, idx) => {
                    const isSelected = String(sib.id) === String(selectedTask.id);
                    return (
                      <div
                        key={sib.id}
                        role={isSelected ? undefined : 'button'}
                        tabIndex={isSelected ? undefined : 0}
                        onClick={() => { if (!isSelected) onSelectTask?.(String(sib.id)); }}
                        onKeyDown={(e) => {
                          if (isSelected) return;
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTask?.(String(sib.id)); }
                        }}
                        className={`group flex items-center justify-between p-2.5 rounded-xl border transition-all duration-200 ${isSelected ? 'bg-primary-500/20 border-primary-500/40 shadow-[0_0_15px_rgba(59,130,246,0.1)]' : 'rp-hover-row cursor-pointer'}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold ${isSelected ? 'bg-primary-500 rp-badge-white-text' : 'bg-surface-700 text-surface-400'}`}>
                            {idx + 1}
                          </div>
                          <div className="flex flex-col">
                            <span className={`text-[11px] ${isSelected ? 'text-primary-300 font-bold' : 'text-surface-300 font-medium'}`}>
                              {(sib.deliveryDate || sib.start).toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}
                            </span>
                            {isSelected && <span className="text-[9px] text-primary-400/80 uppercase tracking-tight">Şu anki seçim</span>}
                          </div>
                        </div>
                        <div className="text-right">
                          <span className={`text-[12px] ${isSelected ? 'text-white font-black' : 'text-surface-400 font-semibold'}`}>
                            {sib.quantity}
                          </span>
                          <span className="text-[9px] text-surface-500 ml-1">adet</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!isOverview && (() => {
              const parseISO = (s: any) => s ? new Date(`${String(s).substring(0, 10)}T00:00:00`) : null;
              const deliveryDate = selectedTask.deliveryDate instanceof Date
                ? selectedTask.deliveryDate
                : selectedTask.end instanceof Date
                  ? new Date(selectedTask.end.getTime() - DAY_MS)
                  : null;
              const qty = Number(selectedTask.quantity) || 1;
              const supplyStage = stageTimeline.find(s => s.key === 'supply');
              const supplyStart = supplyStage?.start
                ?? (deliveryDate ? subtractBusinessDays(deliveryDate, calcTotalRequiredDays(selectedTask, qty), holidayKeySet) : null);
              const today = startOfDay(new Date());

              const ORDERED_STAGES = ['supply', 'assembly', 'production', 'test', 'delivery'] as const;
              const isAllCompleted = selectedTask.status === 'COMPLETED'
                || ORDERED_STAGES.every(k => manualStepChecks[k]?.checked);
              const firstUncheckedIdx = isAllCompleted ? ORDERED_STAGES.length
                : ORDERED_STAGES.findIndex(k => !manualStepChecks[k]?.checked);
              const firstUncheckedKey = (firstUncheckedIdx >= 0 && firstUncheckedIdx < ORDERED_STAGES.length)
                ? ORDERED_STAGES[firstUncheckedIdx] : null;
              const nextStageEntry = firstUncheckedKey
                ? stageTimeline.find(s => s.key === firstUncheckedKey) ?? null : null;
              const overdueStage = (!isAllCompleted && nextStageEntry?.start && nextStageEntry.start < today)
                ? nextStageEntry : null;
              // Backend'in raporladığı duruma göre (yerel checkbox sayısına göre değil) —
              // böylece hiç kutucuk işaretlenmemişken bile (0 checked) "Tedarik" aktif
              // aşama olarak gösterilebilir, çünkü backend bunu artık APPROVED olarak
              // raporlayabiliyor (bkz. order_details.py _STATUS_SELECT_TO_STATE).
              const activeStageKey = (!isAllCompleted && selectedTask.status === 'APPROVED') ? firstUncheckedKey : null;
              const stageCounts = (selectedTask.stage_counts as Record<string, number> | null) ?? {};

              // Which stage bar is currently selected (adım görünümünde)
              const selectedStageKey = isStageTaskId(String(selectedTask.id))
                ? (selectedTask.stage?.toLowerCase() ?? null)
                : null;

              const promised = parseISO(selectedTask.promisedDate);
              const requirement = parseISO(selectedTask.requirementDate);
              const deadlineRef = promised || requirement;
              const deadlineRiskDays = (deadlineRef && deliveryDate)
                ? Math.round((deliveryDate.getTime() - deadlineRef.getTime()) / DAY_MS)
                : null;
              const hasDeadlineRisk = deadlineRiskDays !== null && deadlineRiskDays > 0;

              // onHandQuantity yalnızca BOM alt ürün (component) görevlerinde dolu gelir
              // (bkz. gantt.py — ana sipariş görevlerinde hep null) — bu yüzden bu alanın
              // varlığı, "Adet"in Teslimat Adedi mi yoksa Üretilecek Miktar mı olduğunun
              // karışmaması için "Elde Mevcut"/"Üretilecek" kartlarını göstermenin güvenli
              // sinyalidir.
              const isComponentTask = selectedTask.onHandQuantity !== null && selectedTask.onHandQuantity !== undefined;
              const onHandQty = isComponentTask ? Number(selectedTask.onHandQuantity) || 0 : 0;
              const neededQty = Number(selectedTask.quantity) || 0;
              const toProduceQty = Math.max(0, neededQty - onHandQty);

              const summaryCards: Array<{ label: string; value: string }> = [
                { label: 'Adet', value: selectedTask.quantityLabel || (selectedTask.quantity != null ? String(selectedTask.quantity) : '—') },
                ...(isComponentTask ? [
                  { label: 'Elde Mevcut', value: `${onHandQty} adet` },
                  { label: 'Üretilecek', value: `${toProduceQty} adet` },
                ] : []),
                { label: 'Üretim Tipi', value: selectedTask.isOutsourced === true ? 'Fason' : selectedTask.isOutsourced === false ? 'İç Üretim' : '—' },
                ...(selectedTask.customerName ? [{ label: 'Müşteri', value: String(selectedTask.customerName) }] : []),
                ...(selectedTask.responsiblePersonnel ? [{ label: 'Sorumlu', value: String(selectedTask.responsiblePersonnel) }] : []),
              ];

              const importantDates: Array<{ label: string; value: Date | null; highlight?: boolean }> = [
                { label: 'Sipariş Tarihi', value: parseISO(selectedTask.orderDate) },
                { label: 'Söz Verilen', value: promised },
                { label: 'Gereksinim', value: requirement },
                { label: 'Cezaya Konu', value: parseISO(selectedTask.penaltyDate) },
                { label: 'Planlanan Teslimat', value: deliveryDate, highlight: true },
              ].filter(d => d.value !== null);

              return (
                <div className="flex flex-col gap-4">
                  {/* Özet kartları */}
                  <div className="grid grid-cols-2 gap-2">
                    {summaryCards.map((c) => (
                      <div key={c.label} className="rounded-xl border border-surface-700/60 bg-surface-900/50 px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-surface-500">{c.label}</div>
                        <div className="mt-0.5 text-sm font-semibold text-white truncate" title={c.value}>{c.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Durum kartı */}
                  {isAllCompleted ? (
                    <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                      <div className="flex items-center gap-3">
                        <span className="text-lg leading-none">✅</span>
                        <div>
                          <div className="text-sm font-bold text-emerald-400">Sipariş tamamlandı</div>
                          <div className="mt-0.5 text-xs rp-text-emerald-soft">
                            Tüm aşamalar teslim edildi{deliveryDate ? ` · ${formatDMY(deliveryDate)}` : ''}.
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : overdueStage ? (
                    <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-lg leading-none">🏭</span>
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-red-400">
                            {(STAGE_TIMELINE_META[overdueStage.key]?.label ?? overdueStage.key)} başlangıcı gecikmiş
                          </div>
                          <div className="mt-1 text-xs rp-text-red-soft">
                            {`${STAGE_TIMELINE_META[overdueStage.key]?.label ?? overdueStage.key} aşamasına en geç ${formatDMY(overdueStage.start)} başlanmalıydı — plan riskte.`}
                          </div>
                        </div>
                      </div>
                      {hasDeadlineRisk && (
                        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium rp-text-red-soft">
                          ⚠ Planlanan teslimat, {promised ? 'söz verilen' : 'gereksinim'} tarihinden {deadlineRiskDays} gün sonra.
                        </div>
                      )}
                    </div>
                  ) : activeStageKey ? (
                    <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-lg leading-none">⚙️</span>
                        <div className="min-w-0">
                          <div className="text-sm font-bold rp-text-cyan">
                            {STAGE_TIMELINE_META[activeStageKey]?.label ?? activeStageKey} aşaması sürüyor
                          </div>
                          <div className="mt-1 text-xs rp-text-cyan-soft">
                            {firstUncheckedIdx} önceki aşama tamamlandı
                            {deliveryDate ? ` · Planlanan teslimat ${formatDMY(deliveryDate)}` : ''}.
                          </div>
                        </div>
                      </div>
                      {hasDeadlineRisk && (
                        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium rp-text-red-soft">
                          ⚠ Planlanan teslimat, {promised ? 'söz verilen' : 'gereksinim'} tarihinden {deadlineRiskDays} gün sonra.
                        </div>
                      )}
                    </div>
                  ) : supplyStart ? (
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-lg leading-none">🏭</span>
                        <div className="min-w-0">
                          <div className="text-sm font-bold rp-text-amber">Tedariğe en geç başlama</div>
                          <div className="mt-1 text-xs rp-text-amber-soft">
                            {`Teslimata yetişmek için tedariğe en geç ${formatDMY(supplyStart)} tarihinde başlanmalı.`}
                          </div>
                        </div>
                      </div>
                      {hasDeadlineRisk && (
                        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium rp-text-red-soft">
                          ⚠ Planlanan teslimat, {promised ? 'söz verilen' : 'gereksinim'} tarihinden {deadlineRiskDays} gün sonra.
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Fason bilgi satırı */}
                  {(selectedTask as any).isOutsourced === true && (
                    <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs rp-text-amber-soft">
                      <span>🏭</span>
                      <span>Bu sipariş fason (dış dizgi) üretimdir.</span>
                    </div>
                  )}

                  {/* Önemli tarihler */}
                  {importantDates.length > 0 && (
                    <div className="rounded-2xl border border-surface-700/60 bg-surface-900/40 p-4">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500 mb-3">Önemli Tarihler</div>
                      <div className="flex flex-col gap-2">
                        {importantDates.map((d) => (
                          <div key={d.label} className="flex items-center justify-between gap-3 text-sm">
                            <span className="text-surface-400">{d.label}</span>
                            <span className={d.highlight ? 'font-semibold rp-text-cyan' : 'text-white'}>{formatDMY(d.value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Aşama zaman çizelgesi — seçili aşama vurgulanır */}
                  {stageTimeline.length > 0 && (
                    <div className="rounded-2xl border border-surface-700/60 bg-surface-900/40 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500">Aşama Zaman Çizelgesi</div>
                        {supplyStart && deliveryDate && (
                          <div className="text-[11px] font-medium text-surface-300">{formatDM(supplyStart)} → {formatDM(deliveryDate)}</div>
                        )}
                      </div>
                      <div className="flex flex-col">
                        {stageTimeline.map((s, idx) => {
                          const isFasonAssembly = s.key === 'assembly' && (selectedTask as any).isOutsourced === true;
                          const meta = isFasonAssembly
                            ? { label: 'Fason (Dış Dizgi)', dot: 'bg-amber-400' }
                            : (STAGE_TIMELINE_META[s.key] || { label: s.key, dot: 'bg-surface-500' });
                          const isLastStage = idx === stageTimeline.length - 1;
                          const stageCount = stageCounts[s.key] || 0;
                          const isActiveStage = !isAllCompleted && s.key === activeStageKey;
                          const isDoneStage = isAllCompleted || Boolean(manualStepChecks[s.key as ManualStepKey]?.checked);
                          const isOverdueStage = !isDoneStage && s.key === firstUncheckedKey && !!overdueStage;
                          const isSelectedBar = s.key === selectedStageKey;
                          return (
                            <div key={s.key} className={`flex gap-3 rounded-xl ${isSelectedBar ? 'bg-surface-700/40 px-2 -mx-2' : ''} ${isDoneStage ? 'opacity-50' : ''}`}>
                              <div className="flex flex-col items-center">
                                {isDoneStage ? (
                                  <span className="mt-1 h-3 w-3 flex-none rounded-full bg-emerald-500 flex items-center justify-center text-[8px] rp-badge-white-text">✓</span>
                                ) : isOverdueStage ? (
                                  <span className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-red-500" />
                                ) : (
                                  <span className={`mt-1.5 h-2.5 w-2.5 flex-none rounded-full ${isActiveStage ? 'ring-2 ring-offset-1 rp-ring-offset ring-cyan-400 ' : ''}${meta.dot}`} />
                                )}
                                {!isLastStage && <span className="w-px flex-1 bg-surface-700 mt-1" />}
                              </div>
                              <div className={`min-w-0 flex-1 ${isLastStage ? 'py-1' : 'pb-3 pt-1'}`}>
                                <div className={`text-sm font-semibold ${isActiveStage ? 'rp-text-cyan' : isOverdueStage ? 'text-red-400' : isDoneStage ? 'text-surface-400' : 'text-white'}`}>
                                  {meta.label}
                                  {isActiveStage && stageCount > 0 && (
                                    <span className="ml-1.5 text-[10px] font-normal rp-text-cyan-soft">({stageCount} adet)</span>
                                  )}
                                  {isOverdueStage && (
                                    <span className="ml-1.5 text-[10px] font-normal text-red-400/80">gecikmiş</span>
                                  )}
                                  {isSelectedBar && (
                                    <span className="ml-1.5 text-[10px] font-normal text-surface-400">seçili</span>
                                  )}
                                </div>
                                <div className="text-xs text-surface-400">{formatDM(s.start)} – {formatDM(s.end)}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between text-[11px] text-surface-500 pt-1">
                    <span>Oluşturan: <span className="text-surface-300">{selectedTask.createdByUsername || '—'}</span></span>
                    <span>Son: <span className="text-surface-300">{selectedTask.lastInteractedByUsername || '—'}</span></span>
                  </div>
                </div>
              );
            })()}

            {isOverview && (() => {
              const parseISO = (s: any) => s ? new Date(`${String(s).substring(0, 10)}T00:00:00`) : null;
              const deliveryDate = selectedTask.deliveryDate instanceof Date
                ? selectedTask.deliveryDate
                : selectedTask.end instanceof Date
                  ? new Date(selectedTask.end.getTime() - DAY_MS)
                  : null;
              const qty = Number(selectedTask.quantity) || 1;
              const supplyStage = stageTimeline.find(s => s.key === 'supply');
              const supplyStart = supplyStage?.start
                ?? (deliveryDate ? subtractBusinessDays(deliveryDate, calcTotalRequiredDays(selectedTask, qty), holidayKeySet) : null);
              const today = startOfDay(new Date());

              // Stage progress from manualStepChecks (the checklist users interact with)
              const ORDERED_STAGES = ['supply', 'assembly', 'production', 'test', 'delivery'] as const;
              const isAllCompleted = selectedTask.status === 'COMPLETED'
                || ORDERED_STAGES.every(k => manualStepChecks[k]?.checked);

              // First stage not yet checked off
              const firstUncheckedIdx = isAllCompleted ? ORDERED_STAGES.length
                : ORDERED_STAGES.findIndex(k => !manualStepChecks[k]?.checked);
              const firstUncheckedKey = (firstUncheckedIdx >= 0 && firstUncheckedIdx < ORDERED_STAGES.length)
                ? ORDERED_STAGES[firstUncheckedIdx] : null;

              // Timeline entry for the current (first unchecked) stage
              const nextStageEntry = firstUncheckedKey
                ? stageTimeline.find(s => s.key === firstUncheckedKey) ?? null : null;

              // Stage is overdue if its planned start is already past and it hasn't been checked yet
              const overdueStage = (!isAllCompleted && nextStageEntry?.start && nextStageEntry.start < today)
                ? nextStageEntry : null;

              // activeStageKey: current stage to highlight in timeline — driven by the
              // backend-reported status (not local checkbox count), so "Tedarik" (0
              // checked steps) can be shown as active once backend reports APPROVED
              // (bkz. order_details.py _STATUS_SELECT_TO_STATE).
              const activeStageKey = (!isAllCompleted && selectedTask.status === 'APPROVED') ? firstUncheckedKey : null;
              // stageCounts still needed for the "sürüyor" badge adet display
              const stageCounts = (selectedTask.stage_counts as Record<string, number> | null) ?? {};


              const promised = parseISO(selectedTask.promisedDate);
              const requirement = parseISO(selectedTask.requirementDate);
              const deadlineRef = promised || requirement;
              const deadlineRiskDays = (deadlineRef && deliveryDate)
                ? Math.round((deliveryDate.getTime() - deadlineRef.getTime()) / DAY_MS)
                : null;
              const hasDeadlineRisk = deadlineRiskDays !== null && deadlineRiskDays > 0;

              // onHandQuantity yalnızca BOM alt ürün (component) görevlerinde dolu gelir
              // (bkz. gantt.py — ana sipariş görevlerinde hep null) — bu yüzden bu alanın
              // varlığı, "Adet"in Teslimat Adedi mi yoksa Üretilecek Miktar mı olduğunun
              // karışmaması için "Elde Mevcut"/"Üretilecek" kartlarını göstermenin güvenli
              // sinyalidir.
              const isComponentTask = selectedTask.onHandQuantity !== null && selectedTask.onHandQuantity !== undefined;
              const onHandQty = isComponentTask ? Number(selectedTask.onHandQuantity) || 0 : 0;
              const neededQty = Number(selectedTask.quantity) || 0;
              const toProduceQty = Math.max(0, neededQty - onHandQty);

              const summaryCards: Array<{ label: string; value: string }> = [
                { label: 'Adet', value: selectedTask.quantityLabel || (selectedTask.quantity != null ? String(selectedTask.quantity) : '—') },
                ...(isComponentTask ? [
                  { label: 'Elde Mevcut', value: `${onHandQty} adet` },
                  { label: 'Üretilecek', value: `${toProduceQty} adet` },
                ] : []),
                { label: 'Üretim Tipi', value: selectedTask.isOutsourced === true ? 'Fason' : selectedTask.isOutsourced === false ? 'İç Üretim' : '—' },
                ...(selectedTask.customerName ? [{ label: 'Müşteri', value: String(selectedTask.customerName) }] : []),
                ...(selectedTask.responsiblePersonnel ? [{ label: 'Sorumlu', value: String(selectedTask.responsiblePersonnel) }] : []),
              ];

              const importantDates: Array<{ label: string; value: Date | null; highlight?: boolean }> = [
                { label: 'Sipariş Tarihi', value: parseISO(selectedTask.orderDate) },
                { label: 'Söz Verilen', value: promised },
                { label: 'Gereksinim', value: requirement },
                { label: 'Cezaya Konu', value: parseISO(selectedTask.penaltyDate) },
                { label: 'Planlanan Teslimat', value: deliveryDate, highlight: true },
              ].filter(d => d.value !== null);

              return (
                <div className="flex flex-col gap-4">
                  {/* Özet kartları */}
                  <div className="grid grid-cols-2 gap-2">
                    {summaryCards.map((c) => (
                      <div key={c.label} className="rounded-xl border border-surface-700/60 bg-surface-900/50 px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-surface-500">{c.label}</div>
                        <div className="mt-0.5 text-sm font-semibold text-white truncate" title={c.value}>{c.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Durum kartı */}
                  {isAllCompleted ? (
                    <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                      <div className="flex items-center gap-3">
                        <span className="text-lg leading-none">✅</span>
                        <div>
                          <div className="text-sm font-bold text-emerald-400">Sipariş tamamlandı</div>
                          <div className="mt-0.5 text-xs rp-text-emerald-soft">
                            Tüm aşamalar teslim edildi{deliveryDate ? ` · ${formatDMY(deliveryDate)}` : ''}.
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : overdueStage ? (
                    <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-lg leading-none">🏭</span>
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-red-400">
                            {(STAGE_TIMELINE_META[overdueStage.key]?.label ?? overdueStage.key)} başlangıcı gecikmiş
                          </div>
                          <div className="mt-1 text-xs rp-text-red-soft">
                            {`${STAGE_TIMELINE_META[overdueStage.key]?.label ?? overdueStage.key} aşamasına en geç ${formatDMY(overdueStage.start)} başlanmalıydı — plan riskte.`}
                          </div>
                        </div>
                      </div>
                      {hasDeadlineRisk && (
                        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium rp-text-red-soft">
                          ⚠ Planlanan teslimat, {promised ? 'söz verilen' : 'gereksinim'} tarihinden {deadlineRiskDays} gün sonra.
                        </div>
                      )}
                    </div>
                  ) : activeStageKey ? (
                    <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-lg leading-none">⚙️</span>
                        <div className="min-w-0">
                          <div className="text-sm font-bold rp-text-cyan">
                            {STAGE_TIMELINE_META[activeStageKey]?.label ?? activeStageKey} aşaması sürüyor
                          </div>
                          <div className="mt-1 text-xs rp-text-cyan-soft">
                            {firstUncheckedIdx} önceki aşama tamamlandı
                            {deliveryDate ? ` · Planlanan teslimat ${formatDMY(deliveryDate)}` : ''}.
                          </div>
                        </div>
                      </div>
                      {hasDeadlineRisk && (
                        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium rp-text-red-soft">
                          ⚠ Planlanan teslimat, {promised ? 'söz verilen' : 'gereksinim'} tarihinden {deadlineRiskDays} gün sonra.
                        </div>
                      )}
                    </div>
                  ) : supplyStart ? (
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-lg leading-none">🏭</span>
                        <div className="min-w-0">
                          <div className="text-sm font-bold rp-text-amber">Tedariğe en geç başlama</div>
                          <div className="mt-1 text-xs rp-text-amber-soft">
                            {`Teslimata yetişmek için tedariğe en geç ${formatDMY(supplyStart)} tarihinde başlanmalı.`}
                          </div>
                        </div>
                      </div>
                      {hasDeadlineRisk && (
                        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium rp-text-red-soft">
                          ⚠ Planlanan teslimat, {promised ? 'söz verilen' : 'gereksinim'} tarihinden {deadlineRiskDays} gün sonra.
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Fason bilgi satırı */}
                  {(selectedTask as any).isOutsourced === true && (
                    <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs rp-text-amber-soft">
                      <span>🏭</span>
                      <span>Bu sipariş fason (dış dizgi) üretimdir.</span>
                    </div>
                  )}

                  {/* Önemli tarihler */}
                  {importantDates.length > 0 && (
                    <div className="rounded-2xl border border-surface-700/60 bg-surface-900/40 p-4">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500 mb-3">Önemli Tarihler</div>
                      <div className="flex flex-col gap-2">
                        {importantDates.map((d) => (
                          <div key={d.label} className="flex items-center justify-between gap-3 text-sm">
                            <span className="text-surface-400">{d.label}</span>
                            <span className={d.highlight ? 'font-semibold rp-text-cyan' : 'text-white'}>{formatDMY(d.value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Aşama zaman çizelgesi */}
                  {stageTimeline.length > 0 && (
                    <div className="rounded-2xl border border-surface-700/60 bg-surface-900/40 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-surface-500">Aşama Zaman Çizelgesi</div>
                        {supplyStart && deliveryDate && (
                          <div className="text-[11px] font-medium text-surface-300">{formatDM(supplyStart)} → {formatDM(deliveryDate)}</div>
                        )}
                      </div>
                      <div className="flex flex-col">
                        {stageTimeline.map((s, idx) => {
                          const isFasonAssembly = s.key === 'assembly' && (selectedTask as any).isOutsourced === true;
                          const meta = isFasonAssembly
                            ? { label: 'Fason (Dış Dizgi)', dot: 'bg-amber-400' }
                            : (STAGE_TIMELINE_META[s.key] || { label: s.key, dot: 'bg-surface-500' });
                          const isLastStage = idx === stageTimeline.length - 1;
                          const stageCount = stageCounts[s.key] || 0;
                          const isActiveStage = !isAllCompleted && s.key === activeStageKey;
                          // Done: checked off in manual step tracking OR all completed
                          const isDoneStage = isAllCompleted || Boolean(manualStepChecks[s.key as ManualStepKey]?.checked);
                          // Overdue: this is the first unchecked stage and its start is past
                          const isOverdueStage = !isDoneStage && s.key === firstUncheckedKey && !!overdueStage;
                          return (
                            <div key={s.key} className={`flex gap-3 ${isDoneStage ? 'opacity-50' : ''}`}>
                              <div className="flex flex-col items-center">
                                {isDoneStage ? (
                                  <span className="mt-1 h-3 w-3 flex-none rounded-full bg-emerald-500 flex items-center justify-center text-[8px] rp-badge-white-text">✓</span>
                                ) : isOverdueStage ? (
                                  <span className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full bg-red-500" />
                                ) : (
                                  <span className={`mt-1.5 h-2.5 w-2.5 flex-none rounded-full ${isActiveStage ? 'ring-2 ring-offset-1 rp-ring-offset ring-cyan-400 ' : ''}${meta.dot}`} />
                                )}
                                {!isLastStage && <span className="w-px flex-1 bg-surface-700 mt-1" />}
                              </div>
                              <div className={`min-w-0 flex-1 ${isLastStage ? '' : 'pb-3'}`}>
                                <div className={`text-sm font-semibold ${isActiveStage ? 'rp-text-cyan' : isOverdueStage ? 'text-red-400' : isDoneStage ? 'text-surface-400' : 'text-white'}`}>
                                  {meta.label}
                                  {isActiveStage && stageCount > 0 && (
                                    <span className="ml-1.5 text-[10px] font-normal rp-text-cyan-soft">({stageCount} adet)</span>
                                  )}
                                  {isOverdueStage && (
                                    <span className="ml-1.5 text-[10px] font-normal text-red-400/80">gecikmiş</span>
                                  )}
                                </div>
                                <div className="text-xs text-surface-400">{formatDM(s.start)} – {formatDM(s.end)}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between text-[11px] text-surface-500 pt-1">
                    <span>Oluşturan: <span className="text-surface-300">{selectedTask.createdByUsername || '—'}</span></span>
                    <span>Son: <span className="text-surface-300">{selectedTask.lastInteractedByUsername || '—'}</span></span>
                  </div>
                </div>
              );
            })()}

            <div className="mt-8 pt-4 border-t border-surface-700">
              <div className="flex justify-between items-center mb-3 text-sm">
                <h5 className="font-semibold">Seri Numaraları</h5>
                <span className="rounded-full bg-surface-900 px-2.5 py-1 text-xs text-surface-300 border border-surface-700">
                  Toplam Seri Numarası: {parsedSerialNumbers.length}
                </span>
              </div>

              {serialLoading ? (
                <div className="text-surface-400 text-xs">Yükleniyor...</div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      className="flex-1 bg-surface-900 border border-surface-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-surface-500 focus:border-primary-500 outline-none disabled:opacity-70"
                      placeholder="Seri numarası girin..."
                      value={serialInput}
                      onChange={e => setSerialInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddSerial(); } }}
                      disabled={!canManageSelectedTask || serialSubmitting}
                    />
                    <button
                      type="button"
                      onClick={handleAddSerial}
                      disabled={!canManageSelectedTask || serialSubmitting || !serialInput.trim()}
                      className="btn-primary px-3 py-2 text-sm"
                    >
                      +
                    </button>
                  </div>

                  {serialTags.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {serialTags.map((sn, i) => (
                        <span
                          key={`${sn}-${i}`}
                          className="inline-flex items-center gap-1.5 bg-surface-800 border border-surface-700 rounded-lg px-2.5 py-1.5 text-sm text-surface-200 max-w-full"
                        >
                          <span className="truncate max-w-[180px]">{sn}</span>
                          {canManageSelectedTask && (
                            <button
                              type="button"
                              onClick={() => handleRemoveSerial(i)}
                              disabled={serialSubmitting}
                              className="text-red-400 hover:text-red-300 transition-colors leading-none text-base shrink-0"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 text-xs text-surface-400">
                    <span>
                      {serialTags.length > 0
                        ? `${serialTags.length} seri numarası`
                        : 'Henüz seri numarası yok.'}
                    </span>
                    {canManageSelectedTask && (
                      <button
                        type="button"
                        className="btn-primary px-3 py-1.5 text-xs"
                        onClick={async () => { await saveSerialNumbers(); onUpdate(); }}
                        disabled={serialSubmitting}
                      >
                        {serialSubmitting ? 'Kaydediliyor...' : 'Seri Numaralarını Kaydet'}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {serialError && <div className="text-red-400 text-xs mt-2">{serialError}</div>}
            </div>

            {/* Notes Section */}
            <div className="mt-8 pt-4 border-t border-surface-700">
              <div className="flex justify-between items-center mb-3 text-sm">
                <h5 className="font-semibold">Notlar</h5>
                <span className="text-surface-400">{deliveryNotes.length} not</span>
              </div>
              
              <div className="flex flex-col gap-3 mb-4 max-h-[300px] overflow-y-auto pr-1">
                {notesLoading ? (
                  <div className="text-surface-400 text-xs">Yükleniyor...</div>
                ) : deliveryNotes.length === 0 ? (
                  <div className="text-surface-400 text-xs">Henüz not yok.</div>
                ) : (
                  deliveryNotes.map(note => (
                    <div key={note.id} className="bg-surface-900 rounded p-2 text-sm border border-surface-700">
                      <div className="flex justify-between text-xs text-surface-400 mb-1">
                        <span>{note.created_by_username || 'Bilinmeyen'}</span>
                        <div className="flex gap-2 items-center">
                          <span>{new Date(note.created_at).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          {canManageNote(note) && (
                            <>
                              <button type="button" className="text-primary-400 hover:text-primary-300" onClick={() => handleNoteEditStart(note)}>Düz</button>
                              <button type="button" className="text-red-400 hover:text-red-300" onClick={() => handleNoteDelete(note.id)}>Sil</button>
                            </>
                          )}
                        </div>
                      </div>
                      {editingNoteId === note.id ? (
                        <div className="mt-1">
                          <textarea className="w-full bg-surface-800 border border-surface-600 rounded p-1.5 text-xs text-white" rows={2} value={editingNoteDraft} onChange={e => setEditingNoteDraft(e.target.value)} />
                          <div className="flex justify-end gap-1 mt-1">
                            <button type="button" className="btn-ghost !px-2 !py-1 text-[10px]" onClick={handleNoteEditCancel}>Vazgeç</button>
                            <button type="button" className="btn-primary !px-2 !py-1 text-[10px]" onClick={handleNoteEditSave} disabled={notesSubmitting}>Kaydet</button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-surface-200">{note.content}</p>
                      )}
                    </div>
                  ))
                )}
              </div>

              <div className="mt-2 flex flex-col gap-2">
                <textarea className="w-full bg-surface-900 border border-surface-700 rounded p-2 text-sm text-white focus:border-primary-500 outline-none" rows={2} placeholder="Not yazın..." value={noteDraft} onChange={e => setNoteDraft(e.target.value)} />
                <button type="button" className="btn-primary self-end px-3 py-1.5 text-xs" onClick={handleNoteSubmit} disabled={notesSubmitting}>
                  {notesSubmitting ? 'Ekleniyor...' : 'Not Ekle'}
                </button>
              </div>
              {notesError && <div className="text-red-400 text-xs mt-2">{notesError}</div>}
            </div>

            {detailError && <div className="text-red-400 text-sm mt-4 p-2 bg-red-400/10 rounded">{detailError}</div>}
          </>
        )}
      </div>
    </div>
    {previewGroup && (
      <OrderDetailModal
        group={previewGroup}
        components={previewComponents}
        columns={previewColumns}
        focusSplitId={previewSplitId}
        onClose={() => setPreviewGroup(null)}
        onSaved={async () => { await Promise.all([openPreview(), reloadManualSteps()]); onUpdate(); }}
        // Sipariş/parça silindiğinde (ya da bölünüp orijinal split_id geçersiz
        // kaldığında): artık var olmayan bu görev için önizleme/manuel adım
        // durumunu yeniden çekmeye ÇALIŞMA (her zaman başarısız olup "yüklenemedi"
        // hatası gösterirdi, silme İŞLEMİ başarılı olsa bile) — bunun yerine
        // görev listesini tazele ve paneli tamamen kapat (seçili görev zaten yok).
        onDeleted={async () => { onUpdate(); onClose(); }}
        backdropOpaque
      />
    )}
    </>
  );
}
