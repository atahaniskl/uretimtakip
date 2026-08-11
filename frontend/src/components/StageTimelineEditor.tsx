import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api';
import {
  addWorkdays,
  countWorkdays,
  describeStageSequenceViolation,
  findStageSequenceViolations,
} from '../lib/scheduleMath';

export interface StageTimelineBlock {
  key: string;
  label: string;
  start: string;
  end: string;
}

// Üst bileşenin (çalışan sayısı / üretim parametresi değişince) hesapladığı blok
// süre değişikliği — editör bunlarla ilgili bloğu BAŞLANGICI sabit tutarak yeniden
// boyutlandırır. İki mod var:
// - oldAutoDays/newAutoDays (ORANSAL — adet/formül tabanlı bloklar: dizgi/üretim/
//   test "Adet" modundayken): blok hâlâ eski otomatik süredeyse yeni otomatik
//   süreye oturur; kullanıcı elle uzattıysa/kısalttıysa mevcut süre, otomatik
//   sürelerin oranıyla ölçeklenir (örn. 1→2 işçi: elle 20 güne uzatılmış bir blok
//   10 güne iner), en az 1 gün.
// - setDays (DOĞRUDAN ATAMA — tedarik/teslimat her zaman, dizgi/üretim/test "Gün"
//   modundayken): kullanıcının yazdığı sayı KESİNDİR, oran/ölçekleme uygulanmaz —
//   blok doğrudan bu güne ayarlanır. (Oran mantığı burada kullanılırsa, örn. "20"
//   yazarken ara adım "2" ile "20" arasındaki 10× oran o anki bara uygulanıp
//   yanlışlıkla devasa bir süreye sıçrardı.)
export interface BlockAdjustment {
  key: string;
  oldAutoDays?: number;
  newAutoDays?: number;
  setDays?: number;
}

interface StageScheduleResponse {
  split_id: string;
  is_custom: boolean;
  blocks: StageTimelineBlock[];
  warnings?: string[];
}

interface StageTimelineEditorProps {
  splitId: string;
  /** Kaydedilmemiş blok listesi (yoksa null).
   *
   *  `source` KRİTİK: taslağın kullanıcının kendi sürüklemesinden mi yoksa sistemin
   *  otomatik yeniden hesabından mı geldiğini söyler. Üst bileşen "bu parçanın
   *  bekleyen bir ELLE düzenlemesi var mı?" sorusuna buna göre cevap verir —
   *  ayrım olmadan, otomatik uygulanan bir sistem önerisi de "elle düzenleme"
   *  sayılıyordu ve bir sonraki adet/parametre değişikliği artık blokları
   *  sıfırdan zincirleyen tam-değiştirme yerine, her bloğu ayrı ayrı uzatan
   *  kısmi ayarlama yoluna düşüyordu (adımlar üst üste biniyordu). */
  onDraftChange: (blocks: StageTimelineBlock[] | null, source: 'manual' | 'suggestion') => void;
  // Başarılı bir kayıttan sonra arttırılır — sunucuya tekrar gitmeden (yükleniyor
  // yanıp sönmesin diye) mevcut blokları yeni "orijinal" taban olarak işaretler.
  refreshToken?: number;
  // refreshToken ile AYNI kayıt turunda üst bileşenin (handleSave) sunucudan aldığı
  // KESİN is_custom değeri — PUT ile mi (gerçekten özel/kilitli) yoksa DELETE ile mi
  // (sistemin önerisiyle birebir aynı olduğu için temizlendi) kaydedildiği artık
  // üst bileşende zaten biliniyor, burada tahmine gerek yok. Sağlanmışsa rozet
  // ANINDA bu değere göre güncellenir — modal kapatılıp yeniden GET'e gerek kalmaz.
  refreshedIsCustom?: boolean;
  // Tatil günleri (YYYY-MM-DD) — programatik blok ayarlamaları iş günü hesabıyla
  // yapılır. (Elle sürükleme bilinçli olarak takvim günü bazlı bırakıldı.)
  holidayKeys?: Set<string>;
  // token her yeni ayarlamada artar; aynı token bir kez uygulanır.
  externalAdjustment?: { token: number; changes: BlockAdjustment[] } | null;
  // "Sistem Önerisi" butonuna basılınca üst bileşenin (mevcut çalışan sayısı ve
  // üretim parametrelerine göre) sıfırdan hesapladığı öneri — mevcut/özel blokların
  // TAMAMININ yerini alır (delta/oran değil, doğrudan değiştirme).
  suggestedReplacement?: { token: number; blocks: StageTimelineBlock[] } | null;
  // "Teslimat Bitiş" tarihi (gün sayıları AYNI kalsa bile) değişince — TÜM
  // blokları (özel/otomatik fark etmeksizin) aynı milisaniye kadar kaydırır.
  // externalAdjustment/suggestedReplacement'tan farklı olarak gün sayısı
  // değişikliğine değil, doğrudan tarih kaymasına tepki verir.
  externalShift?: { token: number; deltaMs: number } | null;
  onRequestSuggestion?: () => void;
  // Kullanıcı bir barı elle sürükleyip bıraktığında (resize/move sonrası) çağrılır —
  // üst bileşen bunu "Üretim Parametreleri"ndeki ilgili iş günü kutusuna yazarak iki
  // görünümü paralel tutar. Yalnızca sürükleme SONLANDIĞINDA (pointerup) tetiklenir,
  // her ara mousemove tıkında değil.
  onManualDurationChange?: (key: string, workdays: number) => void;
  // Bu parçaya özel, sabit "Söz Verilen Tarih" (varsa) — zaman çizelgesinde ince
  // kırmızı bir dikey çizgiyle işaretlenir, sadece görsel referans amaçlıdır.
  promisedDate?: string | null;
  // Siparişin "Sipariş Tarihi" değeri (varsa) — zaman çizelgesinde ince sarı bir
  // dikey çizgiyle işaretlenir, sadece görsel referans amaçlıdır.
  orderDate?: string | null;
  // Kullanıcı modalde "Fason Durumu"nu değiştirdiğinde (henüz kaydetmeden) "Dizgi"
  // satırının etiketi/rengi anında güncellensin diye — sunucudan gelen `labels`
  // yalnızca ilk yüklemede alınır, kaydetmeden değişikliği yansıtmaz.
  isOutsourced?: boolean;
  // VIEWER rolü gibi düzenleme yetkisi olmayan kullanıcılar için: bar sürükleme
  // devre dışı kalır, "Sistem Önerisi" butonu (üst bileşen zaten onRequestSuggestion
  // vermez) gösterilmez.
  readOnly?: boolean;
  // Bu bloğun ANLIK (kaydedilmiş ya da henüz taslak) tam blok listesini üst
  // bileşene bildirir — yükleme/sürükleme/otomatik ayarlama SONRASI her blok
  // değişiminde çağrılır (onDraftChange'in aksine, blok taban ile AYNI olsa
  // bile çağrılır). Üst bileşen bunu "şu an sistem ne önerirdi" ile
  // karşılaştırıp "Özel Program" farklarını göstermek için kullanır.
  onBlocksChange?: (blocks: StageTimelineBlock[]) => void;
  // Dizgi/Üretim/Test adımlarına atanan çalışan sayısı — barın kendi üzerinde
  // "N kişi" olarak gösterilir (bkz. "Çalışan Ayarları" bölümündeki AYNI sayı,
  // burada tekrar girmeye gerek kalmadan tek bakışta görülsün diye). Tedarik/
  // Teslimat'ın çalışan sayısı kavramı yok, bu iki anahtar hiç geçirilmez.
  employeeCounts?: Partial<Record<'assembly' | 'production' | 'test', number>>;
}

