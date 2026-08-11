import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api';
import { getApiErrorMessage } from '../lib/errorMessage';
import OrderDetailModal from '../components/OrderDetailModal';
import CreateDeliveryModal, { type ProductInfoItem } from '../components/CreateDeliveryModal';
import QuickAddDeliveryWizard from '../components/QuickAddDeliveryWizard';
import { useAuth } from '../contexts/AuthContext';

export type CellValue = string | number | boolean | Record<string, unknown> | unknown[] | null | undefined;

export interface OrderDetailRow {
  order_id: string;
  external_id: string;
  status: string;
  current_step_key?: string | null;
  order_status?: string;
  order_current_step_key?: string | null;
  total_quantity?: number | null;
  customer_name: string | null;
  responsible_personnel: string | null;
  order_date: string | null;
  promised_date: string | null;
  requirement_date: string | null;
  penalty_date: string | null;
  mapping_template_id: string;
  mapping_template_name: string | null;
  created_by: string;
  created_by_username: string | null;
  order_is_deleted: boolean;
  order_deleted_at: string | null;
  order_created_at: string;
  order_updated_at: string;
  split_id: string | null;
  split_quantity: number | null;
  split_on_hand_quantity?: number | null;
  split_start_date: string | null;
  split_end_date: string | null;
  split_promised_date: string | null;
  split_manual_edit: boolean | null;
  split_is_deleted: boolean | null;
  split_deleted_at: string | null;
  split_created_at: string | null;
  split_updated_at: string | null;
  split_is_outsourced?: boolean;
  has_splits?: boolean;
  split_count?: number;
  has_custom_schedule?: boolean;
  base_data: Record<string, CellValue>;
  parent_order_id?: string | null;
  component_product_id?: string | null;
  // Bir alt ürün (BOM bileşeni) parçasının bağlı olduğu ANA parça. Kaydedince
  // bileşenlerin adedi bu bağ üzerinden orantılı ölçeklendiği için, düzenleme
  // ekranı ÖNİZLEMEDE de aynı ölçeklemeyi gösterebilsin diye gerekli.
  source_main_split_id?: string | null;
}

interface OrderDetailsResponse {
  rows: OrderDetailRow[];
  total_orders: number;
  total_rows: number;
  base_data_keys: string[];
}

export type InputType = 'text' | 'number' | 'date' | 'boolean' | 'status';

export interface Column {
  key: string;
  label: string;
  getValue: (row: OrderDetailRow) => CellValue;
  getRawValue: (row: OrderDetailRow) => CellValue;
  editable: boolean;
  inputType: InputType;
  // 'split_base_data': üretim parametreleri (Dizgi gün, Test dakikaları vb.) —
  // parçaya özel geçersiz kılma yazar (eksikse sipariş-geneli değerden miras
  // alınır), sıradan 'base_data' (product_name gibi) ise hep
  // sipariş genelinde kalır.
  recordType: 'order' | 'split' | 'base_data' | 'split_base_data';
  fieldKey: string;
  sticky?: boolean;
}

export const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Beklemede',
  APPROVED: 'Devam Ediyor',
  COMPLETED: 'Tamamlandı',
};

const STEP_LABELS: Record<string, string> = {
  supply: 'Tedarik',
  assembly: 'Dizgi',
  production: 'Üretim',
  test: 'Test',
  delivery: 'Teslimat',
};

// "Durum" dropdown'unun seçenekleri — manuel adım takibindeki gerçek durumlarla
// bire bir eşleşir (bkz. backend order_details.py _STATUS_SELECT_TO_STATE).
export const STATUS_STEP_OPTIONS: { value: string; label: string }[] = [
  { value: 'PENDING', label: STATUS_LABELS.PENDING },
  { value: 'supply', label: STEP_LABELS.supply },
  { value: 'assembly', label: STEP_LABELS.assembly },
  { value: 'production', label: STEP_LABELS.production },
  { value: 'test', label: STEP_LABELS.test },
  { value: 'delivery', label: STEP_LABELS.delivery },
  { value: 'COMPLETED', label: STATUS_LABELS.COMPLETED },
];

const STEP_ORDER = ['supply', 'assembly', 'production', 'test', 'delivery'] as const;

// Kullanıcı dropdown'dan bir adım seçtiğinde "bu adım bitti mi, sürüyor mu"
// belirsizliğini gidermek için: seçilen adım her zaman "az önce biten adımdan
// sonra hâlâ sürmekte olan" adımdır (ör. "Dizgi" seçmek "Tedarik bitti, Dizgi
// sürüyor" demektir, "Dizgi bitti" değil).
export const statusStepExplanation = (value: string): string => {
  if (value === 'PENDING') return 'Sipariş henüz başlamadı.';
  if (value === 'COMPLETED') return 'Tüm adımlar tamamlandı.';
  const idx = STEP_ORDER.indexOf(value as (typeof STEP_ORDER)[number]);
  if (idx === -1) return '';
  const current = STEP_LABELS[STEP_ORDER[idx]];
  if (idx === 0) return `${current} sürüyor.`;
  const previous = STEP_LABELS[STEP_ORDER[idx - 1]];
  return `${previous} bitti, ${current} sürüyor.`;
};

export const statusDisplayLabel = (row: Pick<OrderDetailRow, 'status' | 'current_step_key'>): string => {
  if (row.status === 'APPROVED' && row.current_step_key) {
    return STEP_LABELS[row.current_step_key] ?? STATUS_LABELS[row.status];
  }
  return STATUS_LABELS[row.status] ?? row.status;
};

const STATUS_META: Record<string, { badgeClass: string; dot: string; rail: string }> = {
  PENDING: { badgeClass: 'badge-warning', dot: 'bg-amber-400', rail: 'border-l-amber-500/70' },
  APPROVED: { badgeClass: 'badge-info', dot: 'bg-primary-400', rail: 'border-l-primary-500/70' },
  COMPLETED: { badgeClass: 'badge-success', dot: 'bg-emerald-400', rail: 'border-l-emerald-500/70' },
};

export const statusMeta = (status: string) => STATUS_META[status] ?? { badgeClass: 'badge-info', dot: 'bg-surface-400', rail: 'border-l-surface-600' };

export const BASE_DATA_COLUMN_KEYS = new Set([
  'product_name',
  'supply_days',
  'assembly_days',
  'production_days',
  'epoxy_minutes',
  'conformal_minutes',
  'montaj_minutes',
  'quality_minutes',
  'montaj_kalite_minutes',
  'test1_minutes',
  'test2_minutes',
  'final_test_minutes',
  'delivery_days',
  'is_outsourced',
  'production_mode',
]);

