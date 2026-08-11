export type BlockKey = 'supply' | 'assembly' | 'production' | 'test' | 'delivery';

export interface ScheduleParams {
  supply_days?: number | null;
  assembly_days?: number | null;
  production_days?: number | null;
  outsource_days?: number | null;
  quality_minutes?: number | null;
  epoxy_minutes?: number | null;
  conformal_minutes?: number | null;
  montaj_minutes?: number | null;
  montaj_kalite_minutes?: number | null;
  test1_minutes?: number | null;
  test2_minutes?: number | null;
  final_test_minutes?: number | null;
  delivery_days?: number | null;
  // Tek "Adet/Gün" anahtarı — dizgi+üretim+test'in üçünü birden etkiler. "flat" ise
  // süreler düz TOPLAM gün olarak yorumlanır (adetle çarpılmaz); üretim/test için
  // dakika alt-alanları yerine production_flat_days/test_flat_days kullanılır.
  duration_mode?: 'per_unit' | 'flat' | null;
  production_flat_days?: number | null;
  test_flat_days?: number | null;
  // Dizgi'nin Gün (flat) modundaki "toplam gün" değeri — assembly_days'ten AYRI ve
  // bağımsız (assembly_days her zaman "gün/adet" anlamındadır, moddan bağımsız).
  assembly_flat_days?: number | null;
  // Kullanıcının BU PARÇAYA açıkça yazdığı toplam-gün alanları (backend
  // effective_product_params tarafından doldurulur, EXPLICIT_FLAT_KEYS_FIELD).
  // Böyle bir alan varsa süre modundan BAĞIMSIZ olarak o değer kesindir.
  _explicit_flat_keys?: string[] | null;
}

/** Aşamanın "toplam iş günü" alan adı — blockDays ve arayüz aynı eşlemeyi kullanır. */
export const FLAT_DAYS_KEY_BY_BLOCK: Record<'assembly' | 'production' | 'test', keyof ScheduleParams> = {
  assembly: 'assembly_flat_days',
  production: 'production_flat_days',
  test: 'test_flat_days',
};

/** Kullanıcı bu parçaya bu aşama için açıkça bir gün sayısı yazmış mı? */
export const hasExplicitFlatDays = (
  params: ScheduleParams,
  block: 'assembly' | 'production' | 'test',
): boolean => (params._explicit_flat_keys || []).includes(FLAT_DAYS_KEY_BY_BLOCK[block] as string);

export interface EmployeeCounts {
  assembly: number;
  production: number;
  test: number;
}

import { isWorkday } from './dateUtils';
import { PRODUCTION_MINUTE_KEYS, TEST_MINUTE_KEYS } from './durationMode';

const DAY_MS = 86400000;

export const parseDecimal = (value: string): number => {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return NaN;
  return Number(normalized);
};

// Tarih/is gunu temelleri tek kaynakta (lib/dateUtils.ts) — buradan re-export
// edilirler cunku mevcut cagiranlar bu modulden import ediyor.
export { dateKey, isWorkday, buildHolidayKeySet } from './dateUtils';

export const countWorkdays = (start: Date, endExclusive: Date, holidayKeys: Set<string>): number => {
  let count = 0;
  for (let t = start.getTime(); t < endExclusive.getTime(); t += DAY_MS) {
    if (isWorkday(new Date(t), holidayKeys)) count += 1;
  }
  return count;
};

export const subtractWorkdays = (endExclusive: Date, workdays: number, holidayKeys: Set<string>): Date => {
  if (workdays <= 0) return endExclusive;
  let remaining = workdays;
  let current = endExclusive.getTime();
  while (remaining > 0) {
    current -= DAY_MS;
    if (isWorkday(new Date(current), holidayKeys)) remaining -= 1;
  }
  return new Date(current);
};

