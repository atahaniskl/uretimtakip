/**
 * Süre Modu (Adet Başına / İş Günü) çevresindeki paylaşılan kurallar — TEK KAYNAK.
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * "duration_mode NULL ise İş Günü (flat) kabul edilir" kuralı, hesaplama
 * motorunun (date_utils.py _block_days / scheduleMath.ts blockDays) temel
 * varsayımlarından biri. Bu kural zamanla 7 ayrı yere elle yazıldı —
 * ProductInfoPage, CreateDeliveryModal (3 yer), QuickAddDeliveryWizard,
 * OrderDetailModal, scheduleMath.
 *
 * Kuralın kendisi basit; tehlikeli olan, bir ekranın onu UYGULAMAYI UNUTMASI:
 *
 *   ANT-826C — duration_mode NULL, assembly_flat_days = 2 olan bir üründe
 *   Ürün Bilgisi ekranı modu "Adet Başına" gösteriyordu (NULL'ı per_unit
 *   varsayarak), motor ise İş Günü işliyordu. 13 adetlik bir siparişte Dizgi
 *   26 gün yerine 2 gün hesaplandı.
 *
 * Aynı gerekçe "adet başına veri eksik mi?" tespiti (computePerUnitGaps) ve
 * dakika alan listeleri için de geçerli: hepsi motorun neyi okuduğuna dair
 * varsayımlar, ve motor tek bir yer.
 */

export type DurationMode = 'per_unit' | 'flat';

/**
 * Ham `duration_mode` değerini kesin bir moda indirger.
 *
 * NULL / undefined / boş / tanınmayan değer → `'flat'`. Yalnızca açıkça
 * `'per_unit'` yazılmışsa Adet Başına. Motorla (date_utils.py:275,
 * scheduleMath.ts blockDays) BİREBİR aynı kural — arayüz bir ürünü hangi modda
 * gösteriyorsa, motor da onu o modda hesaplamalı.
 */
export const resolveDurationMode = (raw: string | null | undefined): DurationMode =>
  raw === 'per_unit' ? 'per_unit' : 'flat';

/** `resolveDurationMode(...) === 'flat'` için kısayol — çağrı yerlerinde
 *  `x !== 'per_unit'` gibi ham karşılaştırmalar yerine kullanılır. */
export const isFlatMode = (raw: string | null | undefined): boolean =>
  resolveDurationMode(raw) === 'flat';

/**
 * Üretim ve Test aşamalarının dakika alanları — [alan adı, ekran etiketi].
 *
 * Motor bu alanları TOPLAYIP tek seferde gün sayısına çevirir
 * (date_utils.py _PRODUCTION_MINUTE_FIELDS / _TEST_MINUTE_FIELDS,
 * scheduleMath.ts productionMinutesTotal / testMinutesTotal). Listenin burada
 * tek yerde durması, "bir alan eklendi ama bir ekranda toplama dahil edilmedi"
 * sınıfı sessiz hataları önler.
 */
export const PRODUCTION_MINUTE_FIELDS = [
  ['quality_minutes', 'Kalite'],
  ['epoxy_minutes', 'Epoxy'],
  ['conformal_minutes', 'Conformal'],
  ['montaj_minutes', 'Montaj'],
  ['montaj_kalite_minutes', 'M.Kalite'],
] as const;

export const TEST_MINUTE_FIELDS = [
  ['test1_minutes', 'Test1'],
  ['test2_minutes', 'Test2'],
  ['final_test_minutes', 'F.Test'],
] as const;

export type MinuteFieldList = typeof PRODUCTION_MINUTE_FIELDS | typeof TEST_MINUTE_FIELDS;

/** Alan adları (etiketsiz) — toplama/kontrol yapan yerler için. */
export const PRODUCTION_MINUTE_KEYS = PRODUCTION_MINUTE_FIELDS.map(([key]) => key);
export const TEST_MINUTE_KEYS = TEST_MINUTE_FIELDS.map(([key]) => key);

/**
 * Bir alanın "dolu" sayılıp sayılmayacağı: sayıya çevrilebiliyor ve 0'dan büyük.
 *
 * `Number` kullanılır, `parseFloat` DEĞİL — motor da öyle yapıyor
 * (scheduleMath.ts `num`/`toNum`). `parseFloat("12abc")` 12 döndürüp alanı
 * "dolu" sayardı, oysa motor aynı değeri NaN görüp aşamayı hiç hesaplamazdı;
 * kullanıcıya "veri var" denip öneri üretilememesi tam da bu farktan doğardı.
 */
export const isFilledDuration = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0;
};

/**
 * `computePerUnitGaps` girdisi — form state (string değerler) ya da kayıtlı bir
 * ürün (number değerler) olabilir; ikisi de aynı şekilde ele alınır.
 *
 * Alanlar tek tek ve isteğe bağlı olarak tanımlanır (`Record<string, unknown>`
 * DEĞİL): o tip, index signature'ı olmayan somut arayüzleri (ör.
 * ProductInfoFormState) kabul etmez ve çağrı yerlerinde gereksiz cast'e zorlardı.
 */
export interface PerUnitGapInput {
  production_days?: unknown;
  assembly_days?: unknown;
  quality_minutes?: unknown;
  epoxy_minutes?: unknown;
  conformal_minutes?: unknown;
  montaj_minutes?: unknown;
  montaj_kalite_minutes?: unknown;
  test1_minutes?: unknown;
  test2_minutes?: unknown;
  final_test_minutes?: unknown;
}

/**
 * Adet Başına tarafında hangi aşamaların verisi eksik?
 *
 * İş Günü modunda bu alanlar ekranda GİZLİDİR ama silinmez — ve sistemin
 * "toplam gün önerisi" üretebilmesi için tek kaynak onlardır
 * (scheduleMath.ts assemblyEquivalentDays / perUnitEquivalentDays). Boş bırakılan
 * aşamada öneri hesaplanamaz; bu fonksiyon kullanıcıya hangi aşamaların eksik
 * olduğunu ÖNCEDEN söyleyebilmek için kullanılır.
 *
 * Dizgi için hem `production_days` hem `assembly_days` kabul edilir — motor da
 * bu sırayla bakar (`num(production_days) || num(assembly_days)`). Girdide
 * yalnızca biri varsa (ör. ürün master'ında `production_days` yoktur) diğeri
 * `undefined` olur ve sonucu etkilemez.
 */
export const computePerUnitGaps = (fields: PerUnitGapInput): string[] => {
  const gaps: string[] = [];

  if (!isFilledDuration(fields.production_days) && !isFilledDuration(fields.assembly_days)) {
    gaps.push('Dizgi');
  }
  const read = (key: string) => (fields as Record<string, unknown>)[key];
  if (!PRODUCTION_MINUTE_KEYS.some((key) => isFilledDuration(read(key)))) {
    gaps.push('Üretim');
  }
  if (!TEST_MINUTE_KEYS.some((key) => isFilledDuration(read(key)))) {
    gaps.push('Test');
  }

  return gaps;
};