export const READ_ONLY_COLUMN_KEYS = new Set([
  'external_id',
  'mapping_template_id',
  'mapping_template_name',
  'created_by',
  'created_by_username',
  'order_created_at',
  'order_updated_at',
  'order_is_deleted',
  'order_deleted_at',
  'split_is_deleted',
  'split_deleted_at',
  'split_created_at',
  'split_updated_at',
  'split_manual_edit',
]);

// Teslimat başlangıç/bitiş alanları backend'de datetime; saat kısmı hep gece
// yarısı olduğu için ekranda yalnızca saat dilimi kayması olarak görünüyordu
// ("04.12.2026 03:00"). Anlamı olmayan bu saati göstermemek için tarih kısmı
// ayrıştırılır — formatCell "T" içermeyen değerleri zaten saatsiz biçimlendirir.
// Yalnızca GÖRÜNTÜLEME içindir; düzenleme getRawValue üzerinden ham değeri
// kullanmaya devam eder.
const toDateOnly = (value: CellValue): CellValue => {
  if (typeof value !== 'string') return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : value;
};

export const CORE_COLUMNS: Column[] = [
  // Kimlik ve durum — ilk bakışta görünmesi gereken en önemli bilgiler.
  { key: 'external_id', label: 'Sipariş No', getValue: (row) => row.external_id, getRawValue: (row) => row.external_id, editable: false, inputType: 'text', recordType: 'order', fieldKey: 'external_id', sticky: true },
  {
    key: 'status',
    label: 'Durum',
    getValue: (row) => statusDisplayLabel(row),
    // Dropdown'da seçili değer, manuel adım takibindeki granüler durumla (hangi
    // adımda olduğuyla) eşleşsin diye — sadece "Devam Ediyor" gibi belirsiz bir
    // genel değer değil.
    getRawValue: (row) => (row.status === 'APPROVED' && row.current_step_key ? row.current_step_key : row.status),
    editable: true,
    inputType: 'status',
    recordType: 'order',
    fieldKey: 'status',
  },
  { key: 'product_name', label: 'Ürün Adı', getValue: (row) => row.base_data.product_name || row.base_data.product_code || row.external_id, getRawValue: (row) => row.base_data.product_name || row.base_data.product_code || row.external_id, editable: true, inputType: 'text', recordType: 'base_data', fieldKey: 'product_name' },
  { key: 'customer_name', label: 'Müşteri', getValue: (row) => row.customer_name, getRawValue: (row) => row.customer_name, editable: true, inputType: 'text', recordType: 'order', fieldKey: 'customer_name' },
  { key: 'split_quantity', label: 'Adet', getValue: (row) => row.split_quantity, getRawValue: (row) => row.split_quantity, editable: true, inputType: 'number', recordType: 'split', fieldKey: 'quantity' },
  // Kritik tarihler — planlama kararları için gerekli.
  { key: 'promised_date', label: 'Söz Verilen Tarih (Bütün Sipariş)', getValue: (row) => row.promised_date, getRawValue: (row) => row.promised_date, editable: true, inputType: 'date', recordType: 'order', fieldKey: 'promised_date' },
  { key: 'requirement_date', label: 'İhtiyaç Tarihi', getValue: (row) => row.requirement_date, getRawValue: (row) => row.requirement_date, editable: true, inputType: 'date', recordType: 'order', fieldKey: 'requirement_date' },
  { key: 'penalty_date', label: 'Ceza Tarihi', getValue: (row) => row.penalty_date, getRawValue: (row) => row.penalty_date, editable: true, inputType: 'date', recordType: 'order', fieldKey: 'penalty_date' },
  { key: 'split_start_date', label: 'Teslimat Başlangıç', getValue: (row) => toDateOnly(row.split_start_date), getRawValue: (row) => row.split_start_date, editable: true, inputType: 'date', recordType: 'split', fieldKey: 'start_date' },
  { key: 'split_end_date', label: 'Teslimat Bitiş', getValue: (row) => toDateOnly(row.split_end_date), getRawValue: (row) => row.split_end_date, editable: true, inputType: 'date', recordType: 'split', fieldKey: 'end_date' },
  // Bu parçaya özel, sabit söz verilen tarih — zaman çizelgesi/parametre/işçi
  // değişikliklerinden ETKİLENMEZ, yalnızca kullanıcı elle değiştirirse güncellenir.
  { key: 'split_promised_date', label: 'Söz Verilen Tarih (Parça)', getValue: (row) => row.split_promised_date, getRawValue: (row) => row.split_promised_date, editable: true, inputType: 'date', recordType: 'split', fieldKey: 'split_promised_date' },
  { key: 'order_date', label: 'Sipariş Tarihi', getValue: (row) => row.order_date, getRawValue: (row) => row.order_date, editable: true, inputType: 'date', recordType: 'order', fieldKey: 'order_date' },
  // İç operasyon bilgisi.
  { key: 'responsible_personnel', label: 'Sorumlu', getValue: (row) => row.responsible_personnel, getRawValue: (row) => row.responsible_personnel, editable: true, inputType: 'text', recordType: 'order', fieldKey: 'responsible_personnel' },
  { key: 'fason_durumu', label: 'Fason', getValue: (row) => row.base_data.production_mode || (row.split_is_outsourced ? 'Fason' : 'İç'), getRawValue: (row) => row.split_is_outsourced, editable: true, inputType: 'boolean', recordType: 'split', fieldKey: 'is_outsourced' },
  { key: 'has_splits', label: 'Parçalı Teslimat', getValue: (row) => row.has_splits ? `Evet (${row.split_count})` : 'Hayır', getRawValue: (row) => row.has_splits, editable: false, inputType: 'boolean', recordType: 'order', fieldKey: 'has_splits' },
  // Üretim planlama parametreleri — nadiren bakılır, gerektiğinde kaydırılarak görülür.
  { key: 'supply_days', label: 'Tedarik (iş günü)', getValue: (row) => row.base_data.supply_days, getRawValue: (row) => row.base_data.supply_days, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'supply_days' },
  { key: 'assembly_days', label: 'Dizgi (iş günü/adet)', getValue: (row) => row.base_data.assembly_days, getRawValue: (row) => row.base_data.assembly_days, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'assembly_days' },
  { key: 'epoxy_minutes', label: 'Epoxy (dk/adet)', getValue: (row) => row.base_data.epoxy_minutes, getRawValue: (row) => row.base_data.epoxy_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'epoxy_minutes' },
  { key: 'conformal_minutes', label: 'Conformal (dk/adet)', getValue: (row) => row.base_data.conformal_minutes, getRawValue: (row) => row.base_data.conformal_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'conformal_minutes' },
  { key: 'montaj_minutes', label: 'Montaj (dk/adet)', getValue: (row) => row.base_data.montaj_minutes, getRawValue: (row) => row.base_data.montaj_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'montaj_minutes' },
  { key: 'quality_minutes', label: 'Kalite (dk/adet)', getValue: (row) => row.base_data.quality_minutes, getRawValue: (row) => row.base_data.quality_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'quality_minutes' },
  { key: 'montaj_kalite_minutes', label: 'M.Kalite (dk/adet)', getValue: (row) => row.base_data.montaj_kalite_minutes, getRawValue: (row) => row.base_data.montaj_kalite_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'montaj_kalite_minutes' },
  { key: 'test1_minutes', label: 'Test1 (dk/adet)', getValue: (row) => row.base_data.test1_minutes, getRawValue: (row) => row.base_data.test1_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'test1_minutes' },
  { key: 'test2_minutes', label: 'Test2 (dk/adet)', getValue: (row) => row.base_data.test2_minutes, getRawValue: (row) => row.base_data.test2_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'test2_minutes' },
  { key: 'final_test_minutes', label: 'F.Test (dk/adet)', getValue: (row) => row.base_data.final_test_minutes, getRawValue: (row) => row.base_data.final_test_minutes, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'final_test_minutes' },
  { key: 'delivery_days', label: 'Teslimat (iş günü)', getValue: (row) => row.base_data.delivery_days, getRawValue: (row) => row.base_data.delivery_days, editable: true, inputType: 'number', recordType: 'split_base_data', fieldKey: 'delivery_days' },
  // Kayıt/denetim bilgisi — en az ihtiyaç duyulan, en sonda.
  { key: 'created_by_username', label: 'Oluşturan', getValue: (row) => row.created_by_username, getRawValue: (row) => row.created_by_username, editable: false, inputType: 'text', recordType: 'order', fieldKey: 'created_by_username' },
  { key: 'order_created_at', label: 'Kayıt Tarihi', getValue: (row) => row.order_created_at, getRawValue: (row) => row.order_created_at, editable: false, inputType: 'text', recordType: 'order', fieldKey: 'order_created_at' },
  { key: 'order_updated_at', label: 'Güncelleme Tarihi', getValue: (row) => row.order_updated_at, getRawValue: (row) => row.order_updated_at, editable: false, inputType: 'text', recordType: 'order', fieldKey: 'order_updated_at' },
];