// subtractWorkdays'in tam tersi: başlangıç sabit kalır, bitiş tarihi ileri doğru
// hesaplanır — countWorkdays(startInclusive, sonuç) === workdays olacak şekilde.
export const addWorkdays = (startInclusive: Date, workdays: number, holidayKeys: Set<string>): Date => {
  if (workdays <= 0) return startInclusive;
  let remaining = workdays;
  let current = startInclusive.getTime();
  while (remaining > 0) {
    if (isWorkday(new Date(current), holidayKeys)) remaining -= 1;
    current += DAY_MS;
  }
  return new Date(current);
};

const num = (v: number | null | undefined): number | null =>
  v === null || v === undefined || Number.isNaN(v) ? null : v;

const safeNum = (v: number | null | undefined): number =>
  (v === null || v === undefined || Number.isNaN(v)) ? 0 : v;

// Python'un round() davranışını taklit eder ("round half to even" / bankacı
// yuvarlaması) — backend date_utils.py'deki round() ile birebir aynı sonucu
// vermek için. JS'in Math.round'u tam ".5" değerleri HER ZAMAN yukarı yuvarlar
// (ör. 2.5 → 3), Python ise en yakın ÇİFT sayıya yuvarlar (2.5 → 2, 3.5 → 4) —
// bu farkı hesaba katmazsak önizleme ile backend'in kaydettiği gün sayısı
// ".5" girişlerde (ör. 2.5 günlük dizgi süresi) birbirinden sapabilir.
const pythonRound = (value: number): number => {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
};

// Alan listeleri lib/durationMode.ts'te — backend date_utils.py'deki
// _PRODUCTION_MINUTE_FIELDS/_TEST_MINUTE_FIELDS ile aynı kümeyi temsil eder.
// Toplama TEK SEFERDE yapılır (her alanı ayrı ayrı yuvarlayıp toplamak farklı
// sonuç verir — bkz. deliveryPlanMath.ts başındaki not).
const sumMinuteFields = (params: ScheduleParams, keys: readonly string[]): number =>
  keys.reduce((total, key) => total + safeNum((params as Record<string, number | null | undefined>)[key]), 0);

const productionMinutesTotal = (params: ScheduleParams): number =>
  sumMinuteFields(params, PRODUCTION_MINUTE_KEYS);

const testMinutesTotal = (params: ScheduleParams): number =>
  sumMinuteFields(params, TEST_MINUTE_KEYS);

// Adet Başına (per-unit) taraftaki dakika alanlarından hesaplanan gün sayısı —
// Gün moduna geçildiğinde "iş günü, toplam" alanı henüz hiç doldurulmamışsa (boş)
// bunun yerine gösterilecek/kullanılacak varsayılan değer budur: kullanıcı ilk
// siparişi oluştururken (ya da Adet modunda) zaten girdiği süre boşa gitmesin,
// aynı hesap Gün moduna da taşınsın diye. Hiç dakika verisi yoksa null döner.
export const perUnitEquivalentDays = (
  key: 'production' | 'test',
  params: ScheduleParams,
  qty: number,
  emp: EmployeeCounts,
  workMinutes: number,
): number | null => {
  const totalMinutes = key === 'production' ? productionMinutesTotal(params) : testMinutesTotal(params);
  if (totalMinutes <= 0) return null;
  const empCount = (key === 'production' ? emp.production : emp.test) || 1;
  return Math.max(1, Math.ceil((totalMinutes * qty) / (workMinutes * empCount)));
};

// Dizgi'nin Adet Başına ("gün/adet") tarafından hesaplanan gün sayısı — perUnitEquivalentDays
// ile aynı amaç (Gün moduna geçildiğinde "toplam gün" alanı boşsa gösterilecek/kullanılacak
// eşdeğer), ama Dizgi'nin dakika alt-alanları olmadığı için (tek bir "gün/adet" sayısı var)
// ayrı, küçük bir yardımcı. Backend date_utils.py _block_days'teki "equivalent" hesabıyla
// birebir aynı formül.
export const assemblyEquivalentDays = (
  params: ScheduleParams,
  qty: number,
  emp: EmployeeCounts,
): number | null => {
  const assemblyDays = num(params.production_days) || num(params.assembly_days);
  if (assemblyDays === null || assemblyDays <= 0) return null;
  return Math.max(1, Math.ceil((assemblyDays * qty) / (emp.assembly || 1)));
};

