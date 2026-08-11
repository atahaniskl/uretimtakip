import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../lib/api';

import { useAuth } from '../contexts/AuthContext';
import { getApiErrorMessage } from '../lib/errorMessage';
import { computeMonthlyFromMonths, computeMonthsFromMonthly, generateSubscriptionSegments } from '../lib/subscriptionSplit';
import {
  type BlockKey,
  type ScheduleParams,
  assemblyEquivalentDays,
  buildHolidayKeySet,
  computeComponentBlocksForward,
  computeNativeBlockDays,
  computeSuggestedBlocks,
  countWorkdays,
  describeStageSequenceViolation,
  findStageSequenceViolations,
  parseDecimal,
  perUnitEquivalentDays,
} from '../lib/scheduleMath';
import {
  type CellValue,
  type Column,
  type OrderDetailRow,
  type OrderGroup,
  formatCell,
  statusMeta,
  statusDisplayLabel,
  statusStepExplanation,
  STATUS_LABELS,
  STATUS_STEP_OPTIONS,
} from '../pages/OrderDetailsPage';
import StageTimelineEditor, { type BlockAdjustment, type StageTimelineBlock } from './StageTimelineEditor';
import EmployeeCapacityEditor, { type EmployeeCapacityValues } from './EmployeeCapacityEditor';

interface OrderDetailModalProps {
  group: OrderGroup;
  // BOM bilesen siparisleri (bu siparisin alt urunleri) — her biri kendi
  // OrderGroup'u olarak, "Bilesenler" bolumunde ayrica gosterilir/duzenlenir.
  // Bos/undefined ise bilesen yok demektir.
  components?: OrderGroup[];
  columns: Column[];
  // Kullanıcı spreadsheet'te belirli bir parça satırına (Parça N) tıklayarak
  // modalı açtıysa doldurulur — "Ürünler / Teslimatlar" bölümü o zaman TÜM
  // parçaları değil YALNIZCA bunu listeler, kullanıcı hangi parçayı
  // düzenlediğini şaşırmasın diye. Parça-özel olmayan bir yerden açılınca
  // (kalem başlığı vb.) null'dur ve tüm parçalar eskisi gibi listelenir.
  focusSplitId?: string | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  // Sipariş/parça SİLİNDİĞİNDE çağrılır — verilmezse onSaved'e düşer (geriye
  // dönük uyumluluk, ör. OrderDetailsPage'in basit "listeyi yeniden çek" akışı
  // için ayrı bir işleyiciye gerek yok). RightPanel gibi "şu an seçili görev"
  // durumu tutan çağıranların AYRI bir işleyiciye ihtiyacı var: onSaved zaten
  // var olmayan (az önce silinmiş) bir kaynağın önizlemesini/manuel adım
  // durumunu yeniden çekmeye çalışır — bu her zaman başarısız olup kullanıcıya
  // silme İŞLEMİ başarılıyken bile yanıltıcı bir "yüklenemedi" hatası gösterir.
  onDeleted?: () => Promise<void> | void;
  // RightPanel'in "Düzenle" tuşundan açılınca arka plan sipariş detayları
  // sayfasındaki normal açılıştan biraz daha opak gösterilsin diye — yalnızca
  // o giriş noktasına özel, diğer kullanım (OrderDetailsPage) etkilenmez.
  backdropOpaque?: boolean;
}

const fieldInputClass =
  'w-full bg-surface-800/70 border border-surface-700/60 rounded-lg px-3 py-2 text-sm text-surface-100 placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-colors';

// Sayı kutucukları için: yalnızca kısa bir rakam yazılacağı için grid hücresinin
// tamamına uzayan geniş bir kutucuğa gerek yok — sabit, kompakt bir genişlik.
const numberFieldInputClass =
  'w-24 bg-surface-800/70 border border-surface-700/60 rounded-lg px-3 py-2 text-sm text-surface-100 placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-colors';

const fieldLabelClass = 'block text-[11px] uppercase tracking-wide text-surface-500 mb-1.5';

const entryKeyFor = (row: OrderDetailRow, rowIndex: number) => row.split_id ?? `row-${rowIndex}`;

const stripDateSuffix = (iso: string | null | undefined | CellValue): string => {
  if (iso === null || iso === undefined) return '';
  return String(iso).slice(0, 10);
};

const originalString = (row: OrderDetailRow, column: Column): string => {
  const raw = column.getRawValue(row);
  return raw === null || raw === undefined ? '' : String(raw);
};

// Bir bakışta görülmesi gereken temel alanlar; geri kalan (üretim süresi/dakika
// parametreleri gibi nadiren değişen teknik alanlar) "Üretim Parametreleri" altında,
// varsayılan olarak kapalı bir bölmede toplanır — böylece kart onlarca kutucukla dolmaz.
const ESSENTIAL_DETAIL_KEYS = new Set([
  'product_name',
  'split_quantity',
  'split_start_date',
  'split_end_date',
  'fason_durumu',
]);

// Yukarıdaki alanlar 2 sütunluk, dar tutulmuş bir blok üzerine yerleşir:
//   [ Ürün Adı ]           [ Adet ]
//   [ Teslimat Başlangıç ] [ Teslimat Bitiş ]
//   [ Fason ]
// Blok pencerenin tamamına yayılmaz (max-w-2xl): bir ürün adı ya da tarih için
// 300px fazlasıyla yeterli, daha genişi kutucukları gereksiz uzun gösteriyor.
// Sayı/seçim alanları ise sütunun tamamını değil aşağıdaki dar sınırı kullanır —
// satırın SONUNDA durdukları için sağlarında kalan boşluk iki alan arasına düşen
// ölü alan değil, bloğun doğal kenar boşluğudur.
const ESSENTIAL_FIELD_CELL: Record<string, string> = {
  split_quantity: 'max-w-[7rem]',
  fason_durumu: 'max-w-[7rem]',
};

// "Üretim Parametreleri" içindeki, Adet/Gün anahtarının doğrudan etkilediği alanlar
// (dizgi + üretim/test dakika alt-alanları) — bunlar özel gruplanmış render alır;
// geri kalan (Excel'den gelen özel sütunlar) generic listede kalır.
const KNOWN_DURATION_FIELD_KEYS = new Set([
  'assembly_days',
  'quality_minutes',
  'epoxy_minutes',
  'conformal_minutes',
  'montaj_minutes',
  'montaj_kalite_minutes',
  'test1_minutes',
  'test2_minutes',
  'final_test_minutes',
]);

// Backend order_details.py STAGE_BLOCK_LABELS aynası — "Sistem Önerisi" ile
// sıfırdan üretilen blokların etiketleri için kullanılır.
const STAGE_BLOCK_LABELS: Record<BlockKey, string> = {
  supply: 'Tedarik',
  assembly: 'Dizgi',
  production: 'Üretim',
  test: 'Test',
  delivery: 'Teslimat',
};

// Zaman çizelgesi süre hesabına giren üretim parametreleri (base_data anahtarları) —
// bu alanlardan biri düzenlenince ilgili teslimatın blok süreleri canlı yeniden hesaplanır.
// (duration_mode ayrı ele alınır — string enum, sayısal parse'a girmemeli.)
const PARAM_KEYS = [
  'supply_days',
  'assembly_days',
  'production_days',
  'outsource_days',
  'quality_minutes',
  'epoxy_minutes',
  'conformal_minutes',
  'montaj_minutes',
  'montaj_kalite_minutes',
  'test1_minutes',
  'test2_minutes',
  'final_test_minutes',
  'delivery_days',
  'production_flat_days',
  'test_flat_days',
  'assembly_flat_days',
] as const;

// "Üretim Parametreleri" başlığındaki TEK Adet/Gün anahtarı, dizgi+üretim+test'in
// üçünü birden etkiler — kaydetme/dirty-tracking mekanizmasına normal bir alan gibi
// katılması için yerel "sanal" Column tanımı (gerçek veride henüz bu anahtar hiçbir
// siparişte olmayabilir, bu yüzden `columns` prop'undan gelmez).
const DURATION_MODE_COLUMN: Column = {
  key: 'duration_mode',
  label: 'Süre Modu',
  getValue: (row) => row.base_data?.duration_mode ?? null,
  getRawValue: (row) => row.base_data?.duration_mode ?? null,
  editable: true,
  inputType: 'text',
  recordType: 'split_base_data',
  fieldKey: 'duration_mode',
};
const PRODUCTION_FLAT_DAYS_COLUMN: Column = {
  key: 'production_flat_days',
  label: 'Üretim (iş günü, toplam)',
  getValue: (row) => row.base_data?.production_flat_days ?? null,
  getRawValue: (row) => row.base_data?.production_flat_days ?? null,
  editable: true,
  inputType: 'number',
  recordType: 'split_base_data',
  fieldKey: 'production_flat_days',
};
const TEST_FLAT_DAYS_COLUMN: Column = {
  key: 'test_flat_days',
  label: 'Test (iş günü, toplam)',
  getValue: (row) => row.base_data?.test_flat_days ?? null,
  getRawValue: (row) => row.base_data?.test_flat_days ?? null,
  editable: true,
  inputType: 'number',
  recordType: 'split_base_data',
  fieldKey: 'test_flat_days',
};
const ASSEMBLY_FLAT_DAYS_COLUMN: Column = {
  key: 'assembly_flat_days',
  label: 'Dizgi (iş günü, toplam)',
  getValue: (row) => row.base_data?.assembly_flat_days ?? null,
  getRawValue: (row) => row.base_data?.assembly_flat_days ?? null,
  editable: true,
  inputType: 'number',
  recordType: 'split_base_data',
  fieldKey: 'assembly_flat_days',
};
// Her ürün/teslimat kendi üretim sürecini bağımsız ilerletsin diye — sipariş
// genelindeki "status" kolonundan AYRI bir field_key (parçalı siparişlerde
// hepsinin aynı duruma geçmesi hatasını önlemek için). Sanal kolon olarak
// tanımlanır (CORE_COLUMNS'a EKLENMEZ) ki tabloda "Durum" diye ikinci, gereksiz
// bir sütun görünmesin — yalnızca bu modalde, ürün başlığındaki rozetin yerini
// alan düzenlenebilir dropdown için kullanılır.
const SPLIT_STATUS_COLUMN: Column = {
  key: 'split_status',
  label: 'Durum',
  getValue: (row) => statusDisplayLabel(row),
  getRawValue: (row) => (row.status === 'APPROVED' && row.current_step_key ? row.current_step_key : row.status),
  editable: true,
  inputType: 'status',
  recordType: 'split',
  fieldKey: 'split_status',
};
// `columns` prop'unda bulunmayan sanal kolonlar — dirty-tracking/kaydetme (bkz.
// `findColumn`) bu alanları da normal bir alanmış gibi tanıyabilsin diye.
const VIRTUAL_COLUMNS: Column[] = [DURATION_MODE_COLUMN, PRODUCTION_FLAT_DAYS_COLUMN, TEST_FLAT_DAYS_COLUMN, ASSEMBLY_FLAT_DAYS_COLUMN, SPLIT_STATUS_COLUMN];

// Sayıya çevir: null → değer yok; undefined → geçersiz/parse edilemeyen giriş.
const toNumber = (v: CellValue): number | null | undefined => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return null;
  const n = parseDecimal(String(v));
  return Number.isNaN(n) ? undefined : n;
};

interface StepAssignmentRow {
  order_id: string;
  split_id: string | null;
  assembly: number;
  production: number;
  test: number;
  quantity: number | null;
  split_quantity: number | null;
  is_outsourced: boolean;
  // Çoklu-parçalı siparişlerde sipariş-seviyesi (split_id=null) satır sadece
  // gösterim amaçlıdır, gerçek girişi yok (backend "no inputs" olarak işaretliyor) —
  // kapasite kontrolüne bu sahte satır gönderilmemeli.
  has_multiple_splits?: boolean;
}

interface ConcurrencyConflictStep {
  order_id: string;
  split_id: string;
}

interface ConcurrencyConflict {
  date: string;
  total_employees: number;
  max_allowed: number;
  suggestion: string;
  steps: ConcurrencyConflictStep[];
}