// "Basit Görünüm" açıkken tabloda kalan kolonlar: yalnızca başlangıç/bitiş
// tarihleri — artı satırın hangi siparişe/ürüne ait olduğunu gösteren kimlik
// kolonları. Kimlik olmadan tablo okunamaz hale gelirdi.
// NOT: yalnızca TABLONUN görünümünü etkiler; arama, CSV dışa aktarma ve
// düzenleme penceresi tüm kolonlar üzerinden çalışmaya devam eder.
// Sıra CORE_COLUMNS'tan gelir (filtre sırayı korur), bu yüzden
// split_quantity otomatik olarak Ürün Adı ile Teslimat Başlangıç arasına düşer.
// NOT: split_quantity kolonu sipariş (grup) satırında toplam sipariş adedini,
// teslimat satırlarında ise o parçanın adedini gösterir — bkz. renderKalemRow.
export const SIMPLE_VIEW_COLUMN_KEYS = new Set([
  'external_id',
  'product_name',
  'split_quantity',
  'split_start_date',
  'split_end_date',
]);

export interface OrderGroup {
  orderId: string;
  externalId: string;
  entries: { row: OrderDetailRow; rowIndex: number }[];
}

interface SiparisGroup {
  externalId: string;
  kalemler: OrderGroup[];
}

export const formatCell = (value: CellValue) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  if (typeof value === 'object') return JSON.stringify(value);
  // Sipariş-seviyesi tarih alanları (order_date/promised_date/requirement_date/
  // penalty_date) backend'de saf `date` kolonu — "T" içermeyen düz "YYYY-MM-DD"
  // olarak serileşir. Regex eskiden yalnızca "T"li datetime'ları yakalıyordu, bu
  // yüzden bu alanlar hiç yerelleştirilmeden ham ISO string olarak görünüyordu
  // (aynı satırdaki split-seviyesi datetime alanlarının aksine). Saat/dakika
  // bilgisi olmayan bir tarihte saat göstermek yanıltıcı olacağı için "T" var mı
  // yoksa formata göre ayrı biçimlendiriliyor.
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) {
    const hasTime = value.includes('T');
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString(
        'tr-TR',
        hasTime
          ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
          : { day: '2-digit', month: '2-digit', year: 'numeric' },
      );
    }
  }
  return value;
};