/** Backend `_block_days` aynası — bir bloğun iş günü süresi, yoksa null. */
export const blockDays = (
  key: BlockKey,
  params: ScheduleParams,
  qty: number,
  emp: EmployeeCounts,
  workMinutes: number,
  isOutsourced: boolean,
): number | null => {
  if (key === 'supply') {
    // Tedarik de Teslimat gibi en az 1 gün var sayılır (girilmemiş/0 olsa bile) —
    // aksi halde Gün modunda boş bırakılan bu alan yüzünden Tedarik bloğu hiç
    // oluşmaz (bkz. delivery'deki aynı gerekçe).
    const supplyDays = num(params.supply_days);
    return supplyDays && supplyDays > 0 ? supplyDays : 1;
  }
  // duration_mode hiç ayarlanmamışsa (null/undefined) varsayılan olarak "flat"
  // (İş Günü) kabul edilir — yalnızca kullanıcı açıkça "per_unit" (Adet Başına)
  // seçtiyse o değer kullanılır (backend date_utils.py _block_days ile aynı kural).
  // Kuralın kendisi lib/durationMode.ts'te; arayüz ekranları da oradan okur.
  // SÜRE MODU YOK — varsayılan süre HER ZAMAN adet başına veriden hesaplanır.
  // Tek istisna: kullanıcının bu parçaya açıkça yazdığı toplam gün sayısı; o değer
  // kesindir (backend date_utils.py _resolve_flat ile birebir aynı kural).
  const resolveFlat = (block: 'assembly' | 'production' | 'test'): number | null => {
    const flat = num(params[FLAT_DAYS_KEY_BY_BLOCK[block]] as number | null | undefined);
    if (hasExplicitFlatDays(params, block) && flat && flat > 0) return Math.max(1, pythonRound(flat));
    return null;
  };
  if (key === 'assembly') {
    const assemblyDays = num(params.production_days) || num(params.assembly_days);
    // Fason (dış dizgi): iş dışarıda yapılır, iş yükü hesaplanmaz — kullanıcının
    // Dizgi alanına girdiği gün sayısı DOĞRUDAN kullanılır (adetle çarpılmaz, işçi
    // sayısına bölünmez), moddan (flat/per_unit) BAĞIMSIZ. Eskiden ayrı bir
    // outsource_days alanı gerekiyordu — artık aynı Dizgi alanı (assembly_days)
    // fason parçalarda da kullanılıyor (backend date_utils.py ile birebir aynı
    // kural). Boş bırakılırsa (Gün modunda bar oluşmasın diye) en az 1 gün var sayılır.
    if (isOutsourced) {
      const days = assemblyDays && assemblyDays > 0 ? assemblyDays : 1;
      return Math.max(1, pythonRound(days));
    }
    // assemblyDays artık HER ZAMAN "gün/adet" (Adet Başına) anlamına gelir — Gün
    // modundaki "toplam gün" ayrı bir alanda (assembly_flat_days) tutulur,
    // production_flat_days/test_flat_days ile aynı desen.
    const equivalent = assemblyEquivalentDays(params, qty, emp);
    return resolveFlat('assembly') ?? equivalent ?? 1;
  }
  if (key === 'production') {
    // Gün modunda alan boşsa: Adet Başına tarafındaki dakika verilerinden hesaplanan
    // eşdeğer gün sayısına düşülür (kullanıcının zaten girdiği süre kaybolmasın diye);
    // o da yoksa en az 1 gün var sayılır.
    const equivalent = perUnitEquivalentDays('production', params, qty, emp, workMinutes);
    return resolveFlat('production') ?? equivalent ?? 1;
  }
  if (key === 'test') {
    const equivalent = perUnitEquivalentDays('test', params, qty, emp, workMinutes);
    return resolveFlat('test') ?? equivalent ?? 1;
  }
  if (key === 'delivery') {
    // Teslimat adımı her zaman en az 1 gün var sayılır (girilmemiş/0 olsa bile) —
    // backend date_utils.py ile aynı kural, aksi halde "Özet" takvimi gibi yalnızca
    // Teslimat aşamasına göre filtreleyen görünümlerde sipariş kaybolur.
    const deliveryDays = num(params.delivery_days);
    return deliveryDays && deliveryDays > 0 ? deliveryDays : 1;
  }
  return null;
};