export default function OrderDetailModal({ group, components, columns, focusSplitId, onClose, onSaved, onDeleted, backdropOpaque = false }: OrderDetailModalProps) {
  // Eskiden OrderDetailsPage'in kendi hücre-tıklama düzenlemesinde vardı
  // (isEditor = ADMIN/PLANNER), bu modale geçilirken kaldırılmış ve yeniden
  // eklenmemişti — VIEWER rolü backend'in her yazma isteğini zaten 403 ile
  // reddetmesine rağmen arayüzde serbestçe "düzenleyip" kaydetmeyi deneyebiliyordu.
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  const [draft, setDraft] = useState<Map<string, CellValue>>(new Map());
  // Bir bileşen (alt ürün) parçası için "elde zaten mevcut olan miktar" — draft
  // Map'inden AYRI tutulur (senkron mantığı farklı: draft "değişen alan" temsil
  // ederken bu, ABSOLUTE/mutlak bir stok anlık görüntüsüdür). Kalıcı olarak
  // split.on_hand_quantity'de saklanır (bkz. handleSave, field_key:
  // 'on_hand_reduction'); Teslimat Adedi (split.quantity) BUNDAN ASLA etkilenmez —
  // her kayıt, en son girilen mutlak stok miktarını yazar (kümülatif değil).
  // Sunucudaki güncel değerle LAZY init (bir useEffect'te DEĞİL, doğrudan ilk
  // render'da) ön-doldurulur — aksi halde şu sıra sorunu oluşurdu: aşağıdaki
  // "Zaman Çizelgesi canlı senkron" efekti İLK render'da (henüz ön-dolum
  // olmadan, elde-mevcut=0 sayarak) bir taban (prevSpansRef) hesaplar; ardından
  // ayrı bir useEffect elde-mevcut değerini ekleyip yeniden render tetikleyince,
  // canlı senkron efekti bu taban ile YENİ (elde-mevcut düşülmüş) süre arasında
  // sahte bir "değişiklik" görüp otomatik olarak tam bir blok yeniden hesabı
  // (fullReplacement) üretiyor — bu da yalnızca modalı AÇMAKLA "kaydedilmemiş
  // özel program" taslağı oluşmasına (dirtyCount>0, gereksiz "kaydet" uyarısı)
  // yol açıyordu. Lazy init ile taban baştan doğru (elde-mevcut dahil) kurulur,
  // sahte diff hiç oluşmaz.
  const [onHandBySplitId, setOnHandBySplitId] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    [...group.entries, ...(components ?? []).flatMap((c) => c.entries)].forEach(({ row }) => {
      const persisted = row.split_on_hand_quantity;
      if (row.split_id && persisted && persisted > 0) {
        initial[row.split_id] = String(persisted);
      }
    });
    return initial;
  });
  const [stageScheduleDrafts, setStageScheduleDrafts] = useState<Map<string, StageTimelineBlock[]>>(new Map());
  /** Bekleyen taslağı KULLANICININ KENDİ sürüklemesinden gelen parçalar.
   *
   *  `stageScheduleDrafts` sistemin otomatik yeniden hesabıyla da doluyor; ikisi
   *  ayırt edilmezse, adet değiştirildiğinde uygulanan sistem önerisi "elle
   *  düzenleme" sayılıyor ve BİR SONRAKİ değişiklik blokları sıfırdan zincirleyen
   *  tam-değiştirme yerine, her bloğu ayrı ayrı uzatan kısmi ayarlamaya düşüyordu.
   *  Sonuç: Dizgi uzayınca Üretim/Test/Teslimat onun bitişini beklemeden başlıyor,
   *  adımlar üst üste biniyordu. ("20" yazarken ilk hane doğru, ikinci hane bozuk.) */
  const [manualScheduleSplitIds, setManualScheduleSplitIds] = useState<Set<string>>(new Set());
  // StageTimelineEditor'ün onBlocksChange ile bildirdiği, split başına ANLIK
  // (kaydedilmiş ya da taslak, farketmez) tam blok listesi — "Özel Program"
  // farklarını (o anki sistem önerisiyle karşılaştırarak) göstermek için kullanılır.
  const [liveBlocksBySplit, setLiveBlocksBySplit] = useState<Map<string, StageTimelineBlock[]>>(new Map());
  // Sıra hatası (ör. Üretim, Dizgi bitmeden bitiyor) tespit edilince toast'ta hangi
  // parça/ürüne ait olduğunu göstermek için — renderEntryCard her render'da günceller,
  // handleSave bunu okur (state'e gerek yok, render sonrası her zaman güncel).
  const splitLabelsRef = useRef<Map<string, string>>(new Map());
  const [employeeDrafts, setEmployeeDrafts] = useState<
    Map<string, { values: EmployeeCapacityValues; orderId: string; splitId: string | null }>
  >(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [isDeletingOrder, setIsDeletingOrder] = useState(false);
  // "Parçalı Teslimat Oluştur" formu — RightPanel'deki parça bölme formuyla aynı
  // desen (parça adeti + bitiş tarihi + fason + fason süresi), yalnızca henüz hiç
  // bölünmemiş (tek teslimatlı) siparişlerde gösterilir.
  const [splitFormOpen, setSplitFormOpen] = useState(false);
  const [splitSegments, setSplitSegments] = useState<
    Array<{ quantity: string; endDate: string; is_outsourced: boolean; outsource_days: string }>
  >([]);
  const [splitSubmitting, setSplitSubmitting] = useState(false);
  const [splitError, setSplitError] = useState('');
  // "Abonelik / Aylık Otomatik Böl" — yukarıdaki splitSegments listesini elle tek
  // tek yazmak yerine "ayda X adet" / "Y ay" / "her ayın Z. günü" diyerek otomatik
  // üreten kısayol. Backend'e YENİ bir şey göndermez — sadece splitSegments'i
  // programatik doldurur, geri kalan akış (submit, uyarılar, FIFO elde-mevcut,
  // fason) değişmeden aynı kalır.
  const [subOpen, setSubOpen] = useState(false);
  const [subMonthly, setSubMonthly] = useState('');
  const [subMonths, setSubMonths] = useState('');
  const [subStartMonth, setSubStartMonth] = useState('');
  const [subDay, setSubDay] = useState('');
  // Aylık Adet / Ay Sayısı çift yönlü bağlı — hangisi SON elle değiştirilirse asıl
  // "ay sayısı" kaynağı o olur, diğeri sadece hesaplanan bir gösterge olarak güncellenir.
  const [subLastEdited, setSubLastEdited] = useState<'monthly' | 'months'>('monthly');
  // Dönüştürme başarılı olunca: önce kısa bir "tamamlandı" onay ekranı gösterilir,
  // ardından modal yavaşça (boşalarak) kapanır — aksi halde önizleme aniden
  // kaybolup "bir şey ters gitti" hissi verirdi (bu parça artık farklı bir context'e,
  // birden fazla teslimata ait).
  const [conversionDone, setConversionDone] = useState(false);
  const [isClosingModal, setIsClosingModal] = useState(false);
  // "Üretim Parametreleri" varsayılan olarak AÇIK gelsin diye — bu set üyeliği
  // "genişletilmiş" değil, kullanıcının BİLİNÇLİ OLARAK KAPATTIĞI satırları tutar
  // (bkz. aşağıdaki isAdvancedExpanded: `!has()`). Böylece henüz hiç görülmemiş
  // (ör. sonradan eklenen) satırlar da hep açık başlar, boş Set = "hiçbiri
  // kapatılmadı" anlamına gelir.
  const [collapsedAdvanced, setCollapsedAdvanced] = useState<Set<string>>(new Set());
  // "Özel Program" fark paneli — varsayılan KAPALI, kullanıcı bilinçli olarak
  // açtığı satırları tutar (collapsedAdvanced'in tersi: burada üyelik "açık" demek).
  const [openCustomDiff, setOpenCustomDiff] = useState<Set<string>>(new Set());
  // Başarılı her kayıttan sonra arttırılır; alt bileşenler (zaman çizelgesi/çalışan
  // ayarları) bunu görünce sunucudan taze veriyi çekip kendi dirty temellerini günceller.
  const [saveVersion, setSaveVersion] = useState(0);
  // Son kayıt turunda hangi split'in zaman çizelgesinin PUT (gerçekten özel/kilitli)
  // mü yoksa DELETE (sistem önerisiyle aynı olduğu için temizlendi) mi ile
  // kaydedildiği — StageTimelineEditor'a refreshedIsCustom olarak geçilir, "Özel
  // Program" rozeti modal kapatılıp yeniden açılmadan ANINDA güncellensin diye.
  const [scheduleCustomAfterSave, setScheduleCustomAfterSave] = useState<Map<string, boolean>>(new Map());

  // Modal açılınca bir kez çekilen ortak veri: çalışan atamaları (ürün parametreleriyle
  // birlikte), tatil günleri ve günlük çalışma dakikası — canlı süre hesabı ve
  // çalışan editörlerinin başlangıç değerleri buradan beslenir.
  const [sharedData, setSharedData] = useState<{
    assignments: StepAssignmentRow[];
    holidayKeys: Set<string>;
    workMinutes: number;
  } | null>(null);
  const [sharedError, setSharedError] = useState('');

  // Split bazında bekleyen zaman çizelgesi ayarlamaları (token artan sayaç).
  const [timelineAdjustments, setTimelineAdjustments] = useState<
    Map<string, { token: number; changes: BlockAdjustment[] }>
  >(new Map());
  const adjustmentTokenRef = useRef(0);
  // Entry başına son geçerli otomatik blok süreleri — diff tabanı.
  const prevSpansRef = useRef<Map<string, Partial<Record<BlockKey, number>>>>(new Map());
  /** BOM ana satırları için bir önceki turda geçerli olan "bileşenler hazır" anı
   *  (ms). Bileşen tarafındaki bir değişiklik ana ürünün kendi blok sürelerini
   *  değiştirmediği için, kaymayı yalnızca bu karşılaştırma yakalayabiliyor. */
  const prevComponentReadyRef = useRef<Map<string, number | null>>(new Map());

  // "Sistem Önerisi" butonuyla split bazında istenen tam-değiştirme (sıfırdan
  // hesaplanan öneri) — timelineAdjustments'tan farklı olarak delta/oran değil,
  // doğrudan tüm blokların yerini alır.
  const [suggestionRequests, setSuggestionRequests] = useState<
    Map<string, { token: number; blocks: StageTimelineBlock[] }>
  >(new Map());
  const suggestionTokenRef = useRef(0);

  // "Teslimat Bitiş" tarihi değişince (adet/parametre/işçi sayısı AYNI kalsa
  // bile) zaman çizelgesi eski tarihlerde donmuş kalmasın diye — blok
  // GÜN SAYILARI (prevSpansRef) etkilenmediğinden yukarıdaki ayarlama/öneri
  // mekanizmaları bu değişikliği hiç görmez. Burada AYRI olarak: bitiş tarihi
  // kaydırıldığı kadar, mevcut TÜM bloklar (özel/otomatik fark etmeksizin)
  // aynı delta ile kaydırılır — backend'in aynı alanı kaydederken uyguladığı
  // kaymayla birebir tutarlı (bkz. order_details.py bulk-update "end_date").
  const [timelineShifts, setTimelineShifts] = useState<Map<string, { token: number; deltaMs: number }>>(new Map());
  const shiftTokenRef = useRef(0);
  const prevEndDatesRef = useRef<Map<string, string>>(new Map());
  // Gün modunda boş bırakılmış production_flat_days/test_flat_days için sessiz
  // arka plan tohumlamasının (aşağıdaki useEffect) aynı alanı modal açıkken
  // tekrar tekrar kaydetmesini önler — bkz. o efektteki asıl açıklama.
  const autoSeededFlatDaysKeysRef = useRef<Set<string>>(new Set());

  // Proaktif kapasite kontrolü sonucu (Çalışan Ayarları altındaki sarı kutu).
  const [capacityWarning, setCapacityWarning] = useState<{
    max: number;
    conflicts: ConcurrencyConflict[];
  } | null>(null);
  const [remainingCapacity, setRemainingCapacity] = useState<Record<string, Record<string, number>>>({});
  const capacityCheckIdRef = useRef(0);
  const [confirmSave, setConfirmSave] = useState(false);

  // Bilesenlerin (BOM alt urun) kendi order_id'leri de var — cekilen istihdam
  // atamalari SADECE ana siparisin order_id'sine gore filtrelenirse, bilesen
  // kartlarindaki Calisan Sayilari editoru hep bos/varsayilan gorunur VE
  // kaydedilen taslak sessizce kaybolur (bkz. buildEmployeePayload: draft'i
  // "mevcut" bir satirla eslestiremezse atlar). Bu yuzden her bilesenin
  // order_id'si icin de ayri bir istek atilip sonuclar TEK bir diziye birlestirilir.
  const componentOrderIds = useMemo(
    () => (components ?? []).map((c) => c.orderId),
    [components],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      Promise.all(
        [group.orderId, ...componentOrderIds].map((orderId) =>
          api.get<{ assignments: StepAssignmentRow[] }>('/settings/step-employees', {
            params: { order_id: orderId },
          }),
        ),
      ),
      api.get<{ holiday_date: string; is_active: boolean }[]>('/holidays/'),
      api.get<{ value: number }>('/settings/work-hours-per-day'),
    ])
      .then(([empResList, holRes, whRes]) => {
        if (cancelled) return;
        setSharedData({
          assignments: empResList.flatMap((res) => res.data.assignments),
          holidayKeys: buildHolidayKeySet(holRes.data),
          workMinutes: (whRes.data.value || 8) * 60,
        });
      })
      .catch(() => {
        if (!cancelled) setSharedError('Çalışan ayarları yüklenemedi.');
      });
    return () => {
      cancelled = true;
    };
  }, [group.orderId, componentOrderIds]);

  // Çoklu-split siparişlerde split bazlı satır, tek-split'te order-level (null) satır geçerli.
  const matchAssignment = (splitId: string | null): StepAssignmentRow | undefined => {
    const rows = sharedData?.assignments ?? [];
    return rows.find((a) => a.split_id === splitId) ?? rows.find((a) => a.split_id === null);
  };

  // Taslak (draft) fason değeri varsa onu, yoksa sunucudan gelen mevcut durumu kullanır.
  const isEntryOutsourced = (entryKey: string, row: OrderDetailRow, assignment?: StepAssignmentRow): boolean => {
    const fasonDraftKey = `${entryKey}|fason_durumu`;
    const fallback = Boolean(assignment?.is_outsourced ?? row.split_is_outsourced);
    if (!draft.has(fasonDraftKey)) return fallback;
    const fasonDraft = String(draft.get(fasonDraftKey) ?? '');
    return fasonDraft === '' ? fallback : fasonDraft === 'true';
  };

  // BOM: bu siparişin (varsa) alt ürünlerinin en geç bitiş tarihi — backend
  // date_utils.py'deki get_components_ready_at ile aynı rol. "Sistem Önerisi"
  // hesaplanırken Dizgi'nin düşürülmesi için kullanılır (bkz. computeSuggestedBlocks).
  // Bileşenin kendi (henüz kaydedilmemiş) taslak bitiş tarihi varsa o kullanılır.
  /** Alt ürünlerin (BOM bileşenleri) canlı hesaplanan bitişleri — entryKey -> tarih.
   *  Aşağıdaki canlı-senkron efekti bileşenleri ANA satırlardan ÖNCE işler ve
   *  hesapladığı yeni bitişi buraya yazar; `getComponentReadyAt` de kayıtlı
   *  `split_end_date` yerine önce buna bakar.
   *
   *  Gerekçe: ana ürünün Üretim'i "bileşenler ne zaman hazır olur"a göre konumlanır.
   *  Kayıtlı bitişler kullanılırsa, adet değiştirildiğinde ana ürünün barları
   *  bileşenlerin ESKİ süresine göre çizilir — kaydedince backend bileşenleri
   *  ölçekleyip planı kaydırdığı için önizleme ile sonuç birbirini tutmazdı.
   *  Ref kullanılıyor (state değil): efekt içinde yazılıp aynı efektte okunuyor,
   *  ekstra bir render turu gerekmiyor. */
  const componentPreviewEndsRef = useRef<Map<string, Date>>(new Map());

  const getComponentReadyAt = (): Date | null => {
    if (!components || components.length === 0) return null;
    let latest: Date | null = null;
    components.forEach((component) => {
      component.entries.forEach(({ row, rowIndex }) => {
        const key = entryKeyFor(row, rowIndex);
        // Öncelik: canlı önizlenen bitiş > kullanıcının elle girdiği taslak >
        // sunucudaki kayıtlı değer.
        const previewed = componentPreviewEndsRef.current.get(key);
        const endDraftKey = `${key}|split_end_date`;
        const raw = draft.has(endDraftKey) ? draft.get(endDraftKey) : row.split_end_date;
        const d = draft.has(endDraftKey)
          ? (raw ? new Date(String(raw)) : null)
          : (previewed ?? (raw ? new Date(String(raw)) : null));
        if (!d || Number.isNaN(d.getTime())) return;
        if (!latest || d.getTime() > latest.getTime()) latest = d;
      });
    });
    return latest;
  };

  // `getComponentReadyAt`in aynası, yalnızca EN ERKEN BAŞLANGIÇ: ana ürünün
  // Tedarik'i bileşenlerle paralel çalıştığı için o çubuğun bitişi bileşenlerin
  // MAX bitişi, başlangıcı ise MIN başlangıcıdır. MAX alınsaydı ana siparişin
  // başlangıcı kendi alt parçasının başlangıcından sonraya düşerdi (backend
  // bom_scheduling.get_components_start_at ile aynı gerekçe).
  //
  // Burada canlı önizleme yok: bileşen kartlarının önizlenen BİTİŞİ hesaplanıyor
  // (componentPreviewEndsRef), başlangıcı değil — taslakta elle girilmiş bir
  // başlangıç varsa o, yoksa sunucudaki kayıtlı değer kullanılır.
  const getComponentStartAt = (): Date | null => {
    if (!components || components.length === 0) return null;
    let earliest: Date | null = null;
    components.forEach((component) => {
      component.entries.forEach(({ row, rowIndex }) => {
        const key = entryKeyFor(row, rowIndex);
        const startDraftKey = `${key}|split_start_date`;
        const raw = draft.has(startDraftKey) ? draft.get(startDraftKey) : row.split_start_date;
        const d = raw ? new Date(String(raw)) : null;
        if (!d || Number.isNaN(d.getTime())) return;
        if (!earliest || d.getTime() < earliest.getTime()) earliest = d;
      });
    });
    return earliest;
  };

  // Çizelgenin Tedarik çubuğunun BAŞLADIĞI an. İki önizleme yolu da (canlı senkron
  // efekti ve "Çizelgeyi Yeniden Kur") bunu kullanmalı — biri bileşenlere bakıp
  // diğeri bakmazsa aynı split için iki farklı çizelge çıkar ve hiç elle
  // düzenlenmemiş bir siparişte bile sahte "Özel program" farkı görünür.
  const resolveScheduleStartAnchor = (
    entryKey: string,
    row: OrderDetailRow,
    componentReadyAt: Date | null,
  ): Date | null => {
    const startDraftKey = `${entryKey}|split_start_date`;
    const raw = draft.has(startDraftKey) ? draft.get(startDraftKey) : row.split_start_date;
    const stored = raw ? new Date(String(raw)) : null;
    // Yalnızca BOM ana siparişinde (componentReadyAt dolu) bileşenlerin başlangıcı
    // hesaba katılır; bileşenin kendisinde BOM mantığı yoktur.
    const componentsStartAt = componentReadyAt && !row.parent_order_id ? getComponentStartAt() : null;
    const candidates = [stored, componentsStartAt].filter(
      (d): d is Date => !!d && !Number.isNaN(d.getTime()),
    );
    if (candidates.length === 0) return null;
    return new Date(Math.min(...candidates.map((d) => d.getTime())));
  };

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const firstRow = group.entries[0].row;
  const orderStatus = firstRow.order_status ?? firstRow.status;
  const meta = statusMeta(orderStatus);

  // Bilesen (BOM alt urun) kartlari da draft/setField sistemini (entryKey bazli,
  // hangi siparise ait oldugundan bagimsiz) paylasir — bu yuzden bir entryKey'den
  // satira donen TUM arama noktalari (dirtyCount, handleSave, dirtyDetails) hem
  // group.entries hem components icindeki entry'lere bakmali, aksi halde bilesen
  // kartinda yapilan bir degisiklik "row bulunamadi" diye sessizce yok sayilir.
  const allEntries = useMemo(
    () => [...group.entries, ...(components ?? []).flatMap((c) => c.entries)],
    [group.entries, components],
  );
  const findEntryByKey = (entryKey: string) =>
    allEntries.find((e) => entryKeyFor(e.row, e.rowIndex) === entryKey);

  // Bir split'in SUNUCUDAKİ kalıcı elde-mevcut değeri — onHandBySplitId'in
  // "değişti mi" (dirtyCount/dirtyDetails/handleSave) kıyaslamalarında taban
  // olarak kullanılır; ön-doldurulmuş (henüz kullanıcının dokunmadığı) bir
  // değer YANLIŞLIKLA "kaydedilmemiş değişiklik" sayılmasın diye.
  const getPersistedOnHand = (splitId: string): number =>
    findEntryByKey(splitId)?.row.split_on_hand_quantity ?? 0;

  // Kullanıcı belirli bir parçaya tıklayarak açtıysa (focusSplitId), "Ürünler /
  // Teslimatlar" bölümü YALNIZCA o parçayı listeler — `originalIndex` sayesinde
  // "Parça N" etiketi yine tıklanan gerçek sıra numarasını gösterir (filtrelenmiş
  // listenin kendi 0-index'ini değil). Eşleşme bulunamazsa (ör. veri değişmiş)
  // güvenlik amacıyla tüm parçalar gösterilir.
  const displayedEntries = useMemo(() => {
    const withIndex = group.entries.map((entry, originalIndex) => ({ ...entry, originalIndex }));
    if (!focusSplitId) return withIndex;
    const filtered = withIndex.filter((entry) => entry.row.split_id === focusSplitId);
    return filtered.length > 0 ? filtered : withIndex;
  }, [group.entries, focusSplitId]);
  const isFocusedOnOnePart = Boolean(focusSplitId) && displayedEntries.length === 1 && group.entries.length > 1;

  const orderColumns = columns.filter(
    (c) => c.recordType === 'order' && c.editable && c.key !== 'status' && !c.sticky,
  );
  // external_id (Sipariş No) tabloda sticky + salt-okunur (yanlışlıkla hücre
  // düzenlemesiyle değişmesin diye) — ama bu modalde bilinçli olarak
  // düzenlenebilmesi isteniyor, bu yüzden `orderColumns`'un sticky filtresinden
  // ayrı, kendi özel alanında (aşağıda) render edilir.
  const externalIdColumn = columns.find((c) => c.key === 'external_id');
  const statusColumn = columns.find((c) => c.key === 'status');
  const metaColumns = columns.filter(
    (c) => c.recordType === 'order' && !c.editable && !c.sticky && c.key !== 'has_splits',
  );
  // split_promised_date ayrı, kendi bağımsız kutusunda render edilir (ne essential
  // gridde ne Üretim Parametreleri'nde) — bkz. aşağıdaki ayrı blok.
  const detailColumns = columns.filter(
    (c) =>
      (c.recordType === 'split' || c.recordType === 'base_data' || c.recordType === 'split_base_data') &&
      c.key !== 'split_promised_date',
  );
  const essentialDetailColumns = detailColumns.filter((c) => ESSENTIAL_DETAIL_KEYS.has(c.key));
  const advancedDetailColumns = detailColumns.filter((c) => !ESSENTIAL_DETAIL_KEYS.has(c.key));

  const toggleAdvanced = (entryKey: string) => {
    setCollapsedAdvanced((prev) => {
      const next = new Set(prev);
      if (next.has(entryKey)) {
        next.delete(entryKey);
      } else {
        next.add(entryKey);
      }
      return next;
    });
  };

  const setField = (entryKey: string, column: Column, value: CellValue) => {
    setDraft((prev) => {
      const next = new Map(prev);
      next.set(`${entryKey}|${column.key}`, value);
      return next;
    });
  };

  const getFieldValue = (entryKey: string, column: Column, row: OrderDetailRow): string => {
    const key = `${entryKey}|${column.key}`;
    if (draft.has(key)) {
      const v = draft.get(key);
      return column.inputType === 'date' ? stripDateSuffix(v) : v === null || v === undefined ? '' : String(v);
    }
    const raw = column.getRawValue(row);
    return column.inputType === 'date' ? stripDateSuffix(raw) : raw === null || raw === undefined ? '' : String(raw);
  };

  // `columns` prop'u + Adet/Gün sanal kolonları birlikte arar — VIRTUAL_COLUMNS
  // `columns`'da olmadığı için `dirtyCount`/`handleSave` bunları göz ardı etmesin diye.
  const findColumn = (colKey: string): Column | undefined =>
    columns.find((c) => c.key === colKey) ?? VIRTUAL_COLUMNS.find((c) => c.key === colKey);

  const dirtyCount = useMemo(() => {
    let count = 0;
    draft.forEach((value, key) => {
      const [entryKey, colKey] = key.split('|');
      const column = findColumn(colKey);
      if (!column) return;
      const row = entryKey === 'order' ? firstRow : findEntryByKey(entryKey)?.row;
      if (!row) return;
      if (String(value ?? '') !== originalString(row, column)) count += 1;
    });
    count += stageScheduleDrafts.size;
    count += employeeDrafts.size;
    count += Object.entries(onHandBySplitId).filter(
      ([splitId, raw]) => (Number(raw) || 0) !== getPersistedOnHand(splitId),
    ).length;
    return count;
  }, [draft, columns, allEntries, firstRow, stageScheduleDrafts, employeeDrafts, onHandBySplitId]);

  // handleSave'deki AYNI kontrolün canlı (render sırasındaki) karşılığı — "Kaydet"
  // butonu, kullanıcı tıklamadan ÖNCE zaten tıklanamaz ve bunun NEDENİNİ gösterir,
  // aksi halde kullanıcı tıklayıp sessizce reddedilene kadar sorunu fark etmezdi.
  const hasScheduleSequenceIssues = useMemo(
    () =>
      Array.from(stageScheduleDrafts.values()).some((blocks) => findStageSequenceViolations(blocks).length > 0),
    [stageScheduleDrafts],
  );

  // "Kaydet"e basmadan önce Atahan'ın gerçekte neyin değişeceğini görebilmesi için
  // dirtyCount'un yalnızca SAYISINI değil, her değişikliğin alan adı + eski/yeni
  // değerini de listeleyen insan-okur özet. Boolean/durum alanları ham koddan
  // (ör. "true", "APPROVED") değil kullanıcı dilindeki etiketten gösterilir.
  const formatDraftValue = (column: Column, raw: string): string => {
    // Süre Modu boş/"per_unit" iken varsayılan olarak "Adet Başına" uygulanır — bu
    // yüzden boş değer burada '—' değil, gerçekte etkin olan modun adı olmalı.
    if (column.key === 'duration_mode') return raw === 'per_unit' ? 'Adet Başına' : 'İş Günü (Toplam)';
    if (raw === '' || raw === null || raw === undefined) return '—';
    if (column.inputType === 'boolean') return raw === 'true' ? 'Evet' : raw === 'false' ? 'Hayır' : '—';
    if (column.inputType === 'status') return STATUS_STEP_OPTIONS.find((o) => o.value === raw)?.label ?? raw;
    const formatted = formatCell(raw);
    return formatted === '' ? '—' : String(formatted);
  };

  const dirtyDetails = useMemo(() => {
    const entryLabelFor = (entryKey: string): string | null => {
      if (entryKey === 'order') return 'Sipariş (genel)';
      const idx = group.entries.findIndex((e) => entryKeyFor(e.row, e.rowIndex) === entryKey);
      if (idx >= 0) return group.entries.length > 1 ? `Parça ${idx + 1}` : null;
      const comp = (components ?? []).find((c) => c.entries.some((e) => entryKeyFor(e.row, e.rowIndex) === entryKey));
      if (comp) {
        const label = (comp.entries[0].row.base_data?.product_name as string) || comp.entries[0].row.external_id;
        return `Alt Ürün: ${label}`;
      }
      return null;
    };

    const details: { id: string; entryLabel: string | null; fieldLabel: string; from: string; to: string }[] = [];
    draft.forEach((value, key) => {
      const [entryKey, colKey] = key.split('|');
      const column = findColumn(colKey);
      if (!column) return;
      const row = entryKey === 'order' ? firstRow : findEntryByKey(entryKey)?.row;
      if (!row) return;
      const from = originalString(row, column);
      const to = String(value ?? '');
      if (to === from) return;
      details.push({
        id: key,
        entryLabel: entryLabelFor(entryKey),
        fieldLabel: column.label,
        from: formatDraftValue(column, from),
        to: formatDraftValue(column, to),
      });
    });
    stageScheduleDrafts.forEach((_, splitId) => {
      const entry = allEntries.find((e) => e.row.split_id === splitId);
      details.push({
        id: `schedule-${splitId}`,
        entryLabel: entry ? entryLabelFor(entryKeyFor(entry.row, entry.rowIndex)) : null,
        fieldLabel: 'Zaman Çizelgesi',
        from: '',
        to: 'Yeni blok planı',
      });
    });
    employeeDrafts.forEach(({ splitId }) => {
      const entry = allEntries.find((e) => e.row.split_id === splitId);
      details.push({
        id: `employee-${splitId ?? 'order'}`,
        entryLabel: entry ? entryLabelFor(entryKeyFor(entry.row, entry.rowIndex)) : null,
        fieldLabel: 'Çalışan Sayıları',
        from: '',
        to: 'Güncellendi',
      });
    });
    Object.entries(onHandBySplitId).forEach(([splitId, raw]) => {
      const onHand = Number(raw) || 0;
      const persisted = getPersistedOnHand(splitId);
      if (onHand === persisted) return;
      const entry = allEntries.find((e) => e.row.split_id === splitId);
      details.push({
        id: `on-hand-${splitId}`,
        entryLabel: entry ? entryLabelFor(entryKeyFor(entry.row, entry.rowIndex)) : null,
        fieldLabel: 'Elde Mevcut Miktar',
        from: `${persisted} adet`,
        to: `${onHand} adet`,
      });
    });
    return details;
  }, [draft, columns, allEntries, firstRow, stageScheduleDrafts, employeeDrafts, onHandBySplitId]);

  const [changesOpen, setChangesOpen] = useState(false);
  useEffect(() => {
    if (dirtyCount === 0) setChangesOpen(false);
  }, [dirtyCount]);

  /** Ana parçanın KAYDEDİLMEMİŞ adet değişikliğinin, bağlı alt ürün (BOM bileşeni)
   *  parçalarına yansıyan oranı — kaydetme sırasında backend'in uyguladığı
   *  ölçeklemenin aynısı (bkz. order_details.py quantity_changes →
   *  _rescale_component_split: `yeni_bilesen_adedi = bilesen_adedi × yeni/eski`).
   *
   *  Bu olmadan, ana siparişin adedi değiştirildiğinde ekrandaki alt ürün barları
   *  ESKİ adede göre kalıyor, ama KAYDEDİNCE backend onları ölçekliyordu — yani
   *  önizleme ile kaydedilen sonuç birbirini tutmuyordu. Oran 1 ise (ya da ana
   *  parça bulunamazsa) hiçbir şey değişmez. */
  const componentQtyRatioBySourceSplit = useMemo(() => {
    const ratios = new Map<string, number>();
    group.entries.forEach(({ row, rowIndex }) => {
      if (!row.split_id) return;
      const key = `${entryKeyFor(row, rowIndex)}|split_quantity`;
      if (!draft.has(key)) return;
      const nextQty = toNumber(draft.get(key) ?? null);
      const prevQty = row.split_quantity;
      if (!nextQty || !prevQty || nextQty <= 0 || prevQty <= 0) return;
      const ratio = nextQty / prevQty;
      if (ratio !== 1) ratios.set(row.split_id, ratio);
    });
    return ratios;
  }, [draft, group.entries]);

  // Bir entry için canlı hesaba giren tüm girdileri (parametreler, adet, çalışan
  // sayıları, fason durumu) taslaklardan/sunucu verisinden derler. `null` dönerse
  // (parse edilemeyen bir taslak girişi var demektir) o entry canlı hesaptan
  // atlanır — son geçerli taban korunur.
  const collectEntryInputs = (
    entryKey: string,
    row: OrderDetailRow,
    assignment: StepAssignmentRow | undefined,
  ): { params: ScheduleParams; qty: number; emp: EmployeeCapacityValues; isOutsourced: boolean } | null => {
    let invalid = false;
    const params: ScheduleParams = {};
    PARAM_KEYS.forEach((key) => {
      const draftKey = `${entryKey}|${key}`;
      if (draft.has(draftKey)) {
        const parsed = toNumber(draft.get(draftKey) ?? null);
        if (parsed === undefined) {
          invalid = true;
          return;
        }
        params[key] = parsed;
      } else {
        const parsed = toNumber((row.base_data?.[key] ?? null) as CellValue);
        params[key] = parsed === undefined ? null : parsed;
      }
    });

    // Backend, "assembly_days" kaydedilirken eski `production_days` gölgesini
    // otomatik temizliyor (bkz. order_details.py bulk-update). Kaydetmeden ÖNCEKİ
    // canlı önizleme de bunu yansıtmazsa, kullanıcı "Dizgi" süresini değiştirirken
    // bar/öneri hâlâ eski (gölgelenen) production_days değerinden hesaplanmaya
    // devam eder ve kaydedince aniden doğru süreye "zıplar" — o yüzden burada da
    // aynı geçersiz kılma taslak aşamasında uygulanır.
    if (draft.has(`${entryKey}|assembly_days`)) {
      params.production_days = null;
    }

    // Kullanıcının bu parçaya AÇIKÇA yazdığı toplam-gün alanları. Sunucudan gelen
    // liste yalnızca KAYDEDİLMİŞ olanları içerir; kullanıcı kutuya yeni bir sayı
    // yazdıysa (henüz kaydetmemişse) o da açık sayılmalı — aksi halde Adet Başına
    // bir üründe önizleme yazılan değeri yok sayıp adet başına hesabı gösterir,
    // kaydedince ise süre aniden yazılan değere zıplardı. Önizleme = kaydedilecek
    // sonuç kuralı (bkz. yukarıdaki production_days gölgesi için aynı gerekçe).
    const explicitFlatKeys = new Set<string>(
      ((row.base_data?._explicit_flat_keys as string[] | undefined) || []),
    );
    (['assembly_flat_days', 'production_flat_days', 'test_flat_days'] as const).forEach((key) => {
      if (!draft.has(`${entryKey}|${key}`)) return;
      const typed = params[key];
      // Boşaltılan/0 yapılan alan "açık değer" sayılmaz — hesaba geri düşülür.
      if (typed && typed > 0) explicitFlatKeys.add(key);
      else explicitFlatKeys.delete(key);
    });
    params._explicit_flat_keys = Array.from(explicitFlatKeys);

    // duration_mode string bir enum ("per_unit"/"flat") — PARAM_KEYS'in sayısal
    // parse döngüsüne girmez, ayrı okunur. Hiç ayarlanmamışsa (null/undefined)
    // varsayılan olarak "flat" (İş Günü) kabul edilir — bkz. backend date_utils.py
    // _block_days ile aynı kural.
    const modeDraftKey = `${entryKey}|duration_mode`;
    const modeRaw = draft.has(modeDraftKey) ? draft.get(modeDraftKey) : row.base_data?.duration_mode;
    params.duration_mode = modeRaw === 'per_unit' ? 'per_unit' : 'flat';

    let qty: number | null | undefined;
    const qtyDraftKey = `${entryKey}|split_quantity`;
    if (draft.has(qtyDraftKey)) {
      qty = toNumber(draft.get(qtyDraftKey) ?? null);
      if (qty === undefined || qty === null || qty <= 0) invalid = true;
    } else {
      qty = row.split_quantity ?? assignment?.split_quantity ?? assignment?.quantity ?? 1;
      // Bu bir alt ürün (bileşen) parçasıysa ve bağlı olduğu ana parçanın adedi
      // henüz kaydedilmemiş olarak değiştiyse, kaydedince uygulanacak oranı
      // ŞİMDİDEN uygula — böylece bileşenin barları da canlı güncellenir ve
      // önizleme, kaydedilecek sonucun aynısını gösterir. Kullanıcı bileşenin
      // kendi adedini elle girdiyse (draft dolu, yukarıdaki dal) ona dokunulmaz.
      const ratio = row.source_main_split_id
        ? componentQtyRatioBySourceSplit.get(row.source_main_split_id)
        : undefined;
      if (ratio && qty) qty = Math.round(qty * ratio * 100) / 100;
    }
    // "Elde Mevcut Miktar" (bkz. onHandBySplitId, bileşen kartlarındaki alan) girildiyse,
    // Zaman Çizelgesi'nin kaydetmeden ANINDA düşülmüş miktara göre önizleme göstermesi
    // için buradan düşülür — tek kaynak olduğu için hem otomatik-canlı useEffect hem
    // "Sistem Önerisi" (computeSystemSuggestionBlocks) bunu otomatik yansıtır. Kaydedilen
    // değerle (handleSave → backend _rescale_component_split) aynı "mevcut - elde" formülü.
    if (row.split_id && qty !== null && qty !== undefined) {
      const onHand = Math.max(0, Number(onHandBySplitId[row.split_id]) || 0);
      if (onHand > 0) qty = Math.max(0, qty - onHand);
    }
    if (invalid || qty === null || qty === undefined) return null;

    const emp = employeeDrafts.get(entryKey)?.values ?? {
      assembly: assignment?.assembly ?? 1,
      production: assignment?.production ?? 1,
      test: assignment?.test ?? 1,
    };

    const isOutsourced = isEntryOutsourced(entryKey, row, assignment);
    return { params, qty, emp, isOutsourced };
  };

  // Gün modunda Üretim/Test (iş günü, toplam) alanı hiç doldurulmamışsa (base_data'da
  // null), hem bu kutu hem de zaman çizelgesi barı Adet Başına tarafındaki dakika
  // verilerinden ADETE GÖRE CANLI hesaplanan bir "eşdeğer" gün sayısı gösteriyordu —
  // "Gün modundasınız, süre kesindir" mesajına rağmen adet her değiştiğinde bar/kutu
  // sessizce büyüyüp küçülüyordu (bkz. ilgili konuşma/rapor). Bunu önlemek için: ilgili
  // parça ilk yüklendiğinde, o andaki (kayıtlı) adede göre hesaplanan eşdeğer değer
  // kalıcı hale getirilir — bundan sonra adet değişse bile bu iki alan (ve onlara bağlı
  // bar) artık değişmez.
  //
  // Bu SESSİZCE (arka planda, api.patch ile) yapılır — draft'a YAZILMAZ. Önceden
  // draft'a yazılıyordu, ama bu "hiç dokunulmamış, yeni oluşturulmuş bir sipariş
  // açar açmaz 'kaydedilmemiş değişiklik bekliyor' göstermesi kullanıcıyı gereksiz
  // yere şaşırtıyordu (bkz. ilgili kullanıcı bildirimi) — kutudaki SAYI zaten
  // değişmiyordu (getValue aynı eşdeğeri canlı hesaplıyordu), yalnızca "bekleyen
  // değişiklik" rozeti yanlış alarm veriyordu. autoSeededFlatDaysKeysRef, aynı
  // alanı modal açıkken tekrar tekrar kaydetmeyi önler (bileşen bazlı, kalıcı değil
  // — modal her yeniden açıldığında sıfırlanır, gerekirse tekrar dener).
  useEffect(() => {
    if (!sharedData || !canEdit) return;
    // Yalnızca ana ürünün (group) satırları DEĞİL — BOM alt ürün (component)
    // kartları da bu tohumlamadan yararlanmalı, aksi halde "Gün modundasınız,
    // süre kesindir" mesajına rağmen bileşen kartlarında Üretim/Test kutuları
    // (henüz hiç kaydedilmemişse) Elde Mevcut Miktar değiştikçe sessizce başka
    // bir sayıya kayardı — tam olarak bu efektin ana ürünler için önlediği hatanın
    // aynısı, sadece bileşenlerde hâlâ mevcuttu (canlı test: on_hand 2→5 iken
    // Üretim kutusu 3'ten 2'ye düştü).
    const allEntriesForSeed = [
      ...group.entries,
      ...(components ?? []).flatMap((c) => c.entries),
    ];
    const silentUpdates: { order_id: string; split_id: string | null; field_key: string; value: number }[] = [];

    allEntriesForSeed.forEach(({ row, rowIndex }) => {
      if (!row.split_id) return;
      const entryKey = entryKeyFor(row, rowIndex);
      const isFlat = (row.base_data?.duration_mode ?? null) !== 'per_unit';
      if (!isFlat) return;
      const assignment = matchAssignment(row.split_id);
      const inputs = collectEntryInputs(entryKey, row, assignment);
      if (!inputs) return;

      const seedIfEmpty = (
        flatFieldKey: 'production_flat_days' | 'test_flat_days',
        currentValue: number | null | undefined,
        scheduleKey: 'production' | 'test',
      ) => {
        if (currentValue !== null && currentValue !== undefined) return;
        const seedKey = `${entryKey}|${flatFieldKey}`;
        if (autoSeededFlatDaysKeysRef.current.has(seedKey)) return;
        autoSeededFlatDaysKeysRef.current.add(seedKey);
        const equivalent = perUnitEquivalentDays(scheduleKey, inputs.params, inputs.qty, inputs.emp, sharedData.workMinutes);
        silentUpdates.push({
          order_id: row.order_id,
          split_id: row.split_id,
          field_key: flatFieldKey,
          value: equivalent ?? 1,
        });
      };

      seedIfEmpty('production_flat_days', row.base_data?.production_flat_days as number | null | undefined, 'production');
      seedIfEmpty('test_flat_days', row.base_data?.test_flat_days as number | null | undefined, 'test');
    });

    if (silentUpdates.length === 0) return;
    api.patch('/order-details/bulk-update', { updates: silentUpdates }).catch(() => {
      // Sessiz arka plan işlemi — başarısız olursa kutu/bar canlı hesaplanan
      // eşdeğeri göstermeye devam eder (davranış hiç bozulmaz), yalnızca bir
      // sonraki modal açılışında (ref sıfırlanınca) tekrar denenir.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedData, group.entries, components, canEdit]);

  // Çalışan sayısı / üretim parametresi / adet / fason değişince blok sürelerini
  // (backend formüllerinin aynası ile) yeniden hesapla, önceki otomatik sürelerle
  // diff'le ve ilgili zaman çizelgesi editörüne ayarlama gönder. İlk hesap (taban
  // tohumlama) ayarlama üretmez; geçersiz (parse edilemeyen) taslak girişlerde o
  // entry atlanıp son geçerli taban korunur.
  useEffect(() => {
    if (!sharedData) return;
    const pending: { splitId: string; changes: BlockAdjustment[] }[] = [];
    // Özel programı (elle sürükleme ile kaydedilmiş) OLMAYAN parçalar için: kısmi
    // oran/set-days ayarlaması yerine TÜM bloklar sıfırdan yeniden hesaplanıp
    // doğrudan değiştirilir (tam olarak "Sistem Önerisi" gibi). Aksi halde yalnızca
    // değişen bloğun bitişi kayar, başlangıcı sabit kalır ve komşu bloklarla arasında
    // gereksiz bir boşluk oluşurdu — hâlbuki özel program yoksa "korunacak" bir elle
    // düzenleme de yok, o yüzden bu temkinli davranışa hiç gerek yok.
    const fullReplacements: { splitId: string; blocks: StageTimelineBlock[] }[] = [];

    // Yalnızca ana ürünün (group) satırları DEĞİL — BOM alt ürün (component)
    // kartlarının Zaman Çizelgesi'si de bu useEffect'e bağlı: aksi halde bir
    // bileşenin miktarı (elde-mevcut düşümü dahil, ya da doğrudan Teslimat Adedi
    // hücresi) değişince bar'lar hiç canlı güncellenmiyordu — yalnızca "Sistem
    // Önerisi" butonuna elle basılınca (computeSystemSuggestionBlocks üzerinden)
    // düzeliyordu.
    // SIRA ÖNEMLİ: bileşenler ANA satırlardan ÖNCE işlenir. Ana ürünün Üretim'i
    // "bileşenler ne zaman hazır olur"a göre konumlanıyor (getComponentReadyAt);
    // bileşenler sonra işlenseydi ana satır, bileşenlerin bu turda hesaplanan
    // YENİ bitişlerini göremez, bir önceki turun (ya da kayıtlı) değerini
    // kullanırdı — adet değiştirildiğinde önizleme bir adım geriden gelirdi.
    const allEntriesForLiveSync = [
      ...(components ?? []).flatMap((c) => c.entries),
      ...group.entries,
    ];

    allEntriesForLiveSync.forEach(({ row, rowIndex }) => {
      if (!row.split_id) return;
      const entryKey = entryKeyFor(row, rowIndex);
      const assignment = matchAssignment(row.split_id);
      const inputs = collectEntryInputs(entryKey, row, assignment);
      if (!inputs) return;
      const { params, qty, emp, isOutsourced } = inputs;

      // computeNativeBlockDays: her bloğun kendi süresi (backend `_block_days` aynası).
      // Tedarik/Teslimat HER ZAMAN, Dizgi/Üretim/Test ise "Gün" modundayken kullanıcının
      // yazdığı sayıyı DOĞRUDAN (oran/ölçekleme uygulanmadan) kullanır — bu bloklar
      // "literal" kabul edilip editöre setDays ile doğrudan atanır; aksi halde (adet
      // başına formülle hesaplanan bloklar) mevcut oransal (snap-or-scale) kural geçerli:
      // blok hâlâ otomatik değerdeyse yeni otomatik değere oturur, kullanıcı elle
      // uzattıysa aynı oranda ölçeklenir. (Literal bloklarda oran kullanmak, kullanıcı
      // örn. "20" yazarken ara adım "2"den "20"ye 10× sıçrayıp o anki bara yanlışlıkla
      // uygulanmasına yol açardı.)
      const isFlat = params.duration_mode === 'flat';
      // Fason (dış dizgi) parçalarda "assembly" backend _block_days'in is_outsourced
      // dalıyla aynı kuralla HER ZAMAN literaldir (Gün modunda olmasa bile) — aksi
      // halde elle uzatılmış bir Dizgi barı, işçi sayısı değişince yanlışlıkla
      // ORANSAL olarak yeniden boyutlandırılırdı (backend'in doğrudan/literal
      // davranışının aksine).
      const isLiteralBlock = (key: BlockKey) =>
        key === 'supply' ||
        key === 'delivery' ||
        (key === 'assembly' && (isFlat || isOutsourced)) ||
        (isFlat && (key === 'production' || key === 'test'));
      const newDaysByBlock = computeNativeBlockDays(params, qty, emp, sharedData.workMinutes, isOutsourced);

      // BOM ana ürünü: kendi blok süreleri hiç değişmese bile, BİLEŞENLERİN hazır
      // olma tarihi değiştiyse Üretim/Test/Teslimat kayar (bkz. computeSuggestedBlocks
      // componentReadyAt dalı). Yalnızca kendi sürelerine bakılsaydı, bir alt ürünün
      // adedi/elde-mevcudu değiştirildiğinde ana ürünün barları ekranda hiç
      // kıpırdamaz, ama kaydedince backend planı kaydırırdı.
      const readyNow = row.parent_order_id ? null : getComponentReadyAt();
      const readyNowMs = readyNow ? readyNow.getTime() : null;
      const prevReadyMs = prevComponentReadyRef.current.get(entryKey) ?? null;
      const hadPrevReady = prevComponentReadyRef.current.has(entryKey);
      prevComponentReadyRef.current.set(entryKey, readyNowMs);

      const prev = prevSpansRef.current.get(entryKey);
      if (prev) {
        const readyChanged = hadPrevReady && prevReadyMs !== readyNowMs;
        const anyChanged = readyChanged
          || (['supply', 'assembly', 'production', 'test', 'delivery'] as BlockKey[]).some((key) => {
            const newDays = newDaysByBlock[key];
            return newDays !== undefined && newDays !== null && prev[key] !== newDays;
          });

        // `row.has_custom_schedule` sunucudan gelen, modal AÇILDIĞI ANDAKİ durumu
        // yansıtır — kullanıcı bu oturumda henüz KAYDETMEDEN bir barı elle
        // sürüklediyse (stageScheduleDrafts'ta bekleyen bir taslak varsa) bu bayrak
        // hâlâ false'tur. O taslağı görmezden gelip tam bir "Sistem Önerisi" ile
        // EZMEMEK için burada da taslağın varlığına bakılır.
        // DİKKAT: `stageScheduleDrafts` DEĞİL — o küme sistemin kendi otomatik
        // yeniden hesabıyla da doluyor. Burada yalnızca kullanıcının elle
        // sürüklediği parçalar korunmalı.
        const hasPendingManualSchedule = manualScheduleSplitIds.has(row.split_id);
        if (anyChanged && !row.has_custom_schedule && !hasPendingManualSchedule) {
          const endDraftKey = `${entryKey}|split_end_date`;
          const endRaw = draft.has(endDraftKey) ? draft.get(endDraftKey) : row.split_end_date;
          const endDate = endRaw ? new Date(String(endRaw)) : null;
          if (endDate && !Number.isNaN(endDate.getTime())) {
            const componentReadyAt = row.parent_order_id ? null : getComponentReadyAt();
            const startDate = resolveScheduleStartAnchor(entryKey, row, componentReadyAt);
            // Alt ürün (bileşen) parçaları İLERİ yönde hesaplanır: backend kaydederken
            // başlangıcı sabit tutup bitişi yeniden hesaplıyor
            // (_rescale_component_split → calculate_component_end_date). Burada da
            // geriye doğru hesaplansaydı bileşenin bitişi hiç değişmez, dolayısıyla
            // ana ürünün "bileşenler hazır" anı da sabit kalır ve ana barlar
            // kaydedilecek sonuçtan farklı görünürdü.
            const isComponentRow = Boolean(row.parent_order_id);
            const spans = isComponentRow && startDate && !Number.isNaN(startDate.getTime())
              ? computeComponentBlocksForward(
                  startDate, qty, params, emp, sharedData.workMinutes, sharedData.holidayKeys,
                )
              : computeSuggestedBlocks(
                  endDate, qty, params, emp, sharedData.workMinutes, sharedData.holidayKeys, isOutsourced,
                  componentReadyAt, startDate && !Number.isNaN(startDate.getTime()) ? startDate : null,
                  !row.component_product_id,
                );
            // BOM bileşenleri (component_product_id dolu) müşteriye teslim edilmez —
            // ana ürünün içine girer, fabrikadan çıkmaz — bu yüzden Teslimat adımı hiç
            // olmamalı (backend order_details.py include_delivery ile aynı kural).
            const blockKeysForRow = row.component_product_id
              ? (['supply', 'assembly', 'production', 'test'] as BlockKey[])
              : (['supply', 'assembly', 'production', 'test', 'delivery'] as BlockKey[]);
            const blocks: StageTimelineBlock[] = blockKeysForRow
              .filter((key) => spans[key])
              .map((key) => ({
                key,
                label: key === 'assembly' && isOutsourced ? 'Fason (Dış Dizgi)' : STAGE_BLOCK_LABELS[key],
                start: spans[key]!.start.toISOString(),
                end: spans[key]!.end.toISOString(),
              }));
            if (blocks.length > 0) {
              fullReplacements.push({ splitId: row.split_id, blocks });
              // Bileşense, bu turda hesaplanan bitişi sakla — aynı efektte SONRA
              // işlenen ana satır bunu getComponentReadyAt üzerinden kullanacak.
              if (row.parent_order_id) {
                const lastEnd = blocks.reduce<Date | null>((acc, b) => {
                  const d = new Date(b.end);
                  if (Number.isNaN(d.getTime())) return acc;
                  return !acc || d.getTime() > acc.getTime() ? d : acc;
                }, null);
                if (lastEnd) componentPreviewEndsRef.current.set(entryKey, lastEnd);
              }
            }
          }
        } else if (anyChanged) {
          const changes: BlockAdjustment[] = [];
          (['supply', 'assembly', 'production', 'test', 'delivery'] as BlockKey[]).forEach((key) => {
            const oldDays = prev[key];
            const newDays = newDaysByBlock[key];
            if (!newDays || oldDays === newDays) return;
            if (isLiteralBlock(key)) {
              changes.push({ key, setDays: newDays });
            } else if (oldDays) {
              changes.push({ key, oldAutoDays: oldDays, newAutoDays: newDays });
            }
          });
          if (changes.length > 0) pending.push({ splitId: row.split_id, changes });
        }
      }
      prevSpansRef.current.set(entryKey, newDaysByBlock);
    });

    if (pending.length > 0) {
      setTimelineAdjustments((prevMap) => {
        const next = new Map(prevMap);
        pending.forEach(({ splitId, changes }) => {
          adjustmentTokenRef.current += 1;
          next.set(splitId, { token: adjustmentTokenRef.current, changes });
        });
        return next;
      });
    }
    if (fullReplacements.length > 0) {
      setSuggestionRequests((prevMap) => {
        const next = new Map(prevMap);
        fullReplacements.forEach(({ splitId, blocks }) => {
          suggestionTokenRef.current += 1;
          next.set(splitId, { token: suggestionTokenRef.current, blocks });
        });
        return next;
      });
    }
    // matchAssignment sharedData'dan türetiliyor; ayrıca bağımlılığa gerek yok.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedData, draft, employeeDrafts, group.entries, components, stageScheduleDrafts, manualScheduleSplitIds, onHandBySplitId]);

  // "Teslimat Bitiş" tarihi değişince (yukarıdaki efekt yalnızca blok GÜN
  // SAYILARI değişince tetiklendiği, bitiş tarihinin kendisi bunu etkilemediği
  // için) zaman çizelgesindeki TÜM bloklar aynı delta kadar kaydırılır — hem
  // özel (elle ayarlanmış) hem otomatik/önerilen programlar için geçerli,
  // çünkü gün sayıları aynı kalırken yalnızca çapa tarih kaymışsa doğru sonuç
  // zaten düz bir kaymadır. Yalnızca tarih kısmı (saat/saat dilimi farkı
  // karışmasın diye) karşılaştırılır.
  useEffect(() => {
    const shifts: { splitId: string; deltaMs: number }[] = [];
    // BOM alt ürün (component) kartlarının kendi "Teslimat Bitiş" alanı da bu
    // kaymadan yararlanmalı — aksi halde bir bileşenin bitiş tarihini değiştirmek
    // kutuda görünüp bar'larda hiç yansımaz (bkz. yukarıdaki iki efektte zaten
    // uygulanan "yalnızca group.entries DEĞİL, components de" düzeltmesiyle aynı
    // gerekçe).
    const allEntriesForShift = [
      ...group.entries,
      ...(components ?? []).flatMap((c) => c.entries),
    ];
    allEntriesForShift.forEach(({ row, rowIndex }) => {
      if (!row.split_id) return;
      const entryKey = entryKeyFor(row, rowIndex);
      const endDraftKey = `${entryKey}|split_end_date`;
      const endRaw = draft.has(endDraftKey) ? draft.get(endDraftKey) : row.split_end_date;
      const endDatePart = stripDateSuffix(endRaw ?? null);
      if (!endDatePart) return;
      const prevDatePart = prevEndDatesRef.current.get(entryKey);
      if (prevDatePart !== undefined && prevDatePart !== endDatePart) {
        const prevDate = new Date(`${prevDatePart}T00:00:00`);
        const curDate = new Date(`${endDatePart}T00:00:00`);
        if (!Number.isNaN(prevDate.getTime()) && !Number.isNaN(curDate.getTime())) {
          const deltaMs = curDate.getTime() - prevDate.getTime();
          if (deltaMs !== 0) shifts.push({ splitId: row.split_id, deltaMs });
        }
      }
      prevEndDatesRef.current.set(entryKey, endDatePart);
    });
    if (shifts.length > 0) {
      setTimelineShifts((prevMap) => {
        const next = new Map(prevMap);
        shifts.forEach(({ splitId, deltaMs }) => {
          shiftTokenRef.current += 1;
          next.set(splitId, { token: shiftTokenRef.current, deltaMs });
        });
        return next;
      });
    }
  }, [draft, group.entries, components]);

  // "Üretim"/"Test" süresi, o bloğa ait dakika alanlarının (ör. üretimde kalite+
  // epoxy+conformal+montaj+montaj kalite) TOPLAMI üzerinden TEK bir yukarı
  // yuvarlama (ceil) ile hesaplanır. Bu toplam iş yükü zaten 1 günün altındaysa
  // (küçük dk/adet × adet değeri), 1 işçiyle de 1 gün, 1000 işçiyle de 1 gün
  // sürer — çünkü yukarı yuvarlama hiçbir zaman 1'in altına inmez. Bu durumda o
  // adıma işçi eklemenin süreyi kısaltması matematiksel olarak mümkün değildir;
  // kullanıcıya bunu açıklamak için "kilitli" olup olmadığını (çok yüksek bir
  // işçi sayısıyla bile süre değişmiyor mu) kontrol eder.
  const isBlockFloorLocked = (
    entryKey: string,
    row: OrderDetailRow,
    assignment: StepAssignmentRow | undefined,
    block: 'production' | 'test',
  ): boolean => {
    if (!sharedData) return false;
    const inputs = collectEntryInputs(entryKey, row, assignment);
    if (!inputs) return false;
    const { params, qty, emp, isOutsourced } = inputs;
    const current = computeNativeBlockDays(params, qty, emp, sharedData.workMinutes, isOutsourced)[block];
    if (!current) return false;
    const withManyMore = computeNativeBlockDays(
      params,
      qty,
      { ...emp, [block]: 1_000_000 },
      sharedData.workMinutes,
      isOutsourced,
    )[block];
    return current === withManyMore;
  };

  // Belirli bir parça için "şu anda sistem ne önerirdi" — mevcut adet, çalışan
  // sayısı, üretim parametreleri ve teslimat bitiş tarihine göre sıfırdan
  // hesaplanan blok seti. "Sistem Önerisi" butonu (handleRequestSuggestion) ve
  // "Özel Program" fark paneli (aşağıda, computeCustomScheduleDiff) ORTAK
  // kullanır — ikisi de "şu an doğrusu ne" sorusuna AYNI formülle cevap versin
  // diye ayrı bir kopya tutulmaz. Girdiler geçersizse ya da bitiş tarihi
  // tanımsızsa sessizce null döner (çağıran taraf kendi hata mesajını verir).
  // `paramsOverride` — normalde `inputs.params` (draft/base_data'dan okunan CANLI
  // değerler) kullanılır. "Sistem Önerisi" butonu (handleRequestSuggestion), henüz
  // draft'a YAZILMAMIŞ ama aynı tıklamada seed edilecek eşdeğer değerleri de
  // hesaba katmak için burayı geçici bir merge ile çağırır — böylece hem öneri
  // hem seed edilen kutular AYNI (React state round-trip'ine bağlı olmayan, tek
  // seferde hesaplanan) sayılardan üretilir.
  const computeSystemSuggestionBlocks = (
    entryKey: string,
    row: OrderDetailRow,
    paramsOverride?: ScheduleParams,
  ): StageTimelineBlock[] | null => {
    if (!sharedData || !row.split_id) return null;
    const assignment = matchAssignment(row.split_id);
    const inputs = collectEntryInputs(entryKey, row, assignment);
    if (!inputs) return null;
    const { qty, emp, isOutsourced } = inputs;
    const params = paramsOverride ?? inputs.params;

    const endDraftKey = `${entryKey}|split_end_date`;
    const endRaw = draft.has(endDraftKey) ? draft.get(endDraftKey) : row.split_end_date;
    const endDate = endRaw ? new Date(String(endRaw)) : null;
    if (!endDate || Number.isNaN(endDate.getTime())) return null;

    // BOM: bileşenleri varsa (ana ürün), Dizgi düşürülüp Tedarik bileşenlerle
    // eşzamanlı hesaplanır — bkz. getComponentReadyAt/computeSuggestedBlocks.
    // Bileşenin kendisinin (row.parent_order_id dolu) BOM mantığı yoktur.
    const componentReadyAt = row.parent_order_id ? null : getComponentReadyAt();

    // Tedarik, bileşenlerle PARALEL çizilir: bitişi bileşenlerin en geç bitişi
    // (componentReadyAt), başlangıcı ise bileşenlerin en erken başlangıcı. Yalnızca
    // split'in KAYITLI start_date'i verilirse çubuk kendi kısa süresi kadar kalıyor —
    // çünkü o tarih (backend calculate_split_start_date ile) ana ürünün yalnızca kendi
    // zincirinden geriye sayılarak bulunmuştu, bileşenlere hiç bakmadan. Backend'de
    // aynı düzeltme components_start_at parametresiyle yapıldı; burası onun aynası.
    const startDate = resolveScheduleStartAnchor(entryKey, row, componentReadyAt);

    const spans = computeSuggestedBlocks(
      endDate,
      qty,
      params,
      emp,
      sharedData.workMinutes,
      sharedData.holidayKeys,
      isOutsourced,
      componentReadyAt,
      startDate,
      !row.component_product_id,
    );
    // BOM bileşenleri (component_product_id dolu) müşteriye teslim edilmez — ana
    // ürünün içine girer, fabrikadan çıkmaz — bu yüzden Teslimat adımı hiç olmamalı
    // (backend order_details.py include_delivery ile aynı kural).
    const blockKeysForRow = row.component_product_id
      ? (['supply', 'assembly', 'production', 'test'] as BlockKey[])
      : (['supply', 'assembly', 'production', 'test', 'delivery'] as BlockKey[]);
    const blocks: StageTimelineBlock[] = blockKeysForRow
      .filter((key) => spans[key])
      .map((key) => ({
        key,
        label: key === 'assembly' && isOutsourced ? 'Fason (Dış Dizgi)' : STAGE_BLOCK_LABELS[key],
        start: spans[key]!.start.toISOString(),
        end: spans[key]!.end.toISOString(),
      }));
    return blocks.length > 0 ? blocks : null;
  };

  // Kaydedilmek üzere olan blok seti, o an sistemin önereceğiyle (gün bazında)
  // birebir aynı mı? "Sistem Önerisi" butonuna basıp üzerinde hiç elle değişiklik
  // yapmadan "Kaydet"e basmak GERÇEK bir özel program oluşturmamalı — aksi halde
  // içerik tamamen otomatik hesaplanabilir olsa bile split sonsuza kadar
  // "kilitlenir" (bkz. handleSave: eşleşiyorsa PUT yerine DELETE çağrılıp
  // stage_schedule temizlenir, split adet/parametre değiştikçe otomatik güncel
  // önerene göre hesaplanmaya devam eder).
  const scheduleMatchesLiveSuggestion = (splitId: string, blocks: StageTimelineBlock[]): boolean => {
    const entry = findEntryByKey(splitId);
    if (!entry) return false;
    const suggestion = computeSystemSuggestionBlocks(splitId, entry.row);
    if (!suggestion || suggestion.length !== blocks.length) return false;
    const suggByKey = new Map(suggestion.map((b) => [b.key, b]));
    return blocks.every((b) => {
      const s = suggByKey.get(b.key);
      return !!s && b.start.slice(0, 10) === s.start.slice(0, 10) && b.end.slice(0, 10) === s.end.slice(0, 10);
    });
  };

  // "Sistem Önerisi" butonu: hesaplanan öneriyi zaman çizelgesi editörüne
  // gönderir — editör bu önerilen blokların TAMAMINI uygular. Sonrasında
  // kullanıcı normal şekilde sürükleyip düzenlemeye devam edebilir (serbest kalır).
  //
  // Aynı tıklamada, Gün modunda boş bırakılmış "Üretim Parametreleri" toplam-gün
  // alanlarını (Dizgi/Üretim/Test) da barları FİİLEN süren eşdeğer (Adet Başına
  // dakika/oran verilerinden hesaplanan) değerle doldurur — böylece kutu ile bar
  // birbirini tutar. Kullanıcının ZATEN elle (ya da ürün kataloğundan) girilmiş
  // bir değere ASLA dokunulmaz — "eşdeğer" yalnızca bir TAHMİNDİR, gerçek/kasıtlı
  // bir parametreyle (ör. Dizgi=2.5) hiçbir ilgisi olmayan bambaşka bir sayı
  // (ör. 20) üretebilir, üzerine yazmak veri kaybına yol açardı.
  //
  // ÖNEMLİ: seed edilecek değerler ve öneri blokları AYNI `effectiveParams`'tan,
  // TEK bir senkron adımda hesaplanır — draft'a önce yazıp SONRA (ayrı bir
  // render'da) öneriyi yeniden hesaplamak yerine. Aksi halde iki state
  // güncellemesi (draft + suggestionRequests) arasındaki kısa an, canlı-senkron
  // efektinin henüz seed edilmemiş/edilmiş iki farklı taban arasında sahte bir
  // fark görüp otomatik olarak İKİNCİ bir tam-değiştirme tetiklemesine yol
  // açıyordu — bu da gözlenen "alt parçaları 1 gün ileri kaydırma" ve
  // yanlışlıkla "özel program (kaydedilmedi)" olarak işaretlenme hatasının
  // doğrudan sebebiydi.
  const handleRequestSuggestion = (entryKey: string, row: OrderDetailRow) => {
    if (!row.split_id || !sharedData) {
      toast.error('Bu parça için önerilecek bir zamanlama hesaplanamadı — önce geçersiz alanları veya bitiş tarihini düzeltin.');
      return;
    }
    const assignment = matchAssignment(row.split_id);
    const inputs = collectEntryInputs(entryKey, row, assignment);
    if (!inputs) {
      toast.error('Bu parça için önerilecek bir zamanlama hesaplanamadı — önce geçersiz alanları veya bitiş tarihini düzeltin.');
      return;
    }

    // Eskiden burada, Gun modunda bos birakilmis toplam-gun alanlari "esdeger"
    // degerle DOLDURULURDU. Sure modu kaldirilinca bu gereksiz VE zararli hale
    // geldi: varsayilan zaten esdeger hesap, doldurmak ise o degeri "kullanicinin
    // yazdigi" konumuna sokup adet degisince yeniden hesaplanmasini engellerdi.
    const effectiveParams: ScheduleParams = { ...inputs.params };

    const blocks = computeSystemSuggestionBlocks(entryKey, row, effectiveParams);
    if (!blocks) {
      toast.error('Bu parça için önerilecek bir zamanlama hesaplanamadı — önce geçersiz alanları veya bitiş tarihini düzeltin.');
      return;
    }

    // Çizelge ZATEN önerilenle aynıysa buton hiçbir bar'ı oynatmaz. Eskiden bu
    // durumda hiçbir geri bildirim de yoktu ve buton "çalışmıyor" gibi
    // görünüyordu — oysa yapılacak bir şey olmadığı için sessiz kalıyordu.
    // Ayrıca burada, en sık karışan noktayı da söylüyoruz: bu buton üretim
    // parametrelerine YAZILMIŞ iş günü değerlerini yok saymaz, çizelgeyi o
    // değerlerle yeniden kurar; adet başına hesaba dönmek kutunun yanındaki
    // "Öneri" rozetinin işidir.
    const currentBlocks = liveBlocksBySplit.get(row.split_id);
    const sameAsCurrent =
      !!currentBlocks &&
      currentBlocks.length === blocks.length &&
      blocks.every((b) => {
        const cur = currentBlocks.find((x) => x.key === b.key);
        return !!cur && cur.start.slice(0, 10) === b.start.slice(0, 10) && cur.end.slice(0, 10) === b.end.slice(0, 10);
      });
    if (sameAsCurrent) {
      // Çizelge önerilenle aynı olduğu halde kutulardaki iş günü değerleri adet
      // başına hesaptan FARKLI olabilir — çünkü yazılmış bir değer varsa öneri
      // zaten o değerle kurulur. En sık yanlış anlaşılan nokta bu ("Öneri: 9 gün
      // yazıyor ama Dizgi 5 gün, buton düzeltmiyor"), o yüzden hangi adımın
      // hangi sayıyla sabitlendiğini tek tek söylüyoruz.
      // Yalnızca çizelgede GERÇEKTEN yer alan adımlar listelenir: BOM ana ürününde
      // Dizgi hiç çizilmez (alt parçalarda yapılır), o satırda "Dizgi 1 gün" demek
      // olmayan bir adım hakkında bilgi vermek olurdu.
      const scheduledKeys = new Set(blocks.map((b) => b.key));
      const pinned = ([
        ['assembly_flat_days', 'assembly', 'Dizgi', assemblyEquivalentDays(inputs.params, inputs.qty, inputs.emp)],
        ['production_flat_days', 'production', 'Üretim', perUnitEquivalentDays('production', inputs.params, inputs.qty, inputs.emp, sharedData.workMinutes)],
        ['test_flat_days', 'test', 'Test', perUnitEquivalentDays('test', inputs.params, inputs.qty, inputs.emp, sharedData.workMinutes)],
      ] as const)
        .filter(([key, blockKey, , equivalent]) => {
          const typed = inputs.params[key];
          return (
            scheduledKeys.has(blockKey) &&
            (inputs.params._explicit_flat_keys ?? []).includes(key) &&
            typeof typed === 'number' &&
            typeof equivalent === 'number' &&
            Math.round(typed) !== equivalent
          );
        })
        .map(([key, , label, equivalent]) => ({
          label,
          typed: Math.round(inputs.params[key] as number),
          equivalent: equivalent as number,
        }));

      // Tek paragraflık uzun bir cümle okunmuyordu; başlık + tablo + tek satırlık
      // yönerge olarak veriliyor ki göz hangi adımın kaç gün olduğunu taramayla bulsun.
      toast(
        <div className="text-[12px] leading-snug">
          <p className="font-semibold text-surface-100">Değişen bir şey yok</p>
          {pinned.length > 0 ? (
            <>
              <p className="mt-1 text-surface-400">Çizelge, yazılmış iş günü değerleriyle zaten kurulu:</p>
              <table className="mt-1.5 w-full border-separate border-spacing-x-2 border-spacing-y-0.5">
                <tbody>
                  {pinned.map((p) => (
                    <tr key={p.label}>
                      <td className="text-surface-300 whitespace-nowrap">{p.label}</td>
                      <td className="text-right font-semibold text-surface-100 whitespace-nowrap">{p.typed} gün</td>
                      <td className="text-surface-500 whitespace-nowrap">adet başına: {p.equivalent} gün</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-surface-400">
                Adet başına hesaba dönmek için kutuyu boşaltın ya da yanındaki{' '}
                <span className="text-primary-300">Öneri</span> rozetine basın.
              </p>
            </>
          ) : (
            <p className="mt-1 text-surface-400">Çizelge zaten sistemin hesapladığıyla aynı.</p>
          )}
        </div>,
        { duration: 9000, icon: 'ℹ️', style: { maxWidth: '420px' } },
      );
      return;
    }

    suggestionTokenRef.current += 1;
    setSuggestionRequests((prev) => {
      const next = new Map(prev);
      next.set(row.split_id as string, { token: suggestionTokenRef.current, blocks });
      return next;
    });
    toast.success('Zaman çizelgesi sistem önerisine göre yeniden kuruldu.', { duration: 4000 });
  };

  // "Özel Program" farkları: bu parçanın ANLIK (kaydedilmiş ya da henüz taslak)
  // blokları, "şu anda sistem ne önerirdi" ile karşılaştırılır — yalnızca
  // GERÇEKTEN farklı olan adımlar kısa birer satırla listelenir. Süre (iş günü)
  // farklıysa "Etiket: eskiGün → yeniGün gün"; süre AYNI ama başlangıcı
  // kaymışsa "Etiket başlangıcı: eskiTarih → yeniTarih" gösterilir — ara
  // adımlar (ör. 4'ten 5'e, 5'ten 10'a) DEĞİL, doğrudan son durum.
  const computeCustomScheduleDiff = (entryKey: string, row: OrderDetailRow): string[] => {
    if (!row.split_id || !sharedData) return [];
    const liveBlocks = liveBlocksBySplit.get(row.split_id);
    if (!liveBlocks) return [];
    const suggestion = computeSystemSuggestionBlocks(entryKey, row);
    if (!suggestion) return [];
    const suggestionByKey = new Map(suggestion.map((b) => [b.key, b]));
    const fmtDate = (d: Date) => d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
    const diffs: string[] = [];
    liveBlocks.forEach((current) => {
      const sugg = suggestionByKey.get(current.key);
      if (!sugg) return;
      const curStart = new Date(current.start);
      const curEnd = new Date(current.end);
      const suggStart = new Date(sugg.start);
      const suggEnd = new Date(sugg.end);
      const curDays = countWorkdays(curStart, curEnd, sharedData.holidayKeys);
      const suggDays = countWorkdays(suggStart, suggEnd, sharedData.holidayKeys);
      if (curDays !== suggDays) {
        diffs.push(`${current.label}: ${curDays} → ${suggDays} gün`);
        return;
      }
      if (curStart.toDateString() !== suggStart.toDateString()) {
        diffs.push(`${current.label} başlangıcı: ${fmtDate(curStart)} → ${fmtDate(suggStart)}`);
      }
    });
    return diffs;
  };

  // Kullanıcı zaman çizelgesindeki bir barı elle sürükleyip bırakınca (uzatma/
  // kısaltma/taşıma) çağrılır — "Üretim Parametreleri"ndeki karşılık gelen iş günü
  // kutusuna yeni süreyi yazar, böylece iki görünüm paralel kalır. Tedarik/Teslimat
  // her zaman tek bir düz alana karşılık geldiği için her modda senkronlanır; Dizgi/
  // Üretim/Test yalnızca "Gün" modundayken (o zaman tek bir alana karşılık gelirler —
  // "Adet" modunda çoklu dakika alanına benzersiz biçimde geri çevrilemezler).
  const handleManualDurationChange = (entryKey: string, row: OrderDetailRow, blockKey: string, workdays: number) => {
    if (blockKey === 'supply') {
      const col = detailColumns.find((c) => c.key === 'supply_days');
      if (col) setField(entryKey, col, String(workdays));
      return;
    }
    if (blockKey === 'delivery') {
      const col = detailColumns.find((c) => c.key === 'delivery_days');
      if (col) setField(entryKey, col, String(workdays));
      return;
    }
    const isFlat = getFieldValue(entryKey, DURATION_MODE_COLUMN, row) !== 'per_unit';
    if (blockKey === 'assembly') {
      // Fason (dış dizgi) parçalarda "Dizgi" alanı backend _block_days'in
      // is_outsourced dalıyla aynı kuralla DOĞRUDAN/literal bir değerdir (adetle
      // çarpılmaz, işçi sayısına bölünmez), moddan BAĞIMSIZ — bu yüzden bar
      // sürüklemesi "Gün" modunda OLMASA bile (fason olduğu sürece) kutuya
      // yazılmalı, aksi halde kutu ile bar arasındaki senkron kaybolur.
      const isOutsourced = isEntryOutsourced(entryKey, row, matchAssignment(row.split_id));
      if (isOutsourced) {
        const col = detailColumns.find((c) => c.key === 'assembly_days');
        if (col) setField(entryKey, col, String(workdays));
        return;
      }
      // Fason değilse: Gün modunda "toplam gün" artık AYRI bir alanda
      // (assembly_flat_days) — assembly_days her zaman "gün/adet" (Adet Başına)
      // anlamına geldiği için oraya yazılırsa yanlış bir per-unit oranı kaydedilmiş
      // olur. Adet modunda ise (production/test ile aynı kural) senkron hiç
      // yapılmaz — süre formülden gelir, literal bir kutuya karşılık gelmez.
      if (!isFlat) return;
      setField(entryKey, ASSEMBLY_FLAT_DAYS_COLUMN, String(workdays));
      return;
    }
    if (!isFlat) return;
    if (blockKey === 'production') {
      setField(entryKey, PRODUCTION_FLAT_DAYS_COLUMN, String(workdays));
    } else if (blockKey === 'test') {
      setField(entryKey, TEST_FLAT_DAYS_COLUMN, String(workdays));
    }
  };

  const buildEmployeePayload = () => {
    const result: Array<{
      order_id: string; split_id: string | null; step_key: string; employee_count: number;
    }> = [];

    // Mevcut kayıtlı değerleri ekle — böylece backend her split için kalan kapasiteyi
    // hesaplasın. Çoklu-parçalı siparişlerin sipariş-seviyesi (split_id=null) satırı
    // sadece gösterim amaçlıdır, gerçek bir girişi temsil etmez — gönderilmez.
    for (const a of sharedData?.assignments ?? []) {
      if (a.split_id === null && a.has_multiple_splits) continue;
      for (const stepKey of ['assembly', 'production', 'test'] as const) {
        result.push({ order_id: a.order_id, split_id: a.split_id, step_key: stepKey, employee_count: a[stepKey] });
      }
    }

    // Draft varsa üzerine yaz.
    for (const { values, orderId, splitId } of employeeDrafts.values()) {
      for (const stepKey of ['assembly', 'production', 'test'] as const) {
        const existing = result.find(
          (r) => r.order_id === orderId && r.split_id === splitId && r.step_key === stepKey,
        );
        if (existing) {
          existing.employee_count = values[stepKey];
        }
      }
    }

    return result;
  };

  // Proaktif kapasite kontrolü: kullanıcı yazmayı bitirdikten kısa bir süre sonra
  // sunucuya sorulur. Eskiden HER tuş vuruşunda anında istek atılıyordu, ama
  // backend'in `_compute_concurrency_conflicts`'i (app_settings.py) sistemdeki
  // TÜM siparişleri yükleyip yeniden zamanlıyor — 3 haneli bir sayı yazmak 3 tam
  // sistem taraması tetikliyordu. 300ms'lik bir sessizlik penceresi kullanıcının
  // "anlık" hissini bozmadan bu yükü tek isteğe indirir. Yarışan (stale) yanıtlar
  // `capacityCheckIdRef` ile elenir, böylece geç dönen eski bir istek daha yeni
  // bir değeri ezmez. Sonuç (`capacityWarning`), sistemdeki TÜM siparişlerin
  // çakışmalarını içerebildiği için burada YALNIZCA bu modaldeki siparişi
  // (group.orderId) ilgilendiren çakışmalara filtrelenir — aksi halde kullanıcı
  // hiç dokunmadığı, başka bir siparişten kaynaklanan bir çakışmayı kendi
  // hatasıymış gibi görür.
  useEffect(() => {
    const payload = buildEmployeePayload();
    if (payload.length === 0) return;

    const checkId = ++capacityCheckIdRef.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          const { data } = await api.post<{
            max_concurrent_employees: number;
            conflicts: ConcurrencyConflict[];
            remaining_capacity: Record<string, Record<string, number>>;
          }>('/settings/check-concurrency', { assignments: payload });
          if (cancelled || capacityCheckIdRef.current !== checkId) return;
          setConfirmSave(false);
          const relevant = data.conflicts.filter((c) => c.steps.some((s) => s.order_id === group.orderId));
          setCapacityWarning(relevant.length > 0 ? { max: data.max_concurrent_employees, conflicts: relevant } : null);
          setRemainingCapacity(data.remaining_capacity);
        } catch (err) {
          console.warn('[kapasite] check-concurrency error:', err);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeDrafts, sharedData]);

  const renderField = (entryKey: string, row: OrderDetailRow, column: Column) => {
    const value = getFieldValue(entryKey, column, row);

    if (!canEdit) {
      const display =
        column.inputType === 'status'
          ? STATUS_STEP_OPTIONS.find((o) => o.value === value)?.label ?? value
          : formatCell(column.getValue(row));
      return <div className="px-3 py-2 text-sm text-surface-400">{display || '—'}</div>;
    }

    if (column.inputType === 'status') {
      return (
        <select
          value={value}
          onChange={(e) => setField(entryKey, column, e.target.value)}
          className={fieldInputClass}
          title={statusStepExplanation(value)}
        >
          {STATUS_STEP_OPTIONS.map(({ value: code, label }) => (
            <option key={code} value={code} title={statusStepExplanation(code)}>
              {label}
            </option>
          ))}
        </select>
      );
    }
    if (column.inputType === 'boolean') {
      return (
        <select
          value={value}
          onChange={(e) => setField(entryKey, column, e.target.value)}
          className={numberFieldInputClass}
        >
          <option value="">-</option>
          <option value="true">Evet</option>
          <option value="false">Hayır</option>
        </select>
      );
    }
    if (column.inputType === 'date') {
      return (
        <input
          type="date"
          value={value}
          onChange={(e) => setField(entryKey, column, e.target.value ? `${e.target.value}T00:00:00` : '')}
          className={fieldInputClass}
        />
      );
    }
    if (column.inputType === 'number') {
      return (
        <input
          type="number"
          step="any"
          min="0"
          value={value}
          // Süre/adet/dakika alanlarının hiçbirinde negatif değer anlamlı değil —
          // eksi işareti içeren bir girişi doğrudan reddet (kaydete kadar bekleyip
          // hata göstermek yerine).
          onChange={(e) => {
            if (e.target.value.includes('-')) return;
            setField(entryKey, column, e.target.value);
          }}
          className={numberFieldInputClass}
        />
      );
    }
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => setField(entryKey, column, e.target.value)}
        className={fieldInputClass}
      />
    );
  };

  const handleSave = async () => {
    // Üretim/Teslimat gibi sonraki adımlar, Dizgi gibi önceki bir adımın bitişinden
    // ÖNCE bitemez — fiziksel olarak imkansız bir sıralama, backend bunu engellemiyor
    // (yalnızca start<=end kontrolü var). Bu yüzden kaydetmeden ÖNCE burada tespit
    // edilip TÜM kayıt işlemi (alanlar/çizelgeler/çalışanlar dahil) durdurulur —
    // kısmi kayıt (ör. sadece geçerli parçaları kaydedip geçersiz olanı sessizce
    // atlamak), saveVersion/stageScheduleDrafts senkronizasyonunu bozup geçersiz
    // taslağın sanki kaydedilmiş gibi görünmesine yol açardı (bkz. aşağıdaki
    // refreshToken/stageScheduleDrafts temizleme mantığı).
    const scheduleEntries = Array.from(stageScheduleDrafts.entries());
    const sequenceIssues = scheduleEntries.flatMap(([splitId, blocks]) => {
      const violations = findStageSequenceViolations(blocks);
      if (violations.length === 0) return [];
      const label = splitLabelsRef.current.get(splitId) || 'Zaman çizelgesi';
      return [`${label}: ${violations.map(describeStageSequenceViolation).join(' ')}`];
    });
    if (sequenceIssues.length > 0) {
      sequenceIssues.forEach((msg) => toast.error(msg, { duration: 8000 }));
      return;
    }

    // Çalışan kapasite çakışması varsa önce onay al — ama bu YALNIZCA çalışan
    // ayarları kaydını erteler; alan/zaman çizelgesi değişiklikleri bundan
    // etkilenmeden normal şekilde kaydedilmeye devam eder (ilgisiz değişiklikleri
    // de bloklamamak için).
    const employeeSaveNeedsConfirm = employeeDrafts.size > 0 && capacityWarning && !confirmSave;
    if (employeeSaveNeedsConfirm) {
      setConfirmSave(true);
      toast(
        'Çalışan sayıları kapasite sınırını aşıyor. Diğer değişiklikler kaydedilecek; çalışan ayarlarını da kaydetmek için "Kaydet"e tekrar basın.',
        { icon: '⚠️', duration: 6000 },
      );
    } else {
      setConfirmSave(false);
    }

    const updates: { order_id: string; split_id: string | null; field_key: string; value: CellValue }[] = [];

    draft.forEach((value, key) => {
      const [entryKey, colKey] = key.split('|');
      const column = findColumn(colKey);
      if (!column) return;
      const row = entryKey === 'order' ? firstRow : findEntryByKey(entryKey)?.row;
      if (!row) return;
      if (String(value ?? '') === originalString(row, column)) return;

      updates.push({
        // group.orderId DEĞİL — row.order_id (bu satırın GERÇEK sahibi). Bileşen
        // (BOM alt ürün) satırları ana siparişten farklı bir order_id taşıyabilir;
        // sabit group.orderId göndermek backend'de bulk_update_cells'in yanlış
        // siparişin base_data'sını karıştırmasına yol açar.
        order_id: row.order_id,
        split_id: (column.recordType === 'split' || column.recordType === 'split_base_data') ? row.split_id : null,
        field_key: column.fieldKey,
        value,
      });
    });

    // Absolute-overwrite: girilen değer her zaman o anki toplam elde mevcut miktarı
    // temsil eder. Yalnızca sunucudaki KALICI değerden GERÇEKTEN farklıysa gönderilir
    // — aksi halde modal her açıldığında (ön-dolu değer aynen geri gönderilerek)
    // gereksiz bir backend yazımı ve tarih/zaman-çizelgesi yeniden hesabı tetiklenir.
    const onHandEntries = Object.entries(onHandBySplitId).filter(
      ([splitId, raw]) => (Number(raw) || 0) !== getPersistedOnHand(splitId),
    );
    onHandEntries.forEach(([splitId, raw]) => {
      const row = findEntryByKey(splitId)?.row;
      if (!row) return;
      updates.push({
        order_id: row.order_id,
        split_id: splitId,
        field_key: 'on_hand_reduction',
        value: Number(raw),
      });
    });

    if (updates.length === 0 && stageScheduleDrafts.size === 0 && employeeDrafts.size === 0) {
      return;
    }

    setIsSaving(true);
    let fieldsSaved = false;
    let schedulesSaved = false;
    let employeesSaved = false;
    const scheduleWillBeCustom = new Map<string, boolean>();

    try {
      const requests: Promise<unknown>[] = [];
      if (updates.length > 0) {
        requests.push(api.patch('/order-details/bulk-update', { updates }));
      }
      scheduleEntries.forEach(([splitId, blocks]) => {
        const matchesSuggestion = scheduleMatchesLiveSuggestion(splitId, blocks);
        scheduleWillBeCustom.set(splitId, !matchesSuggestion);
        requests.push(
          matchesSuggestion
            ? api.delete(`/order-details/splits/${splitId}/stage-schedule`)
            : api.put(`/order-details/splits/${splitId}/stage-schedule`, {
                blocks: blocks.map((b) => ({ key: b.key, start: b.start, end: b.end })),
              }),
        );
      });

      if (requests.length > 0) {
        const results = await Promise.all(requests);

        if (updates.length > 0) {
          toast.success(`${updates.length} değişiklik kaydedildi.`);
          fieldsSaved = true;
          // bulk-update yanıtı, girilen end_date'in bileşenlerin hazır olma
          // tarihiyle uyumsuz olup otomatik uzatıldığı durumları burada bildirir
          // (bkz. order_details.py bulk_update_cells — split-multi endpoint'lerindeki
          // aynı uyarı mekanizmasının hücre-düzenleme karşılığı).
          const bulkUpdateWarnings: string[] = (results[0] as any)?.data?.warnings || [];
          bulkUpdateWarnings.forEach((w) => toast(w, { icon: '⚠️', duration: 6000 }));
        }
        if (scheduleEntries.length > 0) {
          toast.success(`${scheduleEntries.length} zaman çizelgesi kaydedildi.`);
          schedulesSaved = true;
        }
        // Schedule PUT responses are appended after the (optional) bulk-update response.
        const scheduleResults = updates.length > 0 ? results.slice(1) : results;
        scheduleResults.forEach((res: any) => {
          const warnings: string[] = res?.data?.warnings || [];
          warnings.forEach((w) => toast(w, { icon: '⚠️', duration: 6000 }));
        });
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Değişiklikler kaydedilemedi.'));
    }

    // Çalışan ayarları ayrı bir çağrı: sunucu, aşırı yüklenme (concurrency) çakışması
    // varsa kaydı 409 ile reddediyor — bu diğer başarılı kaydedilen alanları
    // "başarısız" gibi göstermesin diye ayrı try/catch'te tutuluyor. Onay bekleyen
    // bir çakışma varsa (employeeSaveNeedsConfirm) bu adım atlanır — kullanıcı
    // "Kaydet"e tekrar basınca (confirmSave=true) denenir.
    if (employeeDrafts.size > 0 && !employeeSaveNeedsConfirm) {
      try {
        await api.put('/settings/step-employees', { assignments: buildEmployeePayload() });
        toast.success('Çalışan ayarları kaydedildi.');
        employeesSaved = true;
      } catch (err: any) {
        const detail = err?.response?.data?.detail;
        if (detail && typeof detail === 'object' && Array.isArray(detail.conflicts)) {
          // Çakışma detayları toast yağmuru yerine Çalışan Ayarları altındaki
          // sarı bilgi kutusunda gösterilir; burada yalnızca tek bir kısa hata verilir.
          // Sunucu SİSTEM GENELİNDEKİ tüm çakışmaları döndürür (bu siparişle ilgisiz
          // olanlar dahil) — kutuda yalnızca bu siparişi ilgilendirenler gösterilir.
          const relevant = (detail.conflicts as ConcurrencyConflict[]).filter((c) =>
            c.steps?.some((s) => s.order_id === group.orderId),
          );
          setCapacityWarning({
            max: detail.max_concurrent_employees ?? detail.conflicts[0]?.max_allowed ?? 0,
            conflicts: relevant.length > 0 ? relevant : detail.conflicts,
          });
          toast.error(detail.message || 'Çalışan ayarları çakışma nedeniyle kaydedilemedi.');
        } else {
          toast.error(getApiErrorMessage(err, 'Çalışan ayarları kaydedilemedi.'));
        }
      }
    }

    // Modal, kayıttan sonra KAPANMAZ — kullanıcı sonucu görebilsin diye açık kalır.
    // Taslaklar, onSaved() ile taze veriler geldikten SONRA temizlenir; aksi halde
    // araya giren render'da eski değerlere düşülüp zaman çizelgesi gereksiz yere
    // geri-ileri oynardı. Kaydet butonu taslaklar temizlenince otomatik pasifleşir.
    if (fieldsSaved || schedulesSaved || employeesSaved) {
      await onSaved();
      if (fieldsSaved) {
        setDraft(new Map());
        // onHandBySplitId SIFIRLANMAZ: draft'ın aksine bu, "değişen alan" değil
        // ABSOLUTE bir stok anlık görüntüsü — kaydedilen değer zaten state'te
        // doğru duruyor (bkz. state'in lazy init yorumu). Sıfırlamak, kayıttan
        // hemen sonra girdiyi boşaltıp yeniden populate eden bir efekt gerektirir
        // ki bu da tam olarak yukarıdaki "sahte diff" sorununu geri getirirdi.
      }
      if (schedulesSaved) {
        setStageScheduleDrafts(new Map());
        // Taslaklarla birlikte "elle düzenlendi" işaretleri de sıfırlanır — aksi
        // halde kayıttan sonra sistem önerisiyle birebir aynı olan bir parça bile
        // oturum boyunca "özel program" sayılmaya devam ederdi.
        setManualScheduleSplitIds(new Set());
        setScheduleCustomAfterSave((prev) => {
          const next = new Map(prev);
          scheduleWillBeCustom.forEach((value, splitId) => next.set(splitId, value));
          return next;
        });
      }
      if (employeesSaved) {
        // Kaydedilen değerleri yerel atama tabanına da işle — çalışan editörlerinin
        // ve canlı hesap fallback'inin tabanı sunucuya gitmeden güncel kalsın.
        const savedBySplit = new Map<string | null, EmployeeCapacityValues>();
        employeeDrafts.forEach(({ values, splitId }) => savedBySplit.set(splitId, values));
        setSharedData((prev) =>
          prev
            ? {
                ...prev,
                assignments: prev.assignments.map((a) => {
                  const saved = savedBySplit.get(a.split_id);
                  return saved
                    ? { ...a, assembly: saved.assembly, production: saved.production, test: saved.test }
                    : a;
                }),
              }
            : prev,
        );
        setEmployeeDrafts(new Map());
        setCapacityWarning(null);
      }
      setSaveVersion((v) => v + 1);
    }
    setIsSaving(false);
  };

  // Modal, tıklanan tek bir parçaya odaklanmış gösteriliyorsa (isFocusedOnOnePart —
  // "Parça N" satırından açıldıysa) "Siparişi Sil" de bu bağlama uyar ve YALNIZCA
  // görüntülenen o parçayı siler — aksi halde kullanıcı tek bir parçayı sildiğini
  // sanırken siparişin TAMAMI (diğer parçalar dahil) silinirdi.
  const focusedSplitId = isFocusedOnOnePart ? displayedEntries[0]?.row.split_id ?? null : null;

  const handleDeleteOrder = async () => {
    const confirmMessage = focusedSplitId
      ? 'Bu parça silinecek. Diğer parçalara dokunulmayacaktır. Bu işlem geri alınamaz. Emin misiniz?'
      : group.entries.length > 1
        ? `Bu sipariş ve ${group.entries.length} parçasının TAMAMI silinecek. Bu işlem geri alınamaz. Emin misiniz?`
        : 'Bu sipariş silinecek. Bu işlem geri alınamaz. Emin misiniz?';
    if (!window.confirm(confirmMessage)) return;
    setIsDeletingOrder(true);
    try {
      if (focusedSplitId) {
        await api.delete(`/gantt/tasks/split_${focusedSplitId}`);
        toast.success('Parça silindi');
      } else {
        await api.delete(`/order-details/orders/${group.orderId}`);
        toast.success('Sipariş silindi');
      }
      if (onDeleted) {
        await onDeleted();
      } else {
        await onSaved();
      }
      onClose();
    } catch (err) {
      toast.error(getApiErrorMessage(err, focusedSplitId ? 'Parça silinemedi.' : 'Sipariş silinemedi.'));
    } finally {
      setIsDeletingOrder(false);
    }
  };

  const toDateInputLocal = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const toIsoEndExclusiveLocal = (dateInput: string) => {
    const d = new Date(`${dateInput}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return `${toDateInputLocal(d)}T00:00:00Z`;
  };

  const originalSplitQuantity = Number(firstRow.split_quantity ?? 0) || 0;
  const splitTotalQuantity = splitSegments.reduce((acc, seg) => acc + (Number(seg.quantity) || 0), 0);
  const splitRemainingQuantity = originalSplitQuantity - splitTotalQuantity;

  const openSplitForm = () => {
    const endRaw = firstRow.split_end_date;
    const baseEnd = endRaw ? new Date(endRaw) : new Date();
    setSplitSegments([
      {
        quantity: originalSplitQuantity ? String(originalSplitQuantity) : '',
        endDate: toDateInputLocal(baseEnd),
        is_outsourced: false,
        outsource_days: '',
      },
      {
        quantity: '',
        endDate: toDateInputLocal(new Date(baseEnd.getTime() + 2 * 86400000)),
        is_outsourced: false,
        outsource_days: '',
      },
    ]);
    setSplitError('');
    setSplitFormOpen(true);

    // Abonelik panelinin varsayılanları: bir sonraki ay + mevcut bitiş tarihinin
    // günü — kullanıcı çoğunlukla "şu anki teslimattan sonraki aydan devam et"
    // isteyeceği için makul bir başlangıç noktası.
    const nextMonthDate = new Date(baseEnd.getFullYear(), baseEnd.getMonth() + 1, 1);
    setSubStartMonth(`${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}`);
    setSubDay(String(baseEnd.getDate()));
    setSubMonthly('');
    setSubMonths('');
    setSubOpen(false);
  };

  const handleSubMonthlyChange = (value: string) => {
    setSubLastEdited('monthly');
    setSubMonthly(value);
    const months = computeMonthsFromMonthly(originalSplitQuantity, parseFloat(value));
    if (months !== null) setSubMonths(String(months));
  };
  const handleSubMonthsChange = (value: string) => {
    setSubLastEdited('months');
    setSubMonths(value);
    const monthly = computeMonthlyFromMonths(originalSplitQuantity, parseInt(value, 10));
    if (monthly !== null) setSubMonthly(String(monthly));
  };

  const subComputedMonths = subLastEdited === 'months'
    ? (parseInt(subMonths, 10) > 0 ? parseInt(subMonths, 10) : null)
    : computeMonthsFromMonthly(originalSplitQuantity, parseFloat(subMonthly));

  const handleGenerateSubscriptionSegments = () => {
    const months = subComputedMonths;
    const day = parseInt(subDay, 10);
    if (!months || months < 1 || !subStartMonth || !day || day < 1 || day > 31) {
      setSplitError('Abonelik için Aylık Adet/Ay Sayısı, Başlangıç Ayı ve Gün alanlarını doldurun.');
      return;
    }
    setSplitError('');
    setSplitSegments(generateSubscriptionSegments(originalSplitQuantity, months, subStartMonth, day));
  };

  const updateSplitSegment = (index: number, field: string, value: string) => {
    setSplitError('');
    setSplitSegments((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: field === 'is_outsourced' ? value === 'true' : value } : item)),
    );
  };
  const addSplitSegment = () => {
    setSplitError('');
    setSplitSegments((prev) => {
      const last = prev[prev.length - 1];
      return [...prev, { quantity: '', endDate: last?.endDate ?? '', is_outsourced: false, outsource_days: '' }];
    });
  };
  const removeSplitSegment = (index: number) => {
    setSplitError('');
    setSplitSegments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreateSplitDelivery = async () => {
    if (splitSegments.length < 2) {
      setSplitError('En az 2 parça gerekli.');
      return;
    }
    for (const seg of splitSegments) {
      if (!seg.quantity || !seg.endDate) {
        setSplitError('Tüm parça alanlarını doldurun.');
        return;
      }
      if (parseFloat(seg.quantity) <= 0) {
        setSplitError("Parça adetleri 0'dan büyük olmalı.");
        return;
      }
      if (seg.is_outsourced && (!seg.outsource_days || parseFloat(seg.outsource_days) <= 0)) {
        setSplitError('Fason işaretlenen parçalar için Dizgi (gün) girilmeli.');
        return;
      }
    }
    if (Math.abs(splitTotalQuantity - originalSplitQuantity) > 0.001) {
      setSplitError(`Parça adet toplamı ${originalSplitQuantity} olmalı.`);
      return;
    }

    setSplitSubmitting(true);
    setSplitError('');
    try {
      const segments = splitSegments.map((seg) => ({
        quantity: parseFloat(seg.quantity),
        end_date: toIsoEndExclusiveLocal(seg.endDate),
        is_outsourced: seg.is_outsourced,
        outsource_days: seg.is_outsourced && seg.outsource_days ? parseFloat(seg.outsource_days) : undefined,
      }));
      const taskId = firstRow.split_id ? `split_${firstRow.split_id}` : `split_fake_${group.orderId}`;
      const res = await api.post(`/gantt/tasks/${taskId}/split-multi`, { segments });
      const data = res.data as { warnings?: string[] };
      if (data.warnings?.length) {
        data.warnings.forEach((w) => toast(w, { icon: '⚠️', duration: 6000 }));
      }
      setSplitFormOpen(false);
      setConversionDone(true);
      setTimeout(() => {
        setIsClosingModal(true);
        setTimeout(async () => {
          // Bölünme sonrası orijinal split_id artık yok (yeni parçalarla
          // değiştirildi) — onDeleted kullanılır, aksi halde RightPanel gibi
          // "şu an seçili görev" tutan çağıranlar artık var olmayan bu split
          // için önizleme/manuel adım durumu çekmeye çalışıp aynı yanıltıcı
          // hatayı verir (bkz. handleDeleteOrder'daki aynı düzeltme).
          if (onDeleted) {
            await onDeleted();
          } else {
            await onSaved();
          }
          onClose();
        }, 350);
      }, 1100);
    } catch (err) {
      setSplitError(getApiErrorMessage(err, 'Parçalı teslimat oluşturulamadı.'));
    } finally {
      setSplitSubmitting(false);
    }
  };

  // Bir "Ürünler/Teslimatlar" kartını (durum rozeti, zaman çizelgesi editörü,
  // temel alanlar, söz verilen tarih kutusu, Üretim Parametreleri, Çalışan Sayıları)
  // render eder — hem ana siparişin kendi parçaları HEM DE BOM bileşenleri (alt
  // ürünler) için KULLANILIR, aksi halde bileşen kartlarında sadece zaman
  // çizelgesi görünüp ürün parametreleri/çalışan sayıları hiç düzenlenemezdi.
  // `variant==='component'` iken: rozet/başlık dışarıdan verilir, tek-ürünlü-
  // sipariş mirror mantığı (firstRow=ana siparişin ilk satırı) ATLANIR (bileşenin
  // kendi promised_date/order_date'i yoktur, ana siparişinkini yanlışlıkla
  // yansıtmamak için), ve söz-verilen-tarih kutusu hiç gösterilmez (bileşenler
  // için anlamsız bir alan).
  const renderEntryCard = (
    row: OrderDetailRow,
    entryKey: string,
    variant: 'main' | 'component',
    badgeLabel: string,
    titleLabel: string,
    ownEntryCount: number,
  ) => {
    if (row.split_id) splitLabelsRef.current.set(row.split_id, titleLabel);
    const isAdvancedExpanded = !collapsedAdvanced.has(entryKey);
    const statusCol = row.split_id ? SPLIT_STATUS_COLUMN : statusColumn;
    const statusRawValue = statusCol ? String(statusCol.getRawValue(row) ?? '') : '';
    const statusExplanation = statusRawValue ? statusStepExplanation(statusRawValue) : '';
    const isSingleProduct = variant === 'main' && group.entries.length === 1;
    // BOM ana siparişlerde (bileşenleri varsa) "Dizgi" ayrı/seçilebilir bir adım
    // değildir — bileşenlerin kendi Dizgi'siyle yapılmış sayılır (bkz. backend
    // order_details.py/gantt.py'deki aynı kural). Bileşenlerin KENDİ kartında
    // (variant==='component') bu kısıtlama uygulanmaz — onlar kendi Dizgi'sini
    // normal şekilde yapar. Bu yüzden ana ürün kartında Dizgi'ye dair HİÇBİR
    // alan (durum seçeneği, Üretim Parametreleri'ndeki Dizgi süresi, Fason
    // anahtarı, Çalışan Ayarları'ndaki Dizgi kişi sayısı) gösterilmez/
    // düzenlenemez — zaten hiçbir işe yaramayacağı için kullanıcının kafasını
    // karıştırmamak adına tamamen gizlenir.
    const hasBomComponents = Boolean(components && components.length > 0);
    const dizgiDisabledForBom = variant === 'main' && hasBomComponents;
    const statusOptionsForRow = dizgiDisabledForBom
      ? STATUS_STEP_OPTIONS.filter((o) => o.value !== 'assembly')
      : STATUS_STEP_OPTIONS;

    return (
      <div key={entryKey} className="rounded-xl border border-surface-700/50 bg-surface-800/30 p-4">
        <div className="mb-3">
          <div className="flex items-center gap-2">
            <span className="badge bg-surface-700/60 text-surface-200 border border-surface-600/50">{badgeLabel}</span>
            <span className="font-medium text-surface-100 truncate">{titleLabel}</span>
            {(() => {
              // Bilinçli olarak duruma göre renk DEĞİŞTİRMEZ (statusMeta
              // kullanılmıyor) — sabit, nötr, light/dark temanın ikisinde de
              // doğru çalışan bir rozet stili. Diğer rozetlerden (ör. "Parça N")
              // BİLİNÇLİ OLARAK daha büyük/belirgin — kullanıcı bunun tıklanabilir/
              // düzenlenebilir bir alan olduğunu gözden kaçırmasın diye.
              const badgeClass =
                'inline-flex items-center rounded-lg text-sm font-semibold px-3 py-1.5 bg-surface-700/70 text-surface-100 border-2 border-surface-500/70';
              if (!statusCol || !canEdit) return <span className={badgeClass} title={statusExplanation}>{statusDisplayLabel(row)}</span>;
              const statusEntryKey = row.split_id ? entryKey : 'order';
              return (
                <select
                  value={getFieldValue(statusEntryKey, statusCol, row)}
                  onChange={(e) => setField(statusEntryKey, statusCol, e.target.value)}
                  className={`${badgeClass} cursor-pointer outline-none hover:bg-surface-600/70 hover:border-primary-500/60 transition-colors`}
                  title={statusExplanation}
                >
                  {statusOptionsForRow.map(({ value, label }) => (
                    <option key={value} value={value} title={statusStepExplanation(value)}>
                      {label}
                    </option>
                  ))}
                </select>
              );
            })()}
          </div>
          {statusExplanation && (
            <p className="mt-1.5 text-sm font-semibold text-cyan-300">{statusExplanation}</p>
          )}
        </div>

        {row.split_id && (
          <StageTimelineEditor
            splitId={row.split_id}
            employeeCounts={collectEntryInputs(entryKey, row, matchAssignment(row.split_id))?.emp}
            refreshToken={saveVersion}
            refreshedIsCustom={scheduleCustomAfterSave.get(row.split_id)}
            holidayKeys={sharedData?.holidayKeys}
            externalAdjustment={timelineAdjustments.get(row.split_id) ?? null}
            suggestedReplacement={suggestionRequests.get(row.split_id) ?? null}
            externalShift={timelineShifts.get(row.split_id) ?? null}
            readOnly={!canEdit}
            onRequestSuggestion={canEdit && sharedData ? () => handleRequestSuggestion(entryKey, row) : undefined}
            onManualDurationChange={(key, workdays) => handleManualDurationChange(entryKey, row, key, workdays)}
            onBlocksChange={(blocks) => {
              const splitId = row.split_id as string;
              setLiveBlocksBySplit((prev) => {
                const next = new Map(prev);
                next.set(splitId, blocks);
                return next;
              });
            }}
            promisedDate={variant === 'component' ? (row.promised_date || null) : (() => {
              // Tek ürünlü siparişte parça-özel alan yerine sipariş
              // geneli "Söz Verilen Tarih (Bütün Sipariş)" kullanılır —
              // aşağıdaki kutuyla aynı kural, çizelgedeki kırmızı çizgi
              // de bu kaynağı yansıtır.
              if (isSingleProduct) {
                const orderPromisedCol = columns.find((c) => c.key === 'promised_date');
                if (!orderPromisedCol) return row.promised_date || null;
                return getFieldValue('order', orderPromisedCol, firstRow) || null;
              }
              const promisedCol = columns.find((c) => c.key === 'split_promised_date');
              if (!promisedCol) return null;
              const v = getFieldValue(entryKey, promisedCol, row);
              return v || null;
            })()}
            orderDate={variant === 'component' ? (row.order_date || null) : (() => {
              const orderDateCol = columns.find((c) => c.key === 'order_date');
              if (!orderDateCol) return row.order_date || null;
              return getFieldValue('order', orderDateCol, firstRow) || null;
            })()}
            isOutsourced={isEntryOutsourced(entryKey, row, matchAssignment(row.split_id))}
            onDraftChange={(blocks, source) => {
              const splitId = row.split_id as string;
              setStageScheduleDrafts((prev) => {
                const next = new Map(prev);
                if (blocks) {
                  next.set(splitId, blocks);
                } else {
                  next.delete(splitId);
                }
                return next;
              });
              // Yalnızca ELLE yapılan düzenlemeler "özel program" sayılır; sistemin
              // otomatik yeniden hesabı bu işareti KOYMAZ (koyarsa bir sonraki
              // değişiklik kısmi ayarlamaya düşer ve adımlar üst üste biner).
              setManualScheduleSplitIds((prev) => {
                const shouldMark = Boolean(blocks) && source === 'manual';
                if (shouldMark === prev.has(splitId)) return prev;
                const next = new Set(prev);
                if (shouldMark) next.add(splitId);
                else next.delete(splitId);
                return next;
              });
            }}
          />
        )}

        {/* Ayırıcı çizgi kartın tamamını kaplasın diye grid ayrı bir kapta. */}
        <div className="mt-4 pt-4 border-t border-surface-700/50">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl [&_input]:w-full [&_select]:w-full">
            {essentialDetailColumns
              .filter((column) => !(dizgiDisabledForBom && column.key === 'fason_durumu'))
              .map((column) => (
              <div key={column.key} className={ESSENTIAL_FIELD_CELL[column.key] ?? ''}>
                <label className={fieldLabelClass}>{column.label}</label>
                {column.editable ? (
                  renderField(entryKey, row, column)
                ) : (
                  <div className="px-3 py-2 text-sm text-surface-400">{formatCell(column.getValue(row)) || '—'}</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {variant === 'component' && row.split_id && (() => {
          const quantityCol = columns.find((c) => c.key === 'split_quantity');
          const currentQty = Number((quantityCol ? getFieldValue(entryKey, quantityCol, row) : row.split_quantity) ?? 0) || 0;
          const splitKey = String(row.split_id);
          const onHandRaw = onHandBySplitId[splitKey] ?? '';
          const onHand = Math.max(0, Number(onHandRaw) || 0);
          const toProduce = Math.max(0, currentQty - onHand);
          return (
            <div className="mt-4 pt-4 border-t border-surface-700/50">
              <div className="rounded-xl border border-primary-500/30 bg-primary-500/5 p-4">
                <div className="text-[11px] uppercase tracking-wide text-primary-300/80 mb-3 font-semibold">
                  Elde Mevcut Stok
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={fieldLabelClass}>Elde Mevcut Miktar</label>
                    <input
                      type="number"
                      min={0}
                      value={onHandRaw}
                      onChange={(e) => setOnHandBySplitId((prev) => ({ ...prev, [splitKey]: e.target.value }))}
                      className={numberFieldInputClass}
                      placeholder="0"
                    />
                  </div>
                  <div>
                    <label className={fieldLabelClass}>Üretilecek Miktar</label>
                    <div className={`text-lg font-bold leading-[38px] ${toProduce === 0 && onHand > 0 ? 'text-emerald-400' : 'text-surface-100'}`}>
                      {toProduce} <span className="text-xs font-normal text-surface-400">adet</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {variant === 'main' && (() => {
          const promisedCol = columns.find((c) => c.key === 'split_promised_date');
          if (!promisedCol) return null;
          // Sipariş tek ürün/teslimattan oluşuyorsa ayrı bir parça-özel
          // söz verilen tarih tutmanın anlamı yok — kullanıcı bu kutudan
          // düzenleyemesin, değer doğrudan "Söz Verilen Tarih (Bütün
          // Sipariş)" alanından yansıtılsın (o alan zaten düzenlenebilir).
          const orderPromisedCol = isSingleProduct ? columns.find((c) => c.key === 'promised_date') : undefined;
          const mirroredValue = orderPromisedCol ? getFieldValue('order', orderPromisedCol, firstRow) : '';
          return (
            <div className="mt-4 w-fit max-w-full rounded-lg border border-surface-600/50 bg-surface-800/40 px-3 py-3 flex items-center gap-4 flex-wrap">
              <div>
                <label className={fieldLabelClass}>{promisedCol.label}</label>
                {isSingleProduct ? (
                  <div className="px-3 py-2 text-sm text-surface-400">
                    {formatCell(mirroredValue ? `${mirroredValue}T00:00:00` : '') || '—'}
                  </div>
                ) : (
                  renderField(entryKey, row, promisedCol)
                )}
              </div>
              <p className="text-xs text-surface-500 text-left max-w-[240px]">
                {isSingleProduct
                  ? 'Bu sipariş tek ürün içerdiği için bu tarih "Söz Verilen Tarih (Bütün Sipariş)" alanından geliyor — değiştirmek için o alanı düzenleyin.'
                  : 'Bu tarih yalnızca siz değiştirirseniz güncellenir — zaman çizelgesindeki bar sürüklemeleri, çalışan sayısı veya üretim parametresi değişiklikleri bu alana dokunmaz.'}
              </p>
            </div>
          );
        })()}

        {advancedDetailColumns.length > 0 && (() => {
          // Üretim Parametreleri artık YALNIZCA İş Günü modunda düzenlenebilir —
          // Adet Başına (per_unit) alanları ve mod anahtarı bu ekrandan tamamen
          // kaldırıldı; kullanıcı adet başına süreleri değiştirmek isterse Ürün
          // Bilgisi sayfasındaki ürün ana verisini düzenler. Aşağıdaki eşdeğer/öneri
          // hesapları (productionEquivalentDays vb.) buna rağmen arka planda
          // per-unit veriyi okumaya devam eder — yalnızca bu ekrandaki DÜZENLEME
          // per-unit alanları kapatıldı, zamanlama hesabı etkilenmedi.
          const isFlat = true;
          // Kutuda gösterilecek iş günü: kullanıcı bu parçaya bir değer yazdıysa o,
          // yoksa çizelgenin gerçekten kullandığı sayı (öneriyle aynı değer).
          const flatFieldValue = (
            r: OrderDetailRow,
            key: 'assembly_flat_days' | 'production_flat_days' | 'test_flat_days',
            equivalent: number | null,
          ) => {
            const stored = r.base_data?.[key] as number | null | undefined;
            const isExplicit = (r.base_data?._explicit_flat_keys as string[] | undefined)?.includes(key);
            // Motorun kuralinin AYNISI (date_utils._block_days): yalnizca kullanicinin
            // bu parcaya yazdigi deger gecerlidir; siparis-geneli base_data'da kalmis
            // eski bir toplam-gun degeri ZAMANLAMADA kullanilmaz, dolayisiyla burada
            // da gosterilmez — aksi halde kutu 2 yazarken cizelge 20 gun surerdi.
            if (isExplicit && stored) return stored;
            return equivalent ?? 1;
          };
          // Gün modunda "Üretim (iş günü, toplam)"/"Test (iş günü, toplam)"
          // alanları henüz hiç doldurulmamışsa (boş) — Adet Başına tarafındaki
          // dakika verilerinden (ilk sipariş oluşturulurken zaten girilmiş
          // olabilir) hesaplanan eşdeğer gün sayısı gösterilir/kullanılır,
          // tamamen boş kalması yerine.
          const entryInputs = sharedData ? collectEntryInputs(entryKey, row, matchAssignment(row.split_id)) : null;
          const productionEquivalentDays = entryInputs && sharedData
            ? perUnitEquivalentDays('production', entryInputs.params, entryInputs.qty, entryInputs.emp, sharedData.workMinutes)
            : null;
          const testEquivalentDays = entryInputs && sharedData
            ? perUnitEquivalentDays('test', entryInputs.params, entryInputs.qty, entryInputs.emp, sharedData.workMinutes)
            : null;
          const productionFlatCol: Column = {
            ...PRODUCTION_FLAT_DAYS_COLUMN,
            getValue: (r) => flatFieldValue(r, 'production_flat_days', productionEquivalentDays),
            getRawValue: (r) => flatFieldValue(r, 'production_flat_days', productionEquivalentDays),
          };
          const testFlatCol: Column = {
            ...TEST_FLAT_DAYS_COLUMN,
            getValue: (r) => flatFieldValue(r, 'test_flat_days', testEquivalentDays),
            getRawValue: (r) => flatFieldValue(r, 'test_flat_days', testEquivalentDays),
          };
          // Fason (dış dizgi) parçalarda Dizgi alanı backend'in is_outsourced
          // dalıyla aynı kuralla HER ZAMAN "assembly_days"i literal kullanır — Gün
          // modunda olsa bile assembly_flat_days'e bakılmaz (production/test flat
          // alanlarından farklı olarak, fason süresi zaten dış firmaya özel sabit
          // bir değerdir).
          const isEntryFason = isEntryOutsourced(entryKey, row, matchAssignment(row.split_id));
          const assemblyEquivalent = entryInputs
            ? assemblyEquivalentDays(entryInputs.params, entryInputs.qty, entryInputs.emp)
            : null;
          const assemblyFlatCol: Column = {
            ...ASSEMBLY_FLAT_DAYS_COLUMN,
            // Kutu HER ZAMAN bu parçanın gerçek iş günü sayısını gösterir. Adet Başına
            // modunda sipariş-geneli "toplam gün" değeri zamanlamada kullanılmaz —
            // orada gösterilmesi, çizelgeyle çelişen bir sayı okutur (2,5 yazarken
            // çizelgenin 40 gün sürmesi). O yüzden per_unit'te yalnızca kullanıcının
            // bu parçaya yazdığı değer, o da yoksa hesaplanan eşdeğer gösterilir.
            getValue: (r) => flatFieldValue(r, 'assembly_flat_days', assemblyEquivalent),
            getRawValue: (r) => flatFieldValue(r, 'assembly_flat_days', assemblyEquivalent),
          };
          const supplyColRaw = advancedDetailColumns.find((c) => c.key === 'supply_days');
          const assemblyColRaw = advancedDetailColumns.find((c) => c.key === 'assembly_days');
          const deliveryColRaw = advancedDetailColumns.find((c) => c.key === 'delivery_days');
          // Gün modunda Tedarik/Teslimat alanları da boş bırakılmışsa ekranda boş
          // görünmesin diye en az 1 gün gösterilir — zaten hesaplama tarafında
          // (blockDays/_block_days) aynı varsayılan uygulanıyor, ekrandaki değer
          // bununla tutarlı olsun diye.
          const supplyCol: Column | undefined = isFlat && supplyColRaw ? {
            ...supplyColRaw,
            getValue: (r) => r.base_data?.supply_days ?? 1,
            getRawValue: (r) => r.base_data?.supply_days ?? 1,
          } : supplyColRaw;
          // Fason ise Gün modunda da her zaman ham (per-unit değil, literal)
          // assembly_days gösterilir (aşağıdaki alan listesinde de assemblyFlatCol
          // yerine bu kullanılır) — production/test'in aksine Dizgi'nin fason
          // dalı hiç değişmedi.
          const assemblyColFlatLiteral: Column | undefined = isFlat && assemblyColRaw ? {
            ...assemblyColRaw,
            getValue: (r) => r.base_data?.assembly_days ?? 1,
            getRawValue: (r) => r.base_data?.assembly_days ?? 1,
          } : assemblyColRaw;
          const deliveryCol: Column | undefined = isFlat && deliveryColRaw ? {
            ...deliveryColRaw,
            getValue: (r) => r.base_data?.delivery_days ?? 1,
            getRawValue: (r) => r.base_data?.delivery_days ?? 1,
          } : deliveryColRaw;
          // Gün modunda Tedarik/Teslimat, Dizgi/Üretim/Test ile birlikte
          // sıralı (Tedarik→Dizgi→Üretim→Test→Teslimat) TEK grid'de
          // gösterildiği için "diğerleri" listesinden çıkarılır.
          const otherAdvancedColumns = advancedDetailColumns.filter((c) => {
            if (KNOWN_DURATION_FIELD_KEYS.has(c.key)) return false;
            if (isFlat && (c.key === 'supply_days' || c.key === 'delivery_days')) return false;
            return true;
          });
          return (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => toggleAdvanced(entryKey)}
                  className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-surface-500 hover:text-surface-300 transition-colors"
                >
                  <svg
                    className={`w-3 h-3 transition-transform duration-200 ${isAdvancedExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Üretim Parametreleri
                  <span className="text-surface-600">
                    ({advancedDetailColumns.filter((c) => !KNOWN_DURATION_FIELD_KEYS.has(c.key)).length - (dizgiDisabledForBom ? 1 : 0)})
                  </span>
                </button>
                {/* Bu ekrandaki bütün süre kutuları İŞ GÜNÜ cinsindendir — burada
                    "adet başına / dakika" diye bir ayar YOK, o bilgi yalnızca Ürün
                    Bilgisi sayfasında düzenlenir. Etiket bu yüzden ürünün süre
                    moduna göre değişmez, kutuların birimini söyler. */}
                {isAdvancedExpanded && (
                  <span className="text-[11px] font-medium text-surface-500">İş Günü</span>
                )}
              </div>
              {isAdvancedExpanded && (() => {
                // Tüm "Üretim Parametreleri" kutucukları TEK bir 3 sütunlu grid'de
                // (3 yatay x gerektiği kadar dikey — ör. 6 alan varsa 3x2) toplanır.
                // Yalnızca İş Günü (toplam gün) alanları gösterilir — Adet Başına
                // (per-unit dakika) alanları bu ekrandan kaldırıldı, bkz. yukarıdaki not.
                // BOM ana ürününde Tedarik, alt parçalar üretilirken paralel çalışır;
                // çubuk onların başlangıcından bitişine kadar uzar. Kullanıcıya bu
                // pencereyi tarih olarak göstermek, kutudaki "1 gün" ile çizelgedeki
                // uzun çubuk arasındaki farkı tek başına açıklıyor.
                const supplyParallelWindow = (() => {
                  if (!dizgiDisabledForBom) return null;
                  const from = getComponentStartAt();
                  const to = getComponentReadyAt();
                  if (!from || !to) return null;
                  const fmt = (d: Date) => d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
                  return `${fmt(from)} – ${fmt(to)}`;
                })();

                const fields: { key: string; label: string; column: Column }[] = [];
                if (supplyCol) fields.push({ key: supplyCol.key, label: supplyCol.label, column: supplyCol });
                // BOM ana ürünlerde Dizgi hiç gösterilmez (bkz. dizgiDisabledForBom
                // tanımı) — aksi halde ne düzenlenmesi ne de zaman çizelgesine bir
                // etkisi olan, kafa karıştırıcı bir alan olurdu.
                if (!dizgiDisabledForBom) {
                  // Fason ise Dizgi hâlâ ham/literal assembly_days'i gösterir (moddan
                  // bağımsız); değilse yeni assembly_flat_days alanı kullanılır.
                  if (isEntryFason) {
                    if (assemblyColFlatLiteral) {
                      fields.push({ key: assemblyColFlatLiteral.key, label: 'Dizgi (iş günü, toplam)', column: assemblyColFlatLiteral });
                    }
                  } else {
                    fields.push({ key: assemblyFlatCol.key, label: assemblyFlatCol.label, column: assemblyFlatCol });
                  }
                }
                fields.push({
                  key: productionFlatCol.key,
                  label: productionFlatCol.label,
                  column: productionFlatCol,
                });
                fields.push({ key: testFlatCol.key, label: testFlatCol.label, column: testFlatCol });
                if (deliveryCol) fields.push({ key: deliveryCol.key, label: deliveryCol.label, column: deliveryCol });
                otherAdvancedColumns.forEach((c) => fields.push({ key: c.key, label: c.label, column: c }));

                return (
                  <div className="mt-3 space-y-3">
                    {isFlat && (
                      <p className="text-xs text-primary-200/80 bg-primary-500/10 border border-primary-500/20 rounded-lg px-3 py-2">
                        Buradaki değerler bu teslimatın <strong>iş günü</strong> süreleridir ve yazdığınız
                        sayı kesindir: adıma kaç işçi atarsanız atayın süre değişmez, atanan işçiler yine
                        de o süre boyunca meşgul sayılır. Dokunmadığınız alanlar ürünün adet başına
                        sürelerinden hesaplanır — o süreleri <strong>Ürün Bilgisi</strong> sayfasından
                        düzenleyebilirsiniz.
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-4">
                      {fields.map(({ key, label, column }) => {
                        // Üretim/Test (iş günü, toplam) kutucuklarının sağında zaten
                        // boş yer var (kutu 96px, hücre çok daha geniş) — bu alan artık
                        // boşa gitmiyor: elimizde bu adımın "adet başına dakika" verisi
                        // varsa (productionEquivalentDays/testEquivalentDays, yukarıda
                        // zaten hesaplanıyor — perUnitEquivalentDays: toplam_dk × adet /
                        // (günlük_çalışma_dk × işçi_sayısı)) o hesaba göre bir "Öneri"
                        // rozeti gösterilir; tıklanınca değeri doğrudan kutuya yazar.
                        const suggestion =
                          key === productionFlatCol.key
                            ? productionEquivalentDays
                            : key === testFlatCol.key
                              ? testEquivalentDays
                              : key === assemblyFlatCol.key
                                ? assemblyEquivalent
                                : null;
                        return (
                          <div key={key}>
                            <label className={fieldLabelClass}>{label}</label>
                            <div className="flex items-center gap-2 flex-wrap">
                              {column.editable ? (
                                renderField(entryKey, row, column)
                              ) : (
                                <div className="px-3 py-2 text-sm text-surface-400">{formatCell(column.getValue(row)) || '—'}</div>
                              )}
                              {suggestion !== null && canEdit && (
                                <button
                                  type="button"
                                  onClick={() => setField(entryKey, column, String(suggestion))}
                                  className="text-[11px] px-2 py-1 rounded-md bg-surface-800/60 border border-surface-700/50 text-surface-400 hover:text-primary-300 hover:border-primary-500/40 transition-colors whitespace-nowrap"
                                  title="Bu adımın adet başına dakika verisine, mevcut adede ve atanan işçi sayısına göre hesaplanan öneri — tıklayınca kutuya yazılır"
                                >
                                  Öneri: {suggestion} gün
                                </button>
                              )}
                              {/* Tedarik'te tıklanabilir bir "Öneri" rozeti BİLEREK yok:
                                  alt parçalı bir siparişte çubuğun uzunluğunu buraya
                                  yazılan sayı değil, alt parçaların ne zaman hazır
                                  olduğu belirliyor. "Öneri: 84 gün" gibi bir rozet,
                                  o sayıyı kutuya yazmanın bir işe yarayacağını ima
                                  ederdi; onun yerine neden uzadığı yazılıyor. */}
                              {key === supplyCol?.key && dizgiDisabledForBom && supplyParallelWindow && (
                                <span
                                  className="text-[11px] px-2 py-1 rounded-md bg-primary-500/10 border border-primary-500/25 text-primary-300/90 whitespace-nowrap"
                                  title="Ana ürün, alt parçalar üretilirken paralel olarak tedarik yapar. Bu yüzden Tedarik çubuğu buraya yazdığınız gün sayısından uzun olabilir: alt parçaların hepsi hazır olana kadar sürer. Buraya yazdığınız değer o sürenin alt sınırıdır."
                                >
                                  Alt parçalarla paralel: {supplyParallelWindow}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {sharedData || sharedError ? (
          <EmployeeCapacityEditor
            initialValues={(() => {
              const a = matchAssignment(row.split_id);
              return a ? { assembly: a.assembly, production: a.production, test: a.test } : null;
            })()}
            isOutsourced={isEntryOutsourced(entryKey, row, matchAssignment(row.split_id))}
            readOnly={!canEdit}
            hideAssembly={dizgiDisabledForBom}
            floorLocked={{
              production: isBlockFloorLocked(entryKey, row, matchAssignment(row.split_id), 'production'),
              test: isBlockFloorLocked(entryKey, row, matchAssignment(row.split_id), 'test'),
            }}
            loadError={sharedError || undefined}
            refreshToken={saveVersion}
            capacityWarning={(() => {
              if (!capacityWarning || !row.split_id) return null;
              // Sipariş-seviyesinde filtrelenmiş listeyi bu kartta yalnızca
              // GERÇEKTEN bu split'i ilgilendiren günlerle daha da daraltır —
              // çoklu-parçalı bir siparişte tek bir parça çakışıyorsa diğer
              // parçaların kartında bu uyarı görünmesin diye.
              const perSplit = capacityWarning.conflicts.filter((c) =>
                c.steps.some((s) => s.split_id === row.split_id),
              );
              return perSplit.length > 0 ? { max: capacityWarning.max, conflicts: perSplit } : null;
            })()}
            remainingCapacity={(() => {
              const a = matchAssignment(row.split_id);
              const remKey = a ? (a.split_id || a.order_id) : null;
              return remKey ? remainingCapacity[remKey] : undefined;
            })()}
            onDraftChange={(values) => {
              setEmployeeDrafts((prev) => {
                const next = new Map(prev);
                if (values) {
                  next.set(entryKey, {
                    values,
                    orderId: row.order_id,
                    splitId: ownEntryCount > 1 ? row.split_id : null,
                  });
                } else {
                  next.delete(entryKey);
                }
                return next;
              });
            }}
          />
        ) : (
          <div className="text-xs text-surface-500 py-2 mt-3">Çalışan ayarları yükleniyor…</div>
        )}

        {(() => {
          if (!row.split_id) return null;
          const diffs = computeCustomScheduleDiff(entryKey, row);
          if (diffs.length === 0) return null;
          const isOpen = openCustomDiff.has(entryKey);
          return (
            <div className="custom-schedule-diff mt-3 rounded-lg border overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenCustomDiff((prev) => {
                  const next = new Set(prev);
                  if (next.has(entryKey)) next.delete(entryKey); else next.add(entryKey);
                  return next;
                })}
                className="custom-schedule-diff-toggle w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors"
              >
                <svg
                  className={`w-3 h-3 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Özel Program — sistem önerisinden {diffs.length} farkı var
              </button>
              {isOpen && (
                <ul className="px-3 pb-3 pl-8 space-y-1 list-disc">
                  {diffs.map((text) => (
                    <li key={text} className="custom-schedule-diff-item text-xs">{text}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
      </div>
    );
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${backdropOpaque ? 'bg-black/85' : 'bg-black/60'} backdrop-blur-sm p-6 md:p-12 transition-opacity duration-300 ${
        isClosingModal ? 'opacity-0' : 'animate-fade-in'
      }`}
      onClick={onClose}
    >
      <div
        className={`glass-card w-full max-w-[95vw] xl:max-w-[1400px] max-h-full flex flex-col overflow-hidden relative transition-all duration-300 ${
          isClosingModal ? 'opacity-0 scale-95' : 'animate-slide-up'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {conversionDone && (
          <div
            className={`absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-surface-900/95 backdrop-blur-sm transition-opacity duration-300 ${
              isClosingModal ? 'opacity-0' : 'animate-fade-in'
            }`}
          >
            <div className="w-16 h-16 rounded-full bg-emerald-500/15 border-2 border-emerald-500/40 flex items-center justify-center">
              <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-surface-100 font-medium text-lg text-center px-6">
              Sipariş parçalı teslimata dönüştürülmüştür
            </p>
          </div>
        )}
        <div className={`flex items-start justify-between gap-4 px-6 py-5 border-b border-l-4 border-surface-700/50 ${meta.rail} bg-surface-900/60`}>
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${meta.dot}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold text-white font-mono tracking-tight">{group.externalId}</h2>
                <span className={meta.badgeClass}>{STATUS_LABELS[orderStatus] ?? orderStatus}</span>
              </div>
              <p className="text-surface-400 text-sm mt-1 truncate">
                {firstRow.customer_name || 'Müşteri belirtilmemiş'} · {group.entries.length} ürün/teslimat
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-surface-400 hover:text-white hover:bg-surface-700/50 transition-colors"
            aria-label="Kapat"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-surface-200 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Sipariş Bilgileri
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {externalIdColumn && (
                <div key={externalIdColumn.key}>
                  <label className={fieldLabelClass}>{externalIdColumn.label}</label>
                  {renderField('order', firstRow, externalIdColumn)}
                </div>
              )}
              {orderColumns.map((column) => (
                <div key={column.key}>
                  <label className={fieldLabelClass}>{column.label}</label>
                  {renderField('order', firstRow, column)}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-surface-200 mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              Ürünler / Teslimatlar
              <span className="badge-info">
                {isFocusedOnOnePart ? `${displayedEntries[0].originalIndex + 1} / ${group.entries.length}` : group.entries.length}
              </span>
            </h3>
            <div className="space-y-4">
              {displayedEntries.map(({ row, rowIndex, originalIndex }) => {
                const entryKey = entryKeyFor(row, rowIndex);
                const productNameCol = columns.find((c) => c.key === 'product_name');
                const productLabel = productNameCol ? formatCell(productNameCol.getValue(row)) : row.external_id;
                return renderEntryCard(
                  row,
                  entryKey,
                  'main',
                  `Parça ${originalIndex + 1}`,
                  productLabel || `Ürün ${originalIndex + 1}`,
                  group.entries.length,
                );
              })}
            </div>
          </section>

          {components && components.length > 0 && (
            <section className="pt-2 border-t border-surface-800/70">
              <h3 className="text-sm font-semibold text-surface-200 mb-3 flex items-center gap-2">
                <svg className="w-4 h-4 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                Alt Ürünler
                <span className="badge-info">{components.length}</span>
              </h3>
              <p className="text-xs text-surface-500 mb-3">
                Bu ürünün alt ürünleri — önce bunların üretimi tamamlanır, ana ürün Dizgi'yi atlayıp bunların bitişine göre Üretim'e geçer.
              </p>
              <div className="space-y-4">
                {components.flatMap((component) => {
                  // Bileşenin KENDİSİ de parçalı teslimata bölünmüş olabilir —
                  // önceden yalnızca `entries[0]` gösterilip diğer parçalar hiç
                  // render edilmiyordu. Ana ürünün parçalarını listeleyen
                  // `displayedEntries.map(...)` ile AYNI desen: her parça için ayrı
                  // bir kart, "Parça N" rozetiyle.
                  const componentLabel = (component.entries[0].row.base_data?.product_name as string) || component.entries[0].row.external_id;
                  return component.entries.map(({ row, rowIndex }, partIndex) => {
                    const entryKey = entryKeyFor(row, rowIndex);
                    const badgeLabel = component.entries.length > 1 ? `Alt Ürün · Parça ${partIndex + 1}` : 'Alt Ürün';
                    return renderEntryCard(row, entryKey, 'component', badgeLabel, componentLabel, component.entries.length);
                  });
                })}
              </div>
            </section>
          )}

          {metaColumns.length > 0 && (
            <section className="pt-2 border-t border-surface-800/70">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-surface-500">
                {metaColumns.map((column) => (
                  <span key={column.key}>
                    {column.label}: <span className="text-surface-400">{formatCell(column.getValue(firstRow)) || '—'}</span>
                  </span>
                ))}
              </div>
            </section>
          )}

          {canEdit && group.entries.length === 1 && (
            <section className="pt-4 mt-2 border-t border-surface-800/70">
              {!splitFormOpen ? (
                <button
                  type="button"
                  onClick={openSplitForm}
                  className="btn-ghost text-sm flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4"
                    />
                  </svg>
                  Parçalı Teslimat Oluştur
                </button>
              ) : (
                <div className="rounded-lg border border-surface-700/50 bg-surface-800/30 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-surface-200">Parçalı Teslimat Oluştur</h4>
                    <button
                      type="button"
                      onClick={() => setSplitFormOpen(false)}
                      className="text-surface-400 hover:text-white text-xs"
                    >
                      Vazgeç
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-400">
                    <span>Hedef adet: {originalSplitQuantity}</span>
                    <span>Toplam: {splitTotalQuantity}</span>
                    <span className={Math.abs(splitRemainingQuantity) > 0.001 ? 'text-amber-400' : 'text-emerald-400'}>
                      Kalan: {splitRemainingQuantity}
                    </span>
                  </div>

                  <div className="rounded-md border border-primary-500/20 bg-primary-500/5">
                    <button
                      type="button"
                      onClick={() => setSubOpen((v) => !v)}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-primary-300"
                    >
                      <span>🔁 Abonelik / Aylık Otomatik Böl</span>
                      <span className="text-surface-500">{subOpen ? '▲' : '▼'}</span>
                    </button>
                    {subOpen && (
                      <div className="px-3 pb-3 space-y-2">
                        <p className="text-[11px] text-surface-400">
                          Aylık adet ya da ay sayısından birini girin (diğeri otomatik hesaplanır), başlangıç ayını ve her ay hangi gün teslim edileceğini seçip "Oluştur"a basın — aşağıdaki parça listesi buna göre yeniden üretilir. İstediğiniz ayın adedini/tarihini sonradan elle değiştirebilirsiniz.
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <label className="flex flex-col gap-1 text-xs text-surface-300">
                            Aylık Adet
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="örn: 10"
                              value={subMonthly}
                              onChange={(e) => handleSubMonthlyChange(e.target.value)}
                              className={numberFieldInputClass}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-surface-300">
                            Ay Sayısı
                            <input
                              type="number"
                              min="1"
                              step="1"
                              placeholder="örn: 15"
                              value={subMonths}
                              onChange={(e) => handleSubMonthsChange(e.target.value)}
                              className={numberFieldInputClass}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-surface-300">
                            Başlangıç Ayı
                            <input
                              type="month"
                              value={subStartMonth}
                              onChange={(e) => setSubStartMonth(e.target.value)}
                              className={fieldInputClass}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-surface-300">
                            Teslimat Günü
                            <input
                              type="number"
                              min="1"
                              max="31"
                              step="1"
                              value={subDay}
                              onChange={(e) => setSubDay(e.target.value)}
                              className={numberFieldInputClass}
                            />
                          </label>
                        </div>
                        {subComputedMonths !== null && subComputedMonths > 60 && (
                          <p className="text-[11px] text-amber-400">
                            ⚠️ Bu adet ve toplam miktara göre {subComputedMonths} ay gerekiyor (~{Math.round(subComputedMonths / 12)} yıl) — muhtemelen bir değer yanlış girildi.
                          </p>
                        )}
                        <p className="text-[10px] text-surface-500">
                          Not: seçilen gün bazı aylarda yoksa (ör. 31), o ay otomatik olarak son gününe çekilir.
                        </p>
                        <button type="button" onClick={handleGenerateSubscriptionSegments} className="btn-primary text-xs w-full">
                          {subComputedMonths ? `${subComputedMonths} Aylık Parça Oluştur` : 'Oluştur'}
                        </button>
                      </div>
                    )}
                  </div>

                  {splitSegments.map((seg, index) => (
                    <div key={index} className="rounded-md border border-surface-700/40 bg-surface-900/40 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-primary-400">Parça {index + 1}</span>
                        {splitSegments.length > 2 && (
                          <button
                            type="button"
                            onClick={() => removeSplitSegment(index)}
                            className="text-red-400 text-xs px-1"
                          >
                            Sil
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-xs text-surface-300">
                          Adet
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={seg.quantity}
                            onChange={(e) => updateSplitSegment(index, 'quantity', e.target.value)}
                            className={numberFieldInputClass}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-surface-300">
                          Bitiş (Teslimat) Tarihi
                          <input
                            type="date"
                            value={seg.endDate}
                            onChange={(e) => updateSplitSegment(index, 'endDate', e.target.value)}
                            className={fieldInputClass}
                          />
                        </label>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-surface-300">
                        <input
                          type="checkbox"
                          checked={seg.is_outsourced}
                          onChange={(e) => updateSplitSegment(index, 'is_outsourced', e.target.checked ? 'true' : 'false')}
                          className="rounded border-surface-600 bg-surface-800 text-primary-500 focus:ring-primary-500"
                        />
                        Fason Üretim
                      </label>
                      {seg.is_outsourced && (
                        <label className="flex flex-col gap-1 text-xs text-surface-300">
                          Dizgi (gün)
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={seg.outsource_days}
                            onChange={(e) => updateSplitSegment(index, 'outsource_days', e.target.value)}
                            className={numberFieldInputClass}
                          />
                        </label>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={addSplitSegment} className="btn-ghost text-xs w-full">
                    + Parça Ekle
                  </button>
                  {splitError && (
                    <div className="text-red-400 text-xs p-2 bg-red-400/10 rounded border border-red-400/20">{splitError}</div>
                  )}
                  <button
                    type="button"
                    onClick={handleCreateSplitDelivery}
                    disabled={splitSubmitting || Math.abs(splitRemainingQuantity) > 0.001}
                    title={Math.abs(splitRemainingQuantity) > 0.001 ? `Parça adetleri toplamı hedef adede eşit olmalı (kalan: ${splitRemainingQuantity})` : undefined}
                    className="btn-primary text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {splitSubmitting
                      ? 'Oluşturuluyor…'
                      : Math.abs(splitRemainingQuantity) > 0.001
                        ? `Toplam ${originalSplitQuantity} olmalı (kalan: ${splitRemainingQuantity})`
                        : 'Parçalı Teslimatı Oluştur'}
                  </button>
                </div>
              )}
            </section>
          )}

          {canEdit && (
            <section className="pt-4 mt-2 border-t border-surface-800/70 flex justify-start">
              <button
                type="button"
                onClick={handleDeleteOrder}
                disabled={isSaving || isDeletingOrder}
                className="btn-danger text-sm flex items-center gap-2"
              >
                {isDeletingOrder ? (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16"
                    />
                  </svg>
                )}
                {focusedSplitId ? 'Bu Parçayı Sil' : 'Siparişi Sil'}
              </button>
            </section>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-surface-700/50 bg-surface-900/60">
          <div className="flex flex-col gap-1 text-sm relative">
            {!canEdit ? (
              <span className="text-surface-500">Salt görüntüleme — düzenleme yetkiniz yok</span>
            ) : dirtyCount > 0 ? (
              <button
                type="button"
                onClick={() => setChangesOpen((v) => !v)}
                className="text-amber-400 font-medium inline-flex items-center gap-1 hover:text-amber-300"
              >
                {dirtyCount} değişiklik bekliyor
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${changesOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            ) : (
              <span>Değişiklik yok</span>
            )}
            {capacityWarning && dirtyCount > 0 && (
              <span className="text-xs text-red-400 leading-tight">
                ⚠️ Kapasite aşımı — çalışan sayıları aynı anda en fazla {capacityWarning.max} kişi sınırını aşıyor
              </span>
            )}

            {changesOpen && dirtyDetails.length > 0 && (
              <div className="absolute bottom-full left-0 mb-2 w-[26rem] max-w-[80vw] max-h-72 overflow-y-auto bg-surface-800 border border-surface-700 rounded-lg shadow-xl p-3 z-10">
                <p className="text-[11px] uppercase tracking-wide text-surface-500 mb-2">Bekleyen değişiklikler</p>
                <ul className="space-y-2">
                  {dirtyDetails.map((d) => (
                    <li key={d.id} className="text-xs border-b border-surface-700/50 pb-2 last:border-0 last:pb-0">
                      <div className="text-surface-400">
                        {d.entryLabel && <span className="text-surface-500">{d.entryLabel} · </span>}
                        {d.fieldLabel}
                      </div>
                      <div className="text-surface-100 mt-0.5">
                        {d.from ? (
                          <>
                            <span className="text-red-400/80 line-through">{d.from}</span>
                            {' → '}
                            <span className="text-emerald-400">{d.to}</span>
                          </>
                        ) : (
                          <span className="text-emerald-400">{d.to}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose} disabled={isSaving} className="btn-ghost text-sm">
              Kapat
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving || dirtyCount === 0 || hasScheduleSequenceIssues}
                title={hasScheduleSequenceIssues ? 'Zaman çizelgesinde sıralama hatası var — kaydetmeden önce düzeltin' : undefined}
                className={
                  hasScheduleSequenceIssues
                    ? 'text-sm flex items-center gap-2 px-6 py-2.5 rounded-xl font-medium border border-red-500/40 bg-red-500/5 text-red-300/60 cursor-not-allowed'
                    : `text-sm flex items-center gap-2 ${confirmSave ? 'btn-danger' : 'btn-primary'}`
                }
              >
                {isSaving ? (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d={confirmSave || hasScheduleSequenceIssues ? 'M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' : 'M5 13l4 4L19 7'}
                    />
                  </svg>
                )}
                {hasScheduleSequenceIssues ? 'Sıralama Hatası Var' : confirmSave ? 'Emin misin?' : 'Değişiklikleri Kaydet'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