const csvEscape = (value: string) => {
  if (/[",\n;]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

export default function OrderDetailsPage() {
  const [rows, setRows] = useState<OrderDetailRow[]>([]);
  const [baseDataKeys, setBaseDataKeys] = useState<string[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [query, setQuery] = useState('');
  // Basit Görünüm: tabloyu yalnızca kimlik + başlangıç/bitiş tarihlerine indirger.
  const [isSimpleView, setIsSimpleView] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [collapsedOrders, setCollapsedOrders] = useState<Set<string>>(new Set());
  const [collapsedSiparisler, setCollapsedSiparisler] = useState<Set<string>>(new Set());
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  // Belirli bir parça satırına (Parça N) tıklanınca dolar — modal, tüm parçaları
  // değil YALNIZCA tıklanan parçayı listeler (kullanıcı hangi parçayı düzenlediğini
  // şaşırmasın diye). Parça-özel olmayan bir yerden açılınca (kalem başlığı vb.)
  // null kalır ve modal her zamanki gibi tüm parçaları listeler.
  const [activeSplitId, setActiveSplitId] = useState<string | null>(null);

  // --- "+ Teslimat" — Teslimat Takvimi'ndeki akışın AYNISI ---
  // Aynı iki modal kullanılır: hızlı sihirbaz ve (yeni ürün / abonelik gerekince)
  // sihirbazın 1. adımından açılan gelişmiş form.
  const { user } = useAuth();
  const canCreateDelivery = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isAdvancedCreateModalOpen, setIsAdvancedCreateModalOpen] = useState(false);
  const [productInfos, setProductInfos] = useState<ProductInfoItem[]>([]);
  const [isLoadingProductInfos, setIsLoadingProductInfos] = useState(false);
  const [holidayKeySet, setHolidayKeySet] = useState<Set<string>>(new Set());
  // Ürün ve tatil listeleri YALNIZCA modal ilk kez açılınca çekilir: bu sayfanın
  // kendi tablosu bu verilere ihtiyaç duymuyor, sayfa açılışına iki ağ isteği
  // eklemenin anlamı yok.
  const createDataLoadedRef = useRef(false);

  const loadCreateDeliveryData = useCallback(async () => {
    if (createDataLoadedRef.current) return;
    createDataLoadedRef.current = true;
    setIsLoadingProductInfos(true);
    try {
      const [productsRes, holidaysRes] = await Promise.allSettled([
        api.get<ProductInfoItem[]>('/product-info/'),
        api.get('/holidays/'),
      ]);
      if (productsRes.status === 'fulfilled' && Array.isArray(productsRes.value.data)) {
        setProductInfos(productsRes.value.data);
      } else {
        // Tekrar denenebilsin diye "yüklendi" işareti geri alınır.
        createDataLoadedRef.current = false;
      }
      if (holidaysRes.status === 'fulfilled' && Array.isArray(holidaysRes.value.data)) {
        setHolidayKeySet(new Set(
          holidaysRes.value.data
            .filter((h: any) => h?.is_active)
            .map((h: any) => String(h.holiday_date)),
        ));
      }
    } finally {
      setIsLoadingProductInfos(false);
    }
  }, []);

  const handleCreateDelivery = useCallback(() => {
    setIsCreateModalOpen(true);
    void loadCreateDeliveryData();
  }, [loadCreateDeliveryData]);

  // Taze satirlari DONDURUR: cagiran, state guncellemesini beklemeden (React
  // state'i senkron gorunmez) yeni kayitlar uzerinde islem yapabilsin diye —
  // bkz. "+ Teslimat" sonrasi "Detayları Düzenle".
  const fetchOrderDetails = useCallback(async (): Promise<OrderDetailRow[]> => {
    try {
      setIsLoading(true);
      const { data } = await api.get<OrderDetailsResponse>('/order-details/');
      setRows(data.rows);
      setBaseDataKeys(data.base_data_keys);
      setTotalOrders(data.total_orders);
      setTotalRows(data.total_rows);
      setError('');
      return data.rows;
    } catch (err) {
      setError(getApiErrorMessage(err, 'Sipariş detayları yüklenemedi.'));
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrderDetails();
  }, [fetchOrderDetails]);

  const allColumns = useMemo<Column[]>(() => {
    const dynamicColumns = baseDataKeys
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
    return [...CORE_COLUMNS, ...dynamicColumns];
  }, [baseDataKeys]);

  // Tabloda ÇİZİLEN kolonlar. Basit görünümde yalnızca kimlik + başlangıç/bitiş
  // tarihleri kalır; arama ve düzenleme penceresi ise allColumns'u kullanmaya
  // devam eder, böylece basit görünümde de her alan aranabilir/düzenlenebilir.
  const columns = useMemo<Column[]>(
    () => (isSimpleView ? allColumns.filter((column) => SIMPLE_VIEW_COLUMN_KEYS.has(column.key)) : allColumns),
    [allColumns, isSimpleView],
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
    return rows.filter((row) => {
      if (!normalizedQuery) return true;
      // Basit görünümde gizlenen kolonlar da aranabilsin diye allColumns.
      return allColumns.some((column) =>
        formatCell(column.getValue(row)).toLocaleLowerCase('tr-TR').includes(normalizedQuery),
      );
    });
  }, [allColumns, query, rows]);

  const kalemGroups = useMemo<OrderGroup[]>(() => {
    const groups = new Map<string, OrderGroup>();
    filteredRows.forEach((row, rowIndex) => {
      let group = groups.get(row.order_id);
      if (!group) {
        group = { orderId: row.order_id, externalId: row.external_id, entries: [] };
        groups.set(row.order_id, group);
      }
      group.entries.push({ row, rowIndex });
    });
    return Array.from(groups.values());
  }, [filteredRows]);

  // BOM bileşen siparişleri (parent_order_id dolu) ana tabloda AYRI SİPARİŞ SATIRI
  // olarak görünmez — bunun yerine ait oldukları ana siparişin kalem satırının hemen
  // altına reçete gibi (renderComponentRow) nested gösterilir, bkz. orderComponentsByParent.
  const visibleKalemGroups = useMemo(
    () => kalemGroups.filter((kalem) => !kalem.entries[0]?.row.parent_order_id),
    [kalemGroups],
  );

  // Bir ana siparişin (orderId) BOM bileşenleri — kalemGroups'tan parent_order_id'ye
  // göre gruplanır. Sipariş Detayları tablosunda ana kalem satırının altına
  // reçete gibi (Bileşen: X — Y adet) sub-row olarak eklenir.
  const orderComponentsByParent = useMemo(() => {
    const map = new Map<string, OrderGroup[]>();
    kalemGroups.forEach((kalem) => {
      const parentId = kalem.entries[0]?.row.parent_order_id;
      if (!parentId) return;
      const list = map.get(parentId) || [];
      list.push(kalem);
      map.set(parentId, list);
    });
    return map;
  }, [kalemGroups]);

  const siparisGroups = useMemo<SiparisGroup[]>(() => {
    const groups = new Map<string, SiparisGroup>();
    visibleKalemGroups.forEach((kalem) => {
      let group = groups.get(kalem.externalId);
      if (!group) {
        group = { externalId: kalem.externalId, kalemler: [] };
        groups.set(kalem.externalId, group);
      }
      group.kalemler.push(kalem);
    });
    return Array.from(groups.values());
  }, [visibleKalemGroups]);

  const toggleOrderCollapsed = useCallback((orderId: string) => {
    setCollapsedOrders((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }
      return next;
    });
  }, []);

  const toggleSiparisCollapsed = useCallback((externalId: string) => {
    setCollapsedSiparisler((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) {
        next.delete(externalId);
      } else {
        next.add(externalId);
      }
      return next;
    });
  }, []);

  // Bir grup (sipariş/kalem/bileşen) kapatılınca, altındaki satırlar DOM'dan
  // kalkıp tablo küçülüyor — özellikle listenin ALT kısımlarındaki bir grubu
  // kapatınca, kaydırma alanının toplam yüksekliği aniden azalıyor ve tarayıcı
  // scrollTop'u yeni (daha küçük) sınıra göre KIRPIYOR, bu da sayfanın kullanıcı
  // hiçbir şey yapmamış gibi aniden yukarı fırlamasına yol açıyordu ("bir şey
  // bozuldu mu?" hissi). Çözüm: tıklanan satırın kapanmadan HEMEN ÖNCEKİ
  // viewport konumunu kaydedip, DOM güncellendikten SONRA (useLayoutEffect —
  // boyama öncesi çalışır, göz kırpma olmaz) AYNI satırı yeniden bulup kaydırma
  // konumunu, o satır ekranda TAM OLARAK AYNI yerde kalacak şekilde düzeltiyoruz.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollAnchorRef = useRef<{ key: string; top: number } | null>(null);

  const toggleWithScrollAnchor = useCallback((rowKey: string, rowEl: HTMLElement, toggleFn: () => void) => {
    pendingScrollAnchorRef.current = { key: rowKey, top: rowEl.getBoundingClientRect().top };
    toggleFn();
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    pendingScrollAnchorRef.current = null;
    const container = scrollContainerRef.current;
    if (!anchor || !container) return;
    const el = container.querySelector(`[data-row-key="${anchor.key}"]`);
    if (!el) return;
    const newTop = el.getBoundingClientRect().top;
    const delta = newTop - anchor.top;
    if (delta !== 0) {
      container.scrollTop += delta;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsedOrders, collapsedSiparisler]);

  const chevron = (isCollapsed: boolean, extraClass = '') => (
    <svg
      className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'} ${extraClass}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );

  const renderStatusBadge = (status: string, currentStepKey?: string | null) => {
    const label = statusDisplayLabel({ status, current_step_key: currentStepKey });
    return <span className={statusMeta(status).badgeClass}>{label}</span>;
  };

  const renderCell = (row: OrderDetailRow, column: Column, suppressed = false) => {
    const value = suppressed ? '' : formatCell(column.getValue(row));

    let cellContent: React.ReactNode = value;

    if (!suppressed && column.key === 'status') {
      const meta = statusMeta(row.status);
      cellContent = <span className={meta.badgeClass}>{value}</span>;
    } else if (!suppressed && column.key === 'has_splits') {
      cellContent = row.has_splits ? (
        <span className="badge-info">{value}</span>
      ) : (
        <span className="text-surface-500">{value}</span>
      );
    }

    return (
      <td
        key={column.key}
        className={`border-b border-r border-surface-800/60 px-3 py-2 max-w-72 truncate whitespace-nowrap ${
          suppressed ? 'text-surface-700' : 'text-surface-300'
        } ${column.sticky ? 'sticky left-0 z-10 bg-surface-950 font-medium text-surface-100' : ''}`}
        title={!suppressed && typeof value === 'string' ? value : undefined}
        style={column.sticky ? { left: 0 } : undefined}
      >
        {suppressed ? '—' : cellContent}
      </td>
    );
  };

  // Seviye 0: sipariş no. Tek kalem/tek teslimat olsa bile hep açılır başlık
  // olarak gösterilir (chevron'lu) — kullanıcı tek parçalı siparişleri de
  // genişletip alt satırı (kalem) görebilsin istiyor, bu yüzden "düz satır"
  // özel durumu kaldırıldı.
  const topLevelRowClass = 'cursor-pointer bg-surface-900/60 hover:bg-primary-500/10 transition-colors';
  const topLevelStickyClass =
    'border-b-2 border-r border-surface-800/60 border-b-primary-500/30 px-3 py-3 sticky left-0 z-10 bg-surface-900 font-semibold text-surface-100 min-w-40';

  // Seviye 2: bir kalemin parçalı teslimatı. Sadece split-özel kolonlar gerçek değer taşır, geri kalanı üstteki kalem satırında zaten gösterildiği için "—".
  const renderSplitRow = (row: OrderDetailRow, rowIndex: number, partIndex: number) => {
    return (
      <tr
        key={`${row.order_id}-${row.split_id || 'order'}-${rowIndex}`}
        onClick={() => {
          setActiveOrderId(row.order_id);
          setActiveSplitId(row.split_id);
        }}
        className="cursor-pointer bg-surface-900/20 hover:bg-primary-500/10 transition-colors"
      >
        {columns.map((column) => {
          if (column.sticky) {
            return (
              <td
                key={column.key}
                className="border-b border-r border-surface-800/60 px-3 py-2 sticky left-0 z-10 bg-surface-950 text-surface-300 min-w-40"
              >
                <span className="pl-9">Parça {partIndex + 1}</span>
              </td>
            );
          }
          // product_name: her parça hangi ürüne ait olduğunu tek bakışta göstersin
          // diye BİLİNÇLİ OLARAK bastırılmaz (üstteki kalem satırında da görünür,
          // ama parça satırları bağımsız taranırken tekrar görülmesi kafa
          // karışıklığını önler) — diğer sipariş-geneli alanlar (tarihler,
          // müşteri vb.) hâlâ bastırılır, zaten üstte gösteriliyor.
          const alwaysShownKeys = new Set(['product_name']);
          return renderCell(
            row,
            column,
            column.recordType !== 'split' &&
              column.recordType !== 'split_base_data' &&
              column.key !== 'status' &&
              !alwaysShownKeys.has(column.key),
          );
        })}
      </tr>
    );
  };

  // BOM bileşeni: ana kalemin hemen altına reçete gibi (Bileşen: X — Y adet) eklenen
  // sub-row. Bileşen aslında kendi başına bir Order+DeliverySplit olduğu için tüm
  // kolonlarda kendi gerçek değerlerini gösterir; sticky kolon "↳ Bileşen: X" ile
  // ana kalemden ayırt edilir. Tıklanınca kendi (bileşenin) düzenleme modalı açılır.
  // Bileşenin KENDİSİ de parçalı teslimata bölünmüşse (component.entries.length > 1),
  // ana kalemdeki (renderKalemRow) ile AYNI desen uygulanır: chevron + "N parça"
  // rozeti, tıklanınca açılıp kapanır — `collapsedOrders`/`toggleOrderCollapsed`
  // component.orderId ile paylaşılır (ana kalemin orderId'sinden farklı bir sipariş
  // olduğu için çakışma olmaz). Önceden yalnızca `entries[0]` gösterilip diğer
  // parçalar hiç render edilmiyordu — bu artık düzeltildi.
  const renderComponentRow = (component: OrderGroup, isCollapsed: boolean) => {
    const { row, rowIndex } = component.entries[0];
    const componentLabel = (row.base_data?.product_name as string) || row.external_id;
    const hasMultipleParts = component.entries.length > 1;
    return (
      <tr
        key={`component-${component.orderId}-${rowIndex}`}
        data-row-key={`component-${component.orderId}`}
        onClick={() => {
          setActiveOrderId(component.orderId);
          setActiveSplitId(null);
        }}
        className="cursor-pointer bg-amber-500/[0.04] hover:bg-amber-500/10 transition-colors"
      >
        {columns.map((column) => {
          if (column.sticky) {
            return (
              <td
                key={column.key}
                className="border-b border-r border-surface-800/60 px-3 py-2 sticky left-0 z-10 bg-surface-950 text-amber-200/80 min-w-40"
              >
                {hasMultipleParts ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleWithScrollAnchor(`component-${component.orderId}`, e.currentTarget.closest('tr') ?? e.currentTarget, () => toggleOrderCollapsed(component.orderId));
                    }}
                    className="flex items-center gap-1.5 text-left w-full group pl-9"
                  >
                    {chevron(isCollapsed, 'text-amber-500/70 group-hover:text-amber-400')}
                    <span className="truncate">{componentLabel}</span>
                    <span className="badge-info shrink-0">{component.entries.length} parça</span>
                  </button>
                ) : (
                  <span className="pl-9 flex items-center gap-1.5">
                    <span className="text-amber-500/70">↳</span>
                    <span className="truncate">{componentLabel}</span>
                  </span>
                )}
              </td>
            );
          }
          return renderCell(row, column, false);
        })}
      </tr>
    );
  };

  // Bileşenin kendi parçası (bileşen de parçalı teslimatsa) — `renderSplitRow`'un
  // bileşen versiyonu, ana kalemin parça satırlarından bir kademe daha girintili.
  const renderComponentSplitRow = (row: OrderDetailRow, rowIndex: number, partIndex: number) => {
    return (
      <tr
        key={`component-split-${row.order_id}-${row.split_id || 'order'}-${rowIndex}`}
        onClick={() => {
          setActiveOrderId(row.order_id);
          setActiveSplitId(row.split_id);
        }}
        className="cursor-pointer bg-amber-500/[0.02] hover:bg-amber-500/10 transition-colors"
      >
        {columns.map((column) => {
          if (column.sticky) {
            return (
              <td
                key={column.key}
                className="border-b border-r border-surface-800/60 px-3 py-2 sticky left-0 z-10 bg-surface-950 text-surface-300 min-w-40"
              >
                <span className="pl-16">Parça {partIndex + 1}</span>
              </td>
            );
          }
          const alwaysShownKeys = new Set(['product_name']);
          return renderCell(
            row,
            column,
            column.recordType !== 'split' &&
              column.recordType !== 'split_base_data' &&
              column.key !== 'status' &&
              !alwaysShownKeys.has(column.key),
          );
        })}
      </tr>
    );
  };

  // Bir kalemin altındaki TÜM bileşenleri (her biri kendi çoklu-parça durumuyla)
  // render eder — iki çağrı noktasında (tek parçalı/çok parçalı kalem) tekrarı
  // önlemek için ortak yardımcı.
  const renderComponentsForKalem = (components: OrderGroup[]) =>
    components.map((component) => {
      const isComponentCollapsed = collapsedOrders.has(component.orderId);
      return (
        <Fragment key={component.orderId}>
          {renderComponentRow(component, isComponentCollapsed)}
          {!isComponentCollapsed && component.entries.length > 1 &&
            component.entries.map(({ row, rowIndex }, partIndex) => renderComponentSplitRow(row, rowIndex, partIndex))}
        </Fragment>
      );
    });

  // Seviye 1: bir kalem (siparişteki ayrı ürün satırı). Splitleri kaç olursa olsun aynı şablon: chevron + ürün adı + teslimat rozeti; order/base_data kolonları gerçek değer, split kolonları "—" (aşağıda açılınca gerçek değeri görünür).
  // Parçalı teslimatı olmayan (tek split'li) kalem: split seviyesine inmeye gerek yok, tüm veri (order+base_data+split) tek satırda gerçek değeriyle gösterilir.
  // Alt ürün (BOM bileşeni) sayısını gösteren rozet — kalem satırının okunun
  // NEYİ gizleyeceğini görünür kılar. Bileşen satırlarıyla aynı amber dili;
  // text-amber-400 bilinçli (açık temada okunur bir tona çevrilen tek amber
  // tonu, bkz. index.css'teki .theme-light [class*='text-amber-400']).
  const altUrunBadge = (count: number) => (
    <span className="badge bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
      {count} alt ürün
    </span>
  );

  // Parçalı teslimatı olmayan kalem. Alt ürünü VARSA kendi oku olur (okun
  // gizlediği tek şey alt ürünlerdir); yoksa hizalamayı korumak için görünmez
  // bir yer tutucu çizilir. Önceden ok hiç yoktu ve alt ürünler koşulsuz
  // gösteriliyordu — yani tek parçalı bir kalemin alt ürünleri hiç
  // gizlenemiyordu.
  const renderKalemFullRow = (kalem: OrderGroup, componentCount: number, isCollapsed: boolean) => {
    const { row } = kalem.entries[0];
    const productColumn = allColumns.find((c) => c.key === 'product_name');
    const productLabel = productColumn ? formatCell(productColumn.getValue(row)) : kalem.externalId;
    const hasComponents = componentCount > 0;
    return (
      <tr
        key={`kalem-${kalem.orderId}`}
        data-row-key={`kalem-${kalem.orderId}`}
        onClick={() => {
          setActiveOrderId(kalem.orderId);
          setActiveSplitId(null);
        }}
        className="cursor-pointer bg-surface-800/40 hover:bg-primary-500/10 transition-colors"
      >
        {columns.map((column) => {
          if (column.sticky) {
            return (
              <td
                key={column.key}
                className="border-b border-r border-surface-800/60 px-3 py-2.5 sticky left-0 z-10 bg-surface-800/90 font-medium text-surface-100 min-w-40"
              >
                {hasComponents ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleWithScrollAnchor(`kalem-${kalem.orderId}`, e.currentTarget.closest('tr') ?? e.currentTarget, () => toggleOrderCollapsed(kalem.orderId));
                    }}
                    className="flex items-center gap-2 text-left w-full group pl-5"
                    title={isCollapsed ? 'Alt ürünleri göster' : 'Alt ürünleri gizle'}
                  >
                    {chevron(isCollapsed, 'text-surface-400 group-hover:text-primary-400')}
                    <span className="truncate">{productLabel || kalem.externalId}</span>
                    {altUrunBadge(componentCount)}
                  </button>
                ) : (
                  <span className="flex items-center gap-2 pl-5">
                    <svg className="w-3.5 h-3.5 shrink-0 invisible" fill="none" viewBox="0 0 24 24">
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="truncate">{productLabel || kalem.externalId}</span>
                  </span>
                )}
              </td>
            );
          }
          return renderCell(row, column, false);
        })}
      </tr>
    );
  };

  const renderKalemRow = (kalem: OrderGroup, isCollapsed: boolean, componentCount: number) => {
    const { row: firstRow } = kalem.entries[0];
    const productColumn = allColumns.find((c) => c.key === 'product_name');
    const productLabel = productColumn ? formatCell(productColumn.getValue(firstRow)) : kalem.externalId;
    return (
      <tr
        key={`kalem-${kalem.orderId}`}
        data-row-key={`kalem-${kalem.orderId}`}
        onClick={() => {
          setActiveOrderId(kalem.orderId);
          setActiveSplitId(null);
        }}
        className="cursor-pointer bg-surface-800/40 hover:bg-primary-500/10 transition-colors"
      >
        {columns.map((column) => {
          if (column.sticky) {
            return (
              <td
                key={column.key}
                className="border-b border-r border-surface-800/60 px-3 py-2.5 sticky left-0 z-10 bg-surface-800/90 font-medium text-surface-100 min-w-40"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleWithScrollAnchor(`kalem-${kalem.orderId}`, e.currentTarget.closest('tr') ?? e.currentTarget, () => toggleOrderCollapsed(kalem.orderId));
                  }}
                  className="flex items-center gap-2 text-left w-full group pl-5"
                  title={
                    componentCount > 0
                      ? (isCollapsed ? 'Parçaları ve alt ürünleri göster' : 'Parçaları ve alt ürünleri gizle')
                      : (isCollapsed ? 'Parçaları göster' : 'Parçaları gizle')
                  }
                >
                  {chevron(isCollapsed, 'text-surface-400 group-hover:text-primary-400')}
                  <span className="truncate">{productLabel || kalem.externalId}</span>
                  <span className="badge-info shrink-0">{kalem.entries.length} parça</span>
                  {/* Bu kalemin oku parçaların YANI SIRA alt ürünleri de gizler;
                      rozet olmadan kullanıcı okun kapsamını göremiyordu. */}
                  {componentCount > 0 && altUrunBadge(componentCount)}
                </button>
              </td>
            );
          }
          if (column.key === 'status') {
            return (
              <td key={column.key} className="border-b border-r border-surface-800/60 px-3 py-2.5 text-surface-300">
                {renderStatusBadge(
                  firstRow.order_status ?? firstRow.status,
                  firstRow.order_status ? firstRow.order_current_step_key : firstRow.current_step_key,
                )}
              </td>
            );
          }
          if (column.key === 'split_quantity') {
            return (
              <td key={column.key} className="border-b border-r border-surface-800/60 px-3 py-2.5 text-surface-300">
                {firstRow.total_quantity ?? '—'}
              </td>
            );
          }
          if (column.recordType === 'order' || column.recordType === 'base_data') {
            return renderCell(firstRow, column, false);
          }
          return renderCell(firstRow, column, true);
        })}
      </tr>
    );
  };

  // Seviye 0: sipariş no. Her zaman aynı şablon; sadece kalem/teslimat sayısını özetler, veri kolonları hep "—".
  const renderSiparisHeaderRow = (siparis: SiparisGroup, isCollapsed: boolean) => {
    const firstRow = siparis.kalemler[0].entries[0].row;
    return (
      <tr
        key={`siparis-${siparis.externalId}`}
        data-row-key={`siparis-${siparis.externalId}`}
        onClick={(e) => toggleWithScrollAnchor(`siparis-${siparis.externalId}`, e.currentTarget, () => toggleSiparisCollapsed(siparis.externalId))}
        className={topLevelRowClass}
      >
        {columns.map((column) => {
          if (column.sticky) {
            return (
              <td key={column.key} className={topLevelStickyClass}>
                <span className="flex items-center gap-2">
                  {chevron(isCollapsed, 'text-primary-400')}
                  <span className="font-mono">{siparis.externalId}</span>
                  <span className="badge bg-primary-500/20 text-primary-300 border border-primary-500/30 shrink-0">
                    {siparis.kalemler.length} teslimat
                  </span>
                </span>
              </td>
            );
          }
          return renderCell(firstRow, column, true);
        })}
      </tr>
    );
  };

  const activeGroup = useMemo(
    () => (activeOrderId ? kalemGroups.find((g) => g.orderId === activeOrderId) ?? null : null),
    [activeOrderId, kalemGroups],
  );

  // Bu siparişin BOM bileşenleri (varsa) — parent_order_id ile bu siparişe bağlı
  // kalemGroups girişleri. Ana tabloda gizlenmiş olsalar da (visibleKalemGroups)
  // burada tam kalemGroups üzerinden aranırlar.
  const activeComponents = useMemo(
    () =>
      activeOrderId
        ? kalemGroups.filter((g) => g.entries[0]?.row.parent_order_id === activeOrderId)
        : [],
    [activeOrderId, kalemGroups],
  );

  const exportCsv = () => {
    // Ekranda ne varsa o dışa aktarılır: Basit Görünüm'de yalnızca o görünümün
    // kolonları, Tüm Alanlar'da hepsi. (`columns` seçili görünüme göre değişir.)
    const header = columns.map((column) => csvEscape(column.label)).join(';');
    const body = filteredRows.map((row) =>
      columns.map((column) => csvEscape(formatCell(column.getValue(row)))).join(';'),
    );
    const blob = new Blob([`\uFEFF${[header, ...body].join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `siparis-detaylari-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full min-h-0 flex flex-col animate-fade-in">
      <div className="px-6 py-5 border-b border-surface-700/50 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Sipariş Detayları</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="badge-info">{totalOrders} sipariş</span>
            <span className="badge bg-surface-800 text-surface-300 border border-surface-700/60">{totalRows} teslimat satırı</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Basit / Tüm Alanlar — yalnızca tablonun kolonlarını değiştirir;
              arama, CSV ve düzenleme penceresi her iki modda da tüm alanları görür. */}
          {/* Takvim header'ındaki Aylık/Yıllık, Özet/Detay anahtarlarıyla AYNI
              kalıp — ortak sınıf (bkz. index.css .calendar-segmented). Renkler
              burada da Tailwind'in sabit koyu tonlarıyla yazılıydı ve açık temada
              okunmuyordu. */}
          <div className="calendar-segmented">
            <button
              type="button"
              onClick={() => setIsSimpleView(false)}
              className={`calendar-segmented-btn ${!isSimpleView ? 'is-active' : ''}`}
            >
              Tüm Alanlar
            </button>
            <button
              type="button"
              onClick={() => setIsSimpleView(true)}
              className={`calendar-segmented-btn ${isSimpleView ? 'is-active' : ''}`}
              title="Yalnızca sipariş/ürün ile başlangıç ve bitiş tarihlerini gösterir."
            >
              Basit Görünüm
            </button>
          </div>
          <button type="button" onClick={exportCsv} className="btn-primary text-sm flex items-center gap-2" disabled={filteredRows.length === 0}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v8m0 0l-3-3m3 3l3-3M4 4h16v5H4z" />
            </svg>
            CSV
          </button>
          {/* Teslimat Takvimi header'ındaki düğmenin AYNISI (bkz.
              CalendarHeader.tsx) — aynı sınıflar, aynı metin, aynı yetki kuralı
              (yalnızca ADMIN/PLANNER); yetkisi olmayanda hiç çizilmez. */}
          {canCreateDelivery && (
            <button
              type="button"
              className="btn-success calendar-header-create !py-1.5 !px-4 !text-sm shadow-glow-success"
              onClick={handleCreateDelivery}
            >
              <span style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>+</span> Teslimat
            </button>
          )}
        </div>
      </div>

      <div className="px-6 py-4 border-b border-surface-800/70">
        <div className="relative max-w-xl">
          <svg className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="input-field pl-10"
            placeholder="Sipariş no, müşteri, ürün ara..."
          />
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <svg className="animate-spin h-8 w-8 text-primary-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-6 pb-6">
          <div className="glass-card h-full overflow-hidden flex flex-col">
            <div className="flex-1 overflow-auto" ref={scrollContainerRef}>
              {/* Tüm alanlar modunda tablo doğal genişliğinde kalır (30 kolon
                  yatayda kaydırılır); basit görünümde 4 kolon kaldığı için
                  kartın solunda sıkışmasın diye genişliğe yayılır. */}
              <table className={`border-collapse text-xs ${isSimpleView ? 'w-full' : 'min-w-max'}`}>
                <thead className="sticky top-0 z-20 bg-surface-900/95 backdrop-blur">
                  <tr>
                    {columns.map((column, index) => (
                      <th
                        key={column.key}
                        className={`border-b-2 border-r border-surface-700/70 border-b-primary-500/20 px-3 py-2.5 text-left font-semibold text-surface-400 text-[11px] uppercase tracking-wide whitespace-nowrap ${
                          column.sticky ? 'sticky left-0 z-30 bg-surface-900/95 min-w-40' : 'min-w-32'
                        }`}
                        style={column.sticky ? { left: 0 } : undefined}
                      >
                        <span className="text-surface-600 mr-2 normal-case">{index + 1}</span>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {siparisGroups.length === 0 && filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={Math.max(columns.length, 1)} className="py-20 text-center">
                        <div className="flex flex-col items-center gap-2 text-surface-500">
                          <svg className="w-9 h-9 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V7a2 2 0 00-2-2H6a2 2 0 00-2 2v6m16 0l-1.5 5.5a2 2 0 01-1.94 1.5H7.44a2 2 0 01-1.94-1.5L4 13m16 0h-4.5a1 1 0 00-.9.56l-.4.88a1 1 0 01-.9.56h-2.6a1 1 0 01-.9-.56l-.4-.88a1 1 0 00-.9-.56H4" />
                          </svg>
                          <span className="text-sm">Gösterilecek kayıt bulunamadı</span>
                          {query && <span className="text-xs text-surface-600">"{query}" için sonuç yok — aramayı temizleyin.</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                  {siparisGroups.map((siparis) => {
                    const isSiparisCollapsed = collapsedSiparisler.has(siparis.externalId);
                    return (
                      <Fragment key={siparis.externalId}>
                        {renderSiparisHeaderRow(siparis, isSiparisCollapsed)}
                        {!isSiparisCollapsed &&
                          siparis.kalemler.map((kalem) => {
                            const components = orderComponentsByParent.get(kalem.orderId) ?? [];
                            const isKalemCollapsed = collapsedOrders.has(kalem.orderId);
                            if (kalem.entries.length <= 1) {
                              // Tek parçalı kalem: parça satırı yok, o yüzden okun
                              // gizlediği tek şey alt ürünlerdir. Alt ürünü yoksa ok
                              // hiç çizilmez (gizleyecek bir şey yok).
                              return (
                                <Fragment key={kalem.orderId}>
                                  {renderKalemFullRow(kalem, components.length, isKalemCollapsed)}
                                  {!isKalemCollapsed && renderComponentsForKalem(components)}
                                </Fragment>
                              );
                            }
                            return (
                              <Fragment key={kalem.orderId}>
                                {renderKalemRow(kalem, isKalemCollapsed, components.length)}
                                {!isKalemCollapsed &&
                                  kalem.entries.map(({ row, rowIndex }, partIndex) => renderSplitRow(row, rowIndex, partIndex))}
                                {!isKalemCollapsed && renderComponentsForKalem(components)}
                              </Fragment>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeGroup && (
        <OrderDetailModal
          group={activeGroup}
          components={activeComponents}
          columns={allColumns}
          focusSplitId={activeSplitId}
          onClose={() => {
            setActiveOrderId(null);
            setActiveSplitId(null);
          }}
          onSaved={() => { void fetchOrderDetails(); }}
        />
      )}

      {/* "+ Teslimat" akışı — Teslimat Takvimi'ndeki renderCreateModal ile aynı
          desen: önce hızlı sihirbaz, oradan "Gelişmiş ekleme" ile tam form.
          Sipariş oluşturulunca bu sayfanın tablosu yenilenir. */}
      {isAdvancedCreateModalOpen && (
        <CreateDeliveryModal
          productInfos={productInfos}
          isLoadingProductInfos={isLoadingProductInfos}
          holidayKeySet={holidayKeySet}
          onClose={() => setIsAdvancedCreateModalOpen(false)}
          onCreated={() => { void fetchOrderDetails(); }}
          onProductCreated={() => {
            // Yeni ürün eklendiyse liste bayatlar; bir sonraki açılışta tazelensin.
            createDataLoadedRef.current = false;
            void loadCreateDeliveryData();
          }}
        />
      )}

      {isCreateModalOpen && !isAdvancedCreateModalOpen && (
        <QuickAddDeliveryWizard
          productInfos={productInfos}
          isLoadingProductInfos={isLoadingProductInfos}
          holidayKeySet={holidayKeySet}
          onClose={() => setIsCreateModalOpen(false)}
          onCreated={() => { void fetchOrderDetails(); }}
          onOpenAdvanced={() => {
            setIsCreateModalOpen(false);
            setIsAdvancedCreateModalOpen(true);
          }}
          // Sihirbazın "Detayları Düzenle" adımı: bu sayfada karşılığı, yeni
          // siparişin düzenleme penceresini açmaktır.
          //
          // DİKKAT — gelen id "split_<uuid>" biçiminde bir PARÇA kimliğidir
          // (bkz. QuickAddDeliveryWizard, backend create_manual_task), bu
          // sayfanın beklediği ise SİPARİŞ kimliği. Öneki kırpıp doğrudan
          // kullanmak yanlış id üretir; parça, taze satırlar içinde bulunup
          // onun order_id'si alınır. Liste yenilenmeden aranırsa yeni kayıt
          // henüz yoktur, bu yüzden fetch'in DÖNDÜĞÜ satırlar kullanılır.
          onEditRequested={async (taskId) => {
            setIsCreateModalOpen(false);
            const splitId = taskId.replace(/^split_/, '');
            const freshRows = await fetchOrderDetails();
            const match = freshRows.find((r) => r.split_id === splitId);
            if (!match) return; // bulunamadıysa liste yine de tazelendi
            setActiveOrderId(match.order_id);
            setActiveSplitId(match.split_id);
          }}
        />
      )}
    </div>
  );
}