/** BOM bileşenleri (alt ürünler) için İLERİ yönlü blok hesabı — backend
 *  `calculate_component_end_date` (date_utils.py) ile birebir aynı sıra ve kural.
 *
 *  Neden ayrı: `computeSuggestedBlocks` bitiş tarihinden GERİYE hesaplar (bitiş
 *  sabit, başlangıç kayar). Bileşenler ise backend'de tam tersi çalışır —
 *  başlangıç sabittir, adet/elde-mevcut değişince BİTİŞ kayar. Önizlemede geriye
 *  doğru hesap kullanılırsa bileşenin bitişi hiç değişmez; dolayısıyla ana ürünün
 *  "bileşenler hazır" anı da değişmez ve ana ürünün barları kaydedilecek sonuçtan
 *  farklı görünür.
 *
 *  Teslimat adımı YOKTUR: bileşen müşteriye teslim edilmez, ana ürünün içine girer.
 */
export const computeComponentBlocksForward = (
  startDate: Date,
  quantity: number,
  params: ScheduleParams,
  emp: EmployeeCounts,
  workMinutes: number,
  holidayKeys: Set<string>,
): Partial<Record<BlockKey, { start: Date; end: Date }>> => {
  const qty = Math.max(1, quantity || 1);
  const blocks: Partial<Record<BlockKey, { start: Date; end: Date }>> = {};
  let cur = startDate;
  // Fason bileşen kavramı yok (backend de is_outsourced=False ile çağırıyor).
  (['supply', 'assembly', 'production', 'test'] as BlockKey[]).forEach((key) => {
    // DİKKAT: iş gününe hizalama, gün sayısı kontrolünden ÖNCE yapılır — backend
    // de aynı sırayı kullanıyor (süresi olmayan bir adım bile imleci hafta
    // sonundan sonraki ilk iş gününe taşır).
    while (!isWorkday(cur, holidayKeys)) {
      cur = new Date(cur.getTime() + DAY_MS);
    }
    const days = blockDays(key, params, qty, emp, workMinutes, false);
    if (!days || days <= 0) return;
    const start = cur;
    cur = addWorkdays(cur, Math.trunc(days), holidayKeys);
    blocks[key] = { start, end: cur };
  });
  return blocks;
};

export const CANONICAL_BLOCK_ORDER: BlockKey[] = ['supply', 'assembly', 'production', 'test', 'delivery'];

export interface StageSequenceViolation {
  key: string;
  label: string;
  end: Date;
  nextKey: string;
  nextLabel: string;
  nextEnd: Date;
}

// Kanonik akıştaki (Tedarik→Dizgi→Üretim→Test→Teslimat) ardışık iki adım arasında,
// SONRAKİ adımın bitişi ÖNCEKİ adımın bitişinden daha erkense — bu fiziksel olarak
// imkansız bir sıralamadır (ör. Üretim, Dizgi bitmeden bitemez). Backend bunu
// engellemiyor (yalnızca start<=end kontrolü var, bkz. order_details.py), bu yüzden
// kaydetmeden ÖNCE burada tespit edilip kullanıcıya gösterilir.
export const findStageSequenceViolations = (
  blocks: { key: string; label: string; start: string; end: string }[],
): StageSequenceViolation[] => {
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const present = CANONICAL_BLOCK_ORDER.filter((k) => byKey.has(k));
  const violations: StageSequenceViolation[] = [];
  for (let i = 1; i < present.length; i += 1) {
    const prev = byKey.get(present[i - 1])!;
    const cur = byKey.get(present[i])!;
    const prevEnd = new Date(prev.end);
    const curEnd = new Date(cur.end);
    if (curEnd.getTime() < prevEnd.getTime()) {
      violations.push({ key: prev.key, label: prev.label, end: prevEnd, nextKey: cur.key, nextLabel: cur.label, nextEnd: curEnd });
    }
  }
  return violations;
};