interface BlockState {
  start: Date;
  end: Date;
}

const DAY_MS = 86400000;

// HierarchicalGantt.tsx/StageView.tsx/DeliveryCalendarPage.tsx ile AYNI yöntem:
// tarihi doğrudan new Date(iso) ile parse etmek, "YYYY-MM-DD" biçimindeki (saat
// bilgisi olmayan) string'leri JS'in UTC gece yarısı olarak yorumlamasına yol
// açar — UTC'nin GERİSİNDEKİ saat dilimlerinde gösterilen gün 1 gün geriye kayar.
// substring(0,10) + 'T00:00:00' YEREL gece yarısını zorlar, diğer 3 bileşenle tutarlı.
const parseDate = (iso: string) => new Date(iso.substring(0, 10) + 'T00:00:00');
// parseDate'in TAM SİMETRİK tersi: bu bileşendeki her Date nesnesi (parseDate'ten
// ya da gün-aritmetiğinden gelir) her zaman YEREL gece yarısını temsil eder.
// `.toISOString()` GERÇEK bir UTC dönüşümü yapar — UTC'nin ÖNÜNDEKİ saat
// dilimlerinde (ör. Türkiye +3) yerel gece yarısı önceki günün akşamına denk
// gelir (ör. 15 Kasım 00:00 yerel → 14 Kasım 21:00 UTC), böylece sunucuya
// kaydedilen ve sonra parseDate ile GERİ okunan tarih 1 gün geriye kayardı
// (parseDate, dizenin ilk 10 karakterini doğrudan yerel gece yarısı sayıyor,
// gerçek UTC→yerel dönüşümü yapmıyor). Round-trip'in simetrik kalması için
// tarih bileşenleri burada da doğrudan YEREL olarak okunup yazılır.
const toDateISOString = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00.000Z`;
};
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);
const formatDM = (d: Date) => d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });

const CANONICAL_ORDER = ['supply', 'assembly', 'production', 'test', 'delivery'];

const STAGE_COLORS: Record<string, string> = {
  supply: 'bg-amber-500/80 border-amber-400/80',
  assembly: 'bg-sky-500/80 border-sky-400/80',
  production: 'bg-primary-500/80 border-primary-400/80',
  test: 'bg-fuchsia-500/80 border-fuchsia-400/80',
  delivery: 'bg-emerald-500/80 border-emerald-400/80',
};

const DEFAULT_ZOOM_PAD_PCT = 25;
const MIN_PAD_DAYS = 2;
const MAX_VISIBLE_DAYS = 182; // ~6 ay — sürgü sonuna kadar çekilince en az görülecek pencere
// Siparişin kendi süresi bu ~6 aylık tavanı zaten aşıyorsa (ör. 300 günlük bir
// sipariş), eski sabit tavan minTotalDays'e eşit ya da ondan küçük kalıyor ve
// sürgü hiçbir şey yapmaz hale geliyordu (uzaklaştırma aralığı sıfırlanıyordu).
// Bunun yerine tavan, siparişin kendi süresine göre ORANTILI olarak da büyür —
// böylece sürgü, sipariş ne kadar uzun olursa olsun her zaman anlamlı bir
// yakınlaştır/uzaklaştır aralığı sunar.
const ZOOM_OUT_FACTOR = 1.6;

const computeAxis = (blocks: Record<string, BlockState>, zoomPadPct: number, extraDates: Date[] = []) => {
  const entries = Object.values(blocks);
  if (entries.length === 0 && extraDates.length === 0) return { min: new Date(), totalDays: 1 };
  const extraTimes = extraDates.map((d) => d.getTime());
  const rawMin = Math.min(...entries.map((b) => b.start.getTime()), ...extraTimes);
  const rawMax = Math.max(...entries.map((b) => b.end.getTime()), ...extraTimes);
  const rawSpanDays = Math.max(1, Math.round((rawMax - rawMin) / DAY_MS));
  // Kenarlarda boşluk bırak — çizelge, sadece bloklara sıkışık değil daha geniş bir
  // zaman dilimini göstersin. Kullanıcı bu boşluğu (yakınlaştır/uzaklaştır) sürgüyle ayarlayabilir;
  // sürgü sonuna kadar çekilince blok aralığı ne kadar kısa olursa olsun ~6 aylık bir pencere görünür.
  const t = zoomPadPct / 100;
  const minTotalDays = rawSpanDays + MIN_PAD_DAYS * 2;
  const maxTotalDays = Math.max(minTotalDays * ZOOM_OUT_FACTOR, MAX_VISIBLE_DAYS);
  const totalDays = Math.round(minTotalDays + (maxTotalDays - minTotalDays) * t);
  const pad = Math.max(MIN_PAD_DAYS, Math.round((totalDays - rawSpanDays) / 2));
  const min = new Date(rawMin - pad * DAY_MS);
  return { min, totalDays: rawSpanDays + pad * 2 };
};

const buildDayTicks = (min: Date, totalDays: number) => {
  const maxTicks = 14;
  const step = Math.max(1, Math.ceil(totalDays / maxTicks));
  const ticks: { date: Date; leftPct: number }[] = [];
  for (let dayOffset = 0; dayOffset <= totalDays; dayOffset += step) {
    ticks.push({ date: addDays(min, dayOffset), leftPct: (dayOffset / totalDays) * 100 });
  }
  return ticks;
};

const buildMonthGroups = (min: Date, totalDays: number) => {
  const groups: { label: string; startDay: number; dayCount: number }[] = [];
  for (let i = 0; i <= totalDays; i += 1) {
    const d = addDays(min, i);
    const label = d.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.dayCount += 1;
    } else {
      groups.push({ label, startDay: i, dayCount: 1 });
    }
  }
  return groups.map((g) => ({
    ...g,
    leftPct: (g.startDay / totalDays) * 100,
    widthPct: (g.dayCount / totalDays) * 100,
  }));
};

export default function StageTimelineEditor({
  splitId,
  onDraftChange,
  refreshToken = 0,
  refreshedIsCustom,
  holidayKeys,
  externalAdjustment = null,
  suggestedReplacement = null,
  externalShift = null,
  onRequestSuggestion,
  onManualDurationChange,
  promisedDate,
  orderDate,
  isOutsourced,
  readOnly = false,
  onBlocksChange,
  employeeCounts,
}: StageTimelineEditorProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [rowOrder, setRowOrder] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<Record<string, BlockState>>({});
  // Eksen (görünen tarih aralığı) sadece ilk yüklemede ve sürgü değişince güncellenir —
  // en soldaki/sağdaki bloğu sürüklemek aralığı otomatik büyütüp küçültmesin diye
  // sürükleme sırasında değişen `blocks`'tan bilerek ayrı tutulur.
  const [axisBlocks, setAxisBlocks] = useState<Record<string, BlockState>>({});
  const [isCustom, setIsCustom] = useState(false);
  // `isCustom` sunucudan gelir ve yalnızca en son KAYDEDİLMİŞ durumu yansıtır —
  // kullanıcı bir barı sürükleyip henüz "Kaydet"e basmadıysa bu hâlâ eskisi
  // gibidir, "Özel program" rozeti yanlışlıkla gösterilmez. Kullanıcı düzenleme
  // yaparken (kaydetmeden ÖNCE) bunun farkına varması için: mevcut bloklar ilk
  // yüklemedeki taban ile (originalRef) aynı anda karşılaştırılır — fark varsa
  // "Kaydet"e basıldığında gerçekten özel program oluşacağı kesindir (bkz.
  // backend order_details.py: has_custom_schedule = bool(split.stage_schedule),
  // ve bu alan tam olarak bu taban ile şu anki bloklar arasında fark olduğunda
  // yazılıyor). Kaydetmezse hiçbir şey değişmez, özel program da oluşmamış olur.
  const [hasPendingChange, setHasPendingChange] = useState(false);
  // hasPendingChange TEK BAŞINA "kaydedilirse özel program olur" anlamına gelmez:
  // "Sistem Önerisi" butonu da (kullanıcı hiçbir bar'a dokunmadan) mevcut server
  // tabanından farklı bir sonuç üretebilir (ör. adet/parametre son kayıttan beri
  // değişmiş olabilir) — bu durumda kaydedilse bile scheduleMatchesLiveSuggestion
  // sayesinde ÖZEL PROGRAM OLUŞMAZ (bkz. OrderDetailModal.tsx handleSave). Bu
  // yüzden rozet metni, en son pending değişikliğin KAYNAĞINA göre ayrılır:
  // kullanıcı elle sürüklediyse/ayarladıysa "Özel program (kaydedilmedi)",
  // yalnızca "Sistem Önerisi"ne bastıysa "Sistem önerisi (kaydedilmedi)".
  const [pendingFromSuggestion, setPendingFromSuggestion] = useState(false);
  const [zoomPadPct, setZoomPadPct] = useState(DEFAULT_ZOOM_PAD_PCT);
  const originalRef = useRef<Record<string, { start: string; end: string }>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    key: string;
    mode: 'move' | 'resize-left' | 'resize-right';
    startX: number;
    origStart: Date;
    origEnd: Date;
    pxPerDay: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get<StageScheduleResponse>(`/order-details/splits/${splitId}/stage-schedule`)
      .then(({ data }) => {
        if (cancelled) return;
        const labelMap: Record<string, string> = {};
        const nextBlocks: Record<string, BlockState> = {};
        const snapshot: Record<string, { start: string; end: string }> = {};
        const order = [...data.blocks].sort(
          (a, b) => CANONICAL_ORDER.indexOf(a.key) - CANONICAL_ORDER.indexOf(b.key),
        );
        order.forEach((b) => {
          labelMap[b.key] = b.label;
          nextBlocks[b.key] = { start: parseDate(b.start), end: parseDate(b.end) };
          snapshot[b.key] = { start: b.start, end: b.end };
        });
        setLabels(labelMap);
        setRowOrder(order.map((b) => b.key));
        setBlocks(nextBlocks);
        setAxisBlocks(nextBlocks);
        setIsCustom(data.is_custom);
        setHasPendingChange(false);
        setPendingFromSuggestion(false);
        originalRef.current = snapshot;
        // rowOrder/labels state'e henüz yansımadığı için reportBlocks yerine
        // burada az önce hesaplanan yerel değerlerle doğrudan bildirilir.
        onBlocksChange?.(
          order.map((b) => ({
            key: b.key,
            label: labelMap[b.key] ?? b.key,
            start: toDateISOString(nextBlocks[b.key].start),
            end: toDateISOString(nextBlocks[b.key].end),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setError('Zaman çizelgesi yüklenemedi.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [splitId]);

  // Başarılı bir kayıttan sonra sunucuya TEKRAR GİTMEDEN (bu, kart içinde
  // rahatsız edici bir "yükleniyor" yanıp sönmesine sebep oluyordu) — az önce
  // kaydedilen mevcut bloklar yeni "orijinal" taban olarak işaretlenir, böylece
  // dirty karşılaştırması doğru sıfırlanır ve buton pasif hale döner.
  const isFirstRefresh = useRef(true);
  useEffect(() => {
    if (isFirstRefresh.current) {
      isFirstRefresh.current = false;
      return;
    }
    if (refreshedIsCustom !== undefined) {
      // Üst bileşen (handleSave) bu kayıt turunda PUT mu DELETE mi çağırdığını zaten
      // kesin olarak biliyor — tahmine gerek yok, rozet doğrudan bu değere göre
      // ANINDA güncellenir (modal kapatılıp GET'e gidilmeden).
      setIsCustom(refreshedIsCustom);
    } else {
      setBlocks((current) => {
        // Geri düşüş (yalnızca refreshedIsCustom sağlanmadıysa, ör. bu kayıt turu bu
        // split'in zaman çizelgesini hiç içermiyorsa): taban (originalRef — henüz
        // ESKİ hâliyle) ile şu anki bloklar arasında bir fark içeriyorsa, bu tam
        // olarak backend'in has_custom_schedule=true yazdığı durumdur (bkz. PUT
        // stage-schedule) — "Özel program" rozeti taban sıfırlandıktan (hasPendingChange=false
        // olduktan) SONRA da görünmeye devam etsin diye isCustom burada kalıcı
        // olarak true'ya çekilir.
        const original = originalRef.current;
        const changed = Object.keys(current).some((key) => {
          const b = current[key];
          const orig = original[key];
          if (!b || !orig) return false;
          return b.start.getTime() !== parseDate(orig.start).getTime() || b.end.getTime() !== parseDate(orig.end).getTime();
        });
        if (changed) setIsCustom(true);
        return current;
      });
    }

    setBlocks((current) => {
      const snapshot: Record<string, { start: string; end: string }> = {};
      Object.entries(current).forEach(([key, value]) => {
        snapshot[key] = { start: toDateISOString(value.start), end: toDateISOString(value.end) };
      });
      originalRef.current = snapshot;
      return current;
    });
    setHasPendingChange(false);
    setPendingFromSuggestion(false);
    onDraftChange(null, 'manual');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, refreshedIsCustom]);

  // "assembly" satırının etiketi: prop olarak isOutsourced verilmişse (modal canlı
  // taslak durumunu biliyorsa) o kazanır, aksi halde sunucudan gelen `labels` kullanılır.
  const effectiveLabels = useMemo(() => {
    if (isOutsourced === undefined || !('assembly' in labels)) return labels;
    return { ...labels, assembly: isOutsourced ? 'Fason (Dış Dizgi)' : 'Dizgi' };
  }, [labels, isOutsourced]);

  // `onDraftChange`'in aksine bu üst bileşene HER "yerleşmiş" durumda (yükleme,
  // otomatik ayarlama, "Sistem Önerisi", sürüklemenin SONU) güncel tam blok
  // listesini bildirir. Bilerek her `blocks` değişiminde DEĞİL — sürükleme
  // sırasında `blocks` her pointermove'da değişiyor; bunu bir useEffect'e
  // bağlamak (önceki sürüm) her mousemove'da üst bileşeni yeniden render
  // ettirip sayfayı kasıyordu. Bunun yerine yalnızca aşağıdaki "yerleşme"
  // noktalarında elle çağrılır — `onManualDurationChange` ile AYNI prensip
  // (bkz. handleUp: yalnızca pointerup'ta, her ara mousemove'da değil).
  const reportBlocks = useCallback((nextBlocks: Record<string, BlockState>) => {
    if (!onBlocksChange) return;
    onBlocksChange(
      rowOrder
        .filter((key) => nextBlocks[key])
        .map((key) => ({
          key,
          label: effectiveLabels[key] ?? key,
          start: toDateISOString(nextBlocks[key].start),
          end: toDateISOString(nextBlocks[key].end),
        })),
    );
  }, [rowOrder, effectiveLabels, onBlocksChange]);

  const promisedDateObj = useMemo(() => (promisedDate ? parseDate(promisedDate) : null), [promisedDate]);
  const orderDateObj = useMemo(() => (orderDate ? parseDate(orderDate) : null), [orderDate]);
  // Bugünün tarihi — bileşen ömrü boyunca sabit (sekme açık kalsa da her render'da
  // yeniden hesaplanıp eksen sürekli kaymasın diye bir kez hesaplanır).
  const todayObj = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  // "Bugün" ekseni ZORLA genişletmez (söz verilen/sipariş tarihi genişletir) —
  // aksi halde teslimat aylar sonraysa eksen aşırı uzayıp bloklar minicik kalırdı.
  // Bugün, mevcut görünür aralığın dışındaysa çizgi basitçe gösterilmez.
  const axis = useMemo(() => {
    const extra: Date[] = [];
    if (promisedDateObj) extra.push(promisedDateObj);
    if (orderDateObj) extra.push(orderDateObj);
    return computeAxis(axisBlocks, zoomPadPct, extra);
  }, [axisBlocks, zoomPadPct, promisedDateObj, orderDateObj]);
  const dayTicks = useMemo(() => buildDayTicks(axis.min, axis.totalDays), [axis]);
  const monthGroups = useMemo(() => buildMonthGroups(axis.min, axis.totalDays), [axis]);
  const promisedLeftPct =
    promisedDateObj != null ? (daysBetween(axis.min, promisedDateObj) / axis.totalDays) * 100 : null;
  const orderDateLeftPct =
    orderDateObj != null ? (daysBetween(axis.min, orderDateObj) / axis.totalDays) * 100 : null;
  const todayLeftPct = (daysBetween(axis.min, todayObj) / axis.totalDays) * 100;

  // Üretim/Teslimat gibi sonraki adımlar, Dizgi gibi önceki bir adımın bitişinden
  // ÖNCE bitemez — bu bloklar birbirine bağımlı bir zincir. Kullanıcı bir barı
  // sürükleyip bu kuralı bozarsa (ör. Dizgi'yi ileri tarihe çekip Üretim'i
  // olduğu yerde bırakırsa) burada tespit edilip "Kaydet" engellenir (bkz.
  // OrderDetailModal.tsx handleSave — aynı kontrol orada tekrarlanır).
  const sequenceViolations = useMemo(() => {
    const list = rowOrder
      .filter((k) => blocks[k])
      .map((k) => ({
        key: k,
        label: effectiveLabels[k] ?? k,
        start: toDateISOString(blocks[k].start),
        end: toDateISOString(blocks[k].end),
      }));
    return findStageSequenceViolations(list);
  }, [rowOrder, blocks, effectiveLabels]);

  const notifyChange = useCallback(
    (nextBlocks: Record<string, BlockState>) => {
      const original = originalRef.current;
      const changed = rowOrder.some((key) => {
        const b = nextBlocks[key];
        const orig = original[key];
        if (!b || !orig) return false;
        return b.start.getTime() !== parseDate(orig.start).getTime() || b.end.getTime() !== parseDate(orig.end).getTime();
      });
      setHasPendingChange(changed);
      // notifyChange elle sürükleme (handleUp) VE mevcut özel bir programı koruyarak
      // ayarlama (externalAdjustment/externalShift) tarafından paylaşılır — ikisi de
      // "Sistem Önerisi" değildir, bu yüzden rozet her zaman "Özel program" tarafına düşer.
      setPendingFromSuggestion(false);
      if (!changed) {
        onDraftChange(null, 'manual');
        return;
      }
      onDraftChange(
        rowOrder
          .filter((key) => nextBlocks[key])
          .map((key) => ({
            key,
            label: effectiveLabels[key] ?? key,
            start: toDateISOString(nextBlocks[key].start),
            end: toDateISOString(nextBlocks[key].end),
          })),
        // Elle sürükleme VE mevcut özel programı koruyan kısmi ayarlama — ikisi de
        // "Sistem Önerisi" değil (bkz. hemen yukarıdaki setPendingFromSuggestion(false)).
        'manual',
      );
    },
    [rowOrder, effectiveLabels, onDraftChange],
  );

  // Üst bileşenden gelen otomatik süre ayarlaması: ilgili bloğun BAŞLANGICI sabit
  // kalır, süresi iş günü bazında yeniden kurulur (bitiş tarihi buna göre kayar).
  // Kural (snap-or-scale): blok hâlâ eski otomatik süresindeyse yeni otomatik
  // süreye oturur; kullanıcı elle uzattıysa/kısalttıysa mevcut süre, otomatik
  // sürelerin oranıyla ölçeklenir (örn. 1→2 işçi: elle 20 güne uzatılmış dizgi
  // 10 güne iner), en az 1 gün.
  const appliedAdjustmentToken = useRef(0);
  useEffect(() => {
    const adj = externalAdjustment;
    if (!adj || adj.token === appliedAdjustmentToken.current || loading || !holidayKeys) return;
    appliedAdjustmentToken.current = adj.token;
    const next = { ...blocks };
    let mutated = false;
    adj.changes.forEach(({ key, oldAutoDays, newAutoDays, setDays }) => {
      const block = next[key];
      if (!block) return;
      const currentDays = Math.max(1, countWorkdays(block.start, block.end, holidayKeys));
      let newDays: number;
      if (setDays !== undefined) {
        if (setDays <= 0) return;
        newDays = Math.max(1, Math.round(setDays));
      } else {
        if (!oldAutoDays || !newAutoDays || oldAutoDays <= 0 || newAutoDays <= 0) return;
        newDays =
          currentDays === oldAutoDays
            ? Math.max(1, newAutoDays)
            : Math.max(1, Math.round((currentDays * newAutoDays) / oldAutoDays));
      }
      if (newDays === currentDays) return;
      next[key] = { start: block.start, end: addWorkdays(block.start, newDays, holidayKeys) };
      mutated = true;
    });
    if (!mutated) return;
    setBlocks(next);
    setAxisBlocks(next);
    notifyChange(next);
    reportBlocks(next);
    // `blocks` bilinçli olarak bağımlılık dışında: token koruması sayesinde her
    // ayarlama tam bir kez, o anki bloklara uygulanır (döngü riski yok).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalAdjustment, loading, holidayKeys, notifyChange, reportBlocks]);

  // "Teslimat Bitiş" tarihi değişince: gün sayıları aynı kalsa bile TÜM
  // bloklar (özel/otomatik fark etmeksizin) aynı delta kadar kaydırılır —
  // backend'in aynı alanı kaydederken uyguladığı kaymayla tutarlı (bkz.
  // order_details.py bulk-update "end_date").
  const appliedShiftToken = useRef(0);
  useEffect(() => {
    const shift = externalShift;
    if (!shift || shift.token === appliedShiftToken.current || loading || !shift.deltaMs) return;
    appliedShiftToken.current = shift.token;
    const next: Record<string, BlockState> = {};
    Object.entries(blocks).forEach(([key, block]) => {
      next[key] = {
        start: new Date(block.start.getTime() + shift.deltaMs),
        end: new Date(block.end.getTime() + shift.deltaMs),
      };
    });
    if (Object.keys(next).length === 0) return;
    setBlocks(next);
    setAxisBlocks(next);
    notifyChange(next);
    reportBlocks(next);
    // `blocks` bilinçli olarak bağımlılık dışında: token koruması sayesinde her
    // kayma tam bir kez, o anki bloklara uygulanır (döngü riski yok).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalShift, loading, notifyChange, reportBlocks]);

  // "Sistem Önerisi" butonuna basılınca: mevcut/özel blokların TAMAMI, üst
  // bileşenin sıfırdan hesapladığı önerilen blok setiyle DEĞİŞTİRİLİR (delta/oran
  // uygulanmaz — externalAdjustment'tan farklı olarak burada tam bir sıfırlama var).
  // Sonrasında kullanıcı bu önerilen blokları yine serbestçe sürükleyip düzenleyebilir.
  const appliedSuggestionToken = useRef(0);
  useEffect(() => {
    const sugg = suggestedReplacement;
    if (!sugg || sugg.token === appliedSuggestionToken.current || loading) return;
    appliedSuggestionToken.current = sugg.token;

    const ordered = [...sugg.blocks].sort(
      (a, b) => CANONICAL_ORDER.indexOf(a.key) - CANONICAL_ORDER.indexOf(b.key),
    );
    const nextBlocks: Record<string, BlockState> = {};
    const labelMap: Record<string, string> = {};
    ordered.forEach((b) => {
      nextBlocks[b.key] = { start: parseDate(b.start), end: parseDate(b.end) };
      labelMap[b.key] = b.label;
    });

    setBlocks(nextBlocks);
    setAxisBlocks(nextBlocks);
    setRowOrder(ordered.map((b) => b.key));
    setLabels(labelMap);

    // notifyChange, güncel rowOrder/labels state'i henüz yansımadan (React batching)
    // eski kapanışını kullanabileceği için burada karşılaştırma/onDraftChange
    // doğrudan yapılır — stale closure riski yok.
    const original = originalRef.current;
    const changed =
      ordered.length !== Object.keys(original).length ||
      ordered.some((b) => {
        const orig = original[b.key];
        const cur = nextBlocks[b.key];
        return !orig || cur.start.getTime() !== parseDate(orig.start).getTime() || cur.end.getTime() !== parseDate(orig.end).getTime();
      });
    setHasPendingChange(changed);
    // Bu değişiklik doğrudan "Sistem Önerisi" butonundan geldi — kullanıcı henüz
    // hiçbir bar'a dokunmadı, bu yüzden rozet "Özel program" DEĞİL "Sistem
    // önerisi" olarak gösterilmeli (bkz. yukarıdaki pendingFromSuggestion tanımı).
    setPendingFromSuggestion(changed);
    onDraftChange(
      changed
        ? ordered.map((b) => ({
            key: b.key,
            label: b.label,
            start: toDateISOString(nextBlocks[b.key].start),
            end: toDateISOString(nextBlocks[b.key].end),
          }))
        : null,
      // Sistemin kendi yeniden hesabı — kullanıcı hiçbir bara dokunmadı. Bunu
      // "elle düzenleme" saymak, sonraki adet/parametre değişikliğinde blokları
      // zincirleyen tam-değiştirme yerine kısmi ayarlamaya düşürüyordu.
      'suggestion',
    );
    // reportBlocks yerine (aynı stale-closure gerekçesiyle) burada da yerel
    // ordered/nextBlocks/labelMap ile doğrudan bildirilir.
    onBlocksChange?.(
      ordered.map((b) => ({
        key: b.key,
        label: labelMap[b.key] ?? b.key,
        start: toDateISOString(nextBlocks[b.key].start),
        end: toDateISOString(nextBlocks[b.key].end),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedReplacement, loading]);

  const startDrag = (key: string, mode: 'move' | 'resize-left' | 'resize-right', clientX: number) => {
    if (readOnly) return;
    const container = containerRef.current;
    const current = blocks[key];
    if (!container || !current) return;
    const pxPerDay = container.getBoundingClientRect().width / Math.max(1, axis.totalDays);
    dragRef.current = { key, mode, startX: clientX, origStart: current.start, origEnd: current.end, pxPerDay };
  };

  // React state-güncelleme (setState) fonksiyonları SAF olmalı — içlerinde
  // notifyChange/onManualDurationChange/reportBlocks gibi yan etkiler çalıştırmak
  // (eskiden burada yapılıyordu), React 18'in bir updater'ı zaman zaman birden
  // fazla kez çağırabildiği durumlarda (Strict Mode/concurrent render) bu yan
  // etkilerin de birden fazla kez tetiklenmesine yol açabilirdi. Bunun yerine
  // güncel `blocks` değeri bir ref'te (stale closure'a düşmeden) okunur, setState
  // ve yan etkiler AYRI/SIRALI çağrılır.
  const blocksRef = useRef(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pxPerDay <= 0) return;
      const deltaDays = Math.round((e.clientX - d.startX) / d.pxPerDay);
      const existing = blocksRef.current[d.key];
      if (!existing) return;
      let nextStart = existing.start;
      let nextEnd = existing.end;
      if (d.mode === 'move') {
        nextStart = addDays(d.origStart, deltaDays);
        nextEnd = addDays(d.origEnd, deltaDays);
      } else if (d.mode === 'resize-right') {
        const candidate = addDays(d.origEnd, deltaDays);
        nextEnd = candidate > addDays(d.origStart, 1) ? candidate : addDays(d.origStart, 1);
      } else if (d.mode === 'resize-left') {
        const candidate = addDays(d.origStart, deltaDays);
        nextStart = candidate < addDays(d.origEnd, -1) ? candidate : addDays(d.origEnd, -1);
      }
      const next = { ...blocksRef.current, [d.key]: { start: nextStart, end: nextEnd } };
      setBlocks(next);
      notifyChange(next);
    };
    const handleUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      // Sürükleme bittiğinde (yalnızca burada, her ara mousemove'da değil) ilgili
      // bloğun güncel iş günü sayısını üst bileşene bildir — "Üretim Parametreleri"
      // kutusu bunu yazıp iki görünüm paralel kalsın diye. "move" da dahil TÜM
      // sürükleme türlerinde bildirilir: takvim günü aralığı aynı kalsa bile (taşımada),
      // bloğun hangi hafta sonu/tatil günlerini kapsadığı değişebileceğinden iş günü
      // sayısı da değişebilir. Tam blok listesi de (reportBlocks) AYNI noktada bir kez
      // bildirilir — her mousemove'da değil (bkz. reportBlocks tanımındaki not).
      if (!d) return;
      const block = blocksRef.current[d.key];
      if (block && holidayKeys && onManualDurationChange) {
        const workdays = Math.max(1, countWorkdays(block.start, block.end, holidayKeys));
        onManualDurationChange(d.key, workdays);
      }
      reportBlocks(blocksRef.current);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [notifyChange, holidayKeys, onManualDurationChange, reportBlocks]);

  if (loading) {
    return <div className="text-xs text-surface-500 py-2">Zaman çizelgesi yükleniyor…</div>;
  }
  if (error || rowOrder.length === 0) {
    return <div className="text-xs text-surface-500 py-2">{error || 'Bu teslimat için zaman çizelgesi bilgisi yok.'}</div>;
  }

  return (
    <div className="mt-1">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-surface-200 flex items-center gap-2">
          <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Zaman Çizelgesi
        </h4>
        <div className="flex items-center gap-3">
          {(isCustom || hasPendingChange) && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border ${
                isCustom
                  ? 'bg-primary-500/15 text-primary-300 border-primary-500/30'
                  : pendingFromSuggestion
                    ? 'bg-primary-500/15 text-primary-300 border-primary-500/30'
                    : 'timeline-pending-badge'
              }`}
              title={
                isCustom
                  ? undefined
                  : pendingFromSuggestion
                    ? 'Çizelge sistem hesabına göre yeniden kuruldu — kaydetmezseniz bu değişiklik uygulanmaz'
                    : 'Kaydetmezseniz bu değişiklik uygulanmaz, özel program oluşmaz'
              }
            >
              {isCustom ? 'Özel program' : pendingFromSuggestion ? 'Yeniden kuruldu (kaydedilmedi)' : 'Özel program (kaydedilmedi)'}
            </span>
          )}
          {sequenceViolations.length > 0 && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30"
              title="Aşağıdaki sıralama hatalarına bakın — bu haliyle kaydedilemez"
            >
              ⚠️ {sequenceViolations.length} sıra hatası
            </span>
          )}
          <div className="flex items-center gap-1.5" title="Görünen zaman aralığını küçült/büyüt">
            <svg className="w-3.5 h-3.5 text-surface-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h4" />
            </svg>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={100 - zoomPadPct}
              onChange={(e) => setZoomPadPct(100 - Number(e.target.value))}
              className="w-20 h-1 accent-primary-500 cursor-pointer"
            />
            <svg className="w-4 h-4 text-surface-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 10h6" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 7v6" />
            </svg>
          </div>
          {/*
            Buton adı eskiden "Sistem Önerisi"ydi ve "sistemin önerdiği SÜRELERİ uygula"
            diye okunuyordu — oysa yaptığı iş barları mevcut değerlerle yeniden dizmek.
            Süre kutularına yazılmış değerlere dokunmaz; bu yüzden "Öneri: 9 gün" yazan
            bir adım 5 günde kalınca buton bozuk sanılıyordu (bkz. OrderDetailModal
            handleRequestSuggestion — aynı durumda artık açıklayıcı bir bildirim çıkar).
          */}
          {onRequestSuggestion && (
            <button
              type="button"
              onClick={onRequestSuggestion}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full bg-primary-500/15 text-primary-300 border border-primary-500/30 hover:bg-primary-500/25 transition-colors"
              title={
                'Elle sürüklediğiniz barları atar ve çizelgeyi sıfırdan kurar: mevcut adet, ' +
                'çalışan sayısı ve üretim parametrelerine göre her adımın yerini yeniden hesaplar. ' +
                'Sonrasında yine serbestçe sürükleyebilirsiniz.\n\n' +
                'Aşama SÜRELERİNİ değiştirmez: "Üretim Parametreleri" altındaki iş günü kutularına ' +
                'yazılmış değerler olduğu gibi kullanılır, üzerine yazılmaz. Bir adımı adet başına ' +
                'hesaba döndürmek için o kutuyu boşaltın ya da yanındaki "Öneri" rozetine basın.'
              }
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Çizelgeyi Yeniden Kur
            </button>
          )}
        </div>
      </div>

      {sequenceViolations.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
          <p className="text-[11px] font-semibold text-red-300 mb-1">Bu haliyle kaydedilemez — sıralama hatalı:</p>
          <ul className="list-disc list-inside space-y-0.5 text-[11px] text-red-300/90">
            {sequenceViolations.map((v, i) => (
              <li key={`${v.key}-${v.nextKey}-${i}`}>{describeStageSequenceViolation(v)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Tarih cetveli — üstte ay (günleri kapsayan aralık), altta gün numaraları */}
      <div className="ml-28 mb-5">
        <div className="relative h-5 border-b border-surface-800/60">
          {monthGroups.map((g, i) => (
            <span
              key={i}
              className="absolute inset-y-0 flex items-center justify-center text-[10px] font-medium text-surface-400 uppercase tracking-wide border-l border-surface-800/60 first:border-l-0 truncate px-1"
              style={{ left: `${g.leftPct}%`, width: `${g.widthPct}%` }}
            >
              {g.label}
            </span>
          ))}
        </div>
        <div className="relative h-4">
          {dayTicks.map((t, i) => (
            <span
              key={i}
              className="absolute text-[10px] text-surface-500 -translate-x-1/2"
              style={{ left: `${t.leftPct}%` }}
            >
              {t.date.getDate()}
            </span>
          ))}
        </div>
      </div>

      {/* Hiyerarşik satırlar — her adım kendi satırında, tarihe göre serbestçe konumlanır (üst üste binebilir) */}
      <div ref={containerRef} className="relative ml-28">
        <div className="absolute inset-0 pointer-events-none border-l border-surface-700/50" />
        {orderDateLeftPct != null && orderDateLeftPct >= 0 && orderDateLeftPct <= 100 && (
          <div
            className="absolute inset-y-0 w-0 border-l border-amber-400 pointer-events-none z-10"
            style={{ left: `${orderDateLeftPct}%` }}
            title={`Sipariş Tarihi: ${formatDM(orderDateObj as Date)}`}
          >
            <span className="absolute -top-[18px] -translate-x-1/2 text-[9px] font-semibold text-amber-400 whitespace-nowrap">
              Sipariş Tarihi
            </span>
          </div>
        )}
        {promisedLeftPct != null && promisedLeftPct >= 0 && promisedLeftPct <= 100 && (
          <div
            className="absolute inset-y-0 w-0 border-l border-red-500 pointer-events-none z-10"
            style={{ left: `${promisedLeftPct}%` }}
            title={`Söz Verilen Tarih: ${formatDM(promisedDateObj as Date)}`}
          >
            <span className="absolute -top-[18px] -translate-x-1/2 text-[9px] font-semibold text-red-400 whitespace-nowrap">
              Söz Verilen
            </span>
          </div>
        )}
        {todayLeftPct >= 0 && todayLeftPct <= 100 && (
          <div
            className="absolute inset-y-0 w-0 border-l border-dashed border-red-500/70 pointer-events-none z-10"
            style={{ left: `${todayLeftPct}%` }}
            title={`Bugün: ${formatDM(todayObj)}`}
          >
            <span className="absolute -top-[18px] -translate-x-1/2 text-[9px] font-semibold text-red-400/70 whitespace-nowrap">
              Bugün
            </span>
          </div>
        )}
        {rowOrder.map((key) => {
          const block = blocks[key];
          if (!block) return null;
          const days = Math.max(1, daysBetween(block.start, block.end));
          const leftPct = (daysBetween(axis.min, block.start) / axis.totalDays) * 100;
          const widthPct = (days / axis.totalDays) * 100;
          // Fason (dış dizgi) siparişlerde backend, "assembly" bloğunun etiketini
          // "Dizgi" yerine "Fason (Dış Dizgi)" gönderir — burada da rengi ayırt
          // edici olsun diye o duruma özel bir renk kullanılır.
          const isFasonBlock = key === 'assembly' && (effectiveLabels[key] ?? '').startsWith('Fason');
          const blockColor = isFasonBlock ? 'bg-orange-500/80 border-orange-400/80' : STAGE_COLORS[key];
          return (
            <div key={key} className="relative h-11 mb-1.5 last:mb-0">
              <span className="absolute -left-28 top-0 h-11 flex items-center w-24 text-[11px] font-medium text-surface-300 truncate">
                {effectiveLabels[key] ?? key}
              </span>
              <div className="relative h-full rounded border-t border-b border-dashed border-surface-800/60">
                <div
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startDrag(key, 'move', e.clientX);
                  }}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  className={`absolute top-0.5 h-10 rounded-md border flex flex-col justify-center px-2 ${readOnly ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} ${blockColor ?? 'bg-surface-600/70 border-surface-500/70'}`}
                  title={`${effectiveLabels[key] ?? key}: ${formatDM(block.start)} – ${formatDM(block.end)} (${days} gün)${employeeCounts?.[key as 'assembly' | 'production' | 'test'] != null ? ` · ${employeeCounts[key as 'assembly' | 'production' | 'test']} kişi` : ''}`}
                >
                  <span className="text-[11px] font-semibold text-white truncate block">
                    {effectiveLabels[key] ?? key}
                  </span>
                  <span className="text-[10px] text-white/85 truncate block">
                    {formatDM(block.start)}–{formatDM(block.end)} · {days} gün
                    {(key === 'assembly' || key === 'production' || key === 'test') && employeeCounts?.[key] != null
                      ? ` · ${employeeCounts[key]} kişi`
                      : ''}
                  </span>
                  {!readOnly && (
                    <>
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          startDrag(key, 'resize-left', e.clientX);
                        }}
                        className="absolute left-0 top-0 h-full w-2 cursor-ew-resize hover:bg-white/25"
                      />
                      <div
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          startDrag(key, 'resize-right', e.clientX);
                        }}
                        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize hover:bg-white/25"
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-surface-500 mt-2">
        {readOnly
          ? 'Salt görüntüleme — bu zaman çizelgesini düzenleme yetkiniz yok.'
          : 'Bloğun gövdesinden sürükleyerek taşıyabilir, sağ/sol kenarından çekerek süresini uzatıp kısaltabilir, adımları istediğiniz gibi üst üste getirebilirsiniz. Değişiklikler yalnızca "Değişiklikleri Kaydet" ile kalıcı olur.'}
      </p>
      {/*
        Butonun ne YAPMADIĞINI da yazmak gerekiyor: en sık yanılgı, aşağıdaki iş günü
        kutularının bu butonla adet başına hesaba döneceğini sanmak.
      */}
      {!readOnly && onRequestSuggestion && (
        <p className="text-[10px] text-surface-500 mt-1">
          <span className="text-primary-300/90">Çizelgeyi Yeniden Kur</span>: elle yaptığınız
          düzenlemeleri atıp barları mevcut adet, çalışan ve parametrelere göre yeniden dizer.
          Aşama sürelerini değiştirmez — aşağıdaki iş günü kutularına yazılmış değerler aynen
          kullanılır; bir adımı adet başına hesaba döndürmek için kutuyu boşaltın.
        </p>
      )}
    </div>
  );
}