const formatViolationDate = (d: Date) => d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const describeStageSequenceViolation = (v: StageSequenceViolation): string =>
  `${v.nextLabel} (${formatViolationDate(v.nextEnd)}), ${v.label} bitmeden (${formatViolationDate(v.end)}) önce bitemez.`;

export const computeNativeBlockDays = (
  params: ScheduleParams,
  quantity: number,
  emp: EmployeeCounts,
  workMinutes: number,
  isOutsourced: boolean,
): Partial<Record<BlockKey, number>> => {
  const qty = Math.max(1, quantity || 1);
  const totals: Partial<Record<BlockKey, number>> = {};
  const keys: BlockKey[] = ['supply', 'assembly', 'production', 'test', 'delivery'];
  keys.forEach((key) => {
    const days = blockDays(key, params, qty, emp, workMinutes, isOutsourced);
    if (days && days > 0) totals[key] = days;
  });
  return totals;
};

export const computeSuggestedBlocks = (
  endDate: Date,
  quantity: number,
  params: ScheduleParams,
  emp: EmployeeCounts,
  workMinutes: number,
  holidayKeys: Set<string>,
  isOutsourced: boolean,
  // BOM: bu siparişin (varsa) alt ürünlerinin en geç bitiş tarihi — backend
  // date_utils.py'deki component_ready_at ile aynı rol: doluysa Dizgi hiç
  // hesaplanmaz (alt ürünlerin kendi dizgisiyle yapılmış sayılır), Üretim/Test/
  // Teslimat gerekirse buna göre ileri kaydırılır, Tedarik ise startDate'ten bu
  // tarihe kadar (alt ürünlerin TÜM süresi boyunca) sürer.
  componentReadyAt?: Date | null,
  startDate?: Date | null,
  // BOM bileşenleri (component_product_id dolu) müşteriye teslim edilmez — Teslimat
  // adımı hiç olmamalı (backend date_utils.py calculate_split_stage_ranges'teki
  // include_delivery ile aynı kural). false olduğunda Teslimat, "assembly"nin
  // componentReadyAt'te atlanması gibi (blockDays hiç çağrılmadan, cur_end'e hiç
  // dokunmadan) TAMAMEN atlanır — çağıranın bunu çıktı listesinden SONRADAN
  // filtrelemesi yetmez, çünkü o zaman bile Teslimat'ın iş günü süresi geri sayımdan
  // zaten düşülmüş olur ve Tedarik/Dizgi/Üretim/Test bloklarının tümü olması
  // gerekenden 1 iş günü erken kayar.
  includeDelivery = true,
): Partial<Record<BlockKey, { start: Date; end: Date }>> => {
  const qty = Math.max(1, quantity || 1);
  let curEnd = endDate;
  const blocks: Partial<Record<BlockKey, { start: Date; end: Date }>> = {};
  const order: BlockKey[] = ['delivery', 'test', 'production', 'assembly', 'supply'];

  // Backend date_utils.py calculate_split_stage_ranges ile aynı düzeltme: componentReadyAt
  // bileşen split'lerinin HAM split_end_date'inin (MAX) üzerinden gelir — bileşenlerde
  // Teslimat adımı zaten yok, yani bu tarih artık gerçek bir teslimat değil, sadece
  // geriye-doğru hesabın anchor'ı. Hafta sonuna/tatile denk geldiğinde (ör. Pazar), o
  // bileşenin GERÇEK son iş günü aslında bundan önceki iş günüdür — snap edilmezse ana
  // montajın Tedarik/Üretim'i gereksiz yere o hafta sonu kadar fazladan uzar.
  if (componentReadyAt) {
    while (!isWorkday(componentReadyAt, holidayKeys)) {
      componentReadyAt = new Date(componentReadyAt.getTime() - DAY_MS);
    }
  }

  order.forEach((key) => {
    if (componentReadyAt && key === 'assembly') return;
    if (!includeDelivery && key === 'delivery') return;
    // DİKKAT: burada curEnd'i en yakın iş gününe önceden yuvarlayan bir adım
    // OLMAMALI. subtractWorkdays(curEnd, ...) zaten İLK ADIMDA bir gün geriye
    // gidip ONDAN SONRA iş günü olup olmadığını kontrol ediyor — yani curEnd
    // bizzat hafta sonu/tatile denk gelse bile doğru sonucu üretir. Burada
    // (subtractWorkdays'den ÖNCE) ayrı bir "en yakın iş gününe yuvarla" döngüsü
    // olursa, curEnd zaten hafta sonuna denk geldiğinde bir önceki iş günü İKİ
    // KEZ atlanmış olur — backend date_utils.py calculate_split_stage_ranges'in
    // AYNI gerekçeyle bilerek kaçındığı bug (bkz. oradaki yorum). Bu döngü
    // olduğu sürece her hafta sonu sınırında JS'in "sistem önerisi" backend'in
    // gerçekten kaydettiği tarihten 1 iş günü erken çıkıyor ve ardışık
    // bloklarda birikiyordu (ör. "Özel Program" rozetinin, hiç elle
    // düzenlenmemiş taze bir siparişte bile sahte farklar göstermesi).
    const days = blockDays(key, params, qty, emp, workMinutes, isOutsourced);
    if (!days || days <= 0) return;
    const blockEnd = curEnd;
    // Backend calculate_split_stage_ranges/calculate_split_start_date, iş günü
    // çıkarmadan ÖNCE ondalık gün sayısını int() ile keser (2.5 gün → 2 iş günü) —
    // burada da aynı kesme uygulanmazsa (Math.trunc), subtractWorkdays'in
    // "remaining > 0" döngüsü 2.5'i 3 tam iş günü olarak tüketir, önizleme
    // gerçekte kaydedilecek tarihten 1 iş günü kayar.
    curEnd = subtractWorkdays(curEnd, Math.trunc(days), holidayKeys);
    blocks[key] = { start: curEnd, end: blockEnd };
  });

  if (componentReadyAt) {
    const postAssemblyKeys: BlockKey[] = ['production', 'test', 'delivery'];
    const nextBlock = postAssemblyKeys.map((k) => blocks[k]).find((b): b is { start: Date; end: Date } => Boolean(b));
    if (nextBlock && componentReadyAt.getTime() > nextBlock.start.getTime()) {
      let shiftStart = componentReadyAt;
      while (!isWorkday(shiftStart, holidayKeys)) {
        shiftStart = new Date(shiftStart.getTime() + DAY_MS);
      }
      postAssemblyKeys.forEach((key) => {
        if (!blocks[key]) return;
        const days = blockDays(key, params, qty, emp, workMinutes, isOutsourced);
        if (!days || days <= 0) return;
        const end = addWorkdays(shiftStart, Math.trunc(days), holidayKeys);
        blocks[key] = { start: shiftStart, end };
        shiftStart = end;
      });
    }

    if (startDate) {
      const supplyDays = blockDays('supply', params, qty, emp, workMinutes, isOutsourced);
      if (supplyDays && supplyDays > 0) {
        let supplyStart = startDate;
        while (!isWorkday(supplyStart, holidayKeys)) {
          supplyStart = new Date(supplyStart.getTime() + DAY_MS);
        }
        const naturalEnd = addWorkdays(supplyStart, Math.trunc(supplyDays), holidayKeys);
        const supplyEnd = naturalEnd.getTime() > componentReadyAt.getTime() ? naturalEnd : componentReadyAt;
        blocks.supply = { start: supplyStart, end: supplyEnd };
      }
    }
  }

  return blocks;
};
