import { blockDays, type EmployeeCounts, type ScheduleParams } from './scheduleMath';
import { startOfDay, isWorkday, MAX_SAFE_WORKDAYS } from './dateUtils';

// Teslimat oluşturma/düzenleme formlarının (CreateDeliveryModal.tsx,
// QuickAddDeliveryWizard.tsx) PAYLAŞTIĞI saf (JSX'siz) iş günü/süre hesaplama
// mantığı. Bilinçli olarak TEK bir yerde tutulur — daha önce bu hesaplar iki
// ayrı yerde kopyalanmıştı ve dakika alanlarının Math.ceil sırası farklı
// olduğu için BOM'lu ürünlerde Tedarik/Üretim arasında haftalarca boşluğa yol
// açan bir sapma bug'ı oluşmuştu (bkz. computeEffectivePipeline yorumu).

export interface ProductInfoItem {
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

// Tarih/is gunu temelleri artik tek kaynakta (lib/dateUtils.ts). Buradan
// re-export edilirler cunku mevcut cagiranlar (CreateDeliveryModal,
// QuickAddDeliveryWizard) bu modulden import ediyor.
export { dateKey, startOfDay, isWeekend, isWorkday, toDateInput, MAX_SAFE_WORKDAYS, addBusinessDays } from './dateUtils';

export const subtractBusinessDaysFromInclusiveEnd = (end: Date, workdays: number, holidayKeys: Set<string>) => {
  let remaining = Math.min(MAX_SAFE_WORKDAYS, Math.max(1, workdays));
  const cursor = startOfDay(end);

  while (remaining > 0) {
    if (isWorkday(cursor, holidayKeys)) {
      remaining -= 1;
      if (remaining === 0) break;
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  return cursor;
};

export const countBusinessDays = (start: Date, end: Date, holidayKeys: Set<string>): number => {
  // Burada "workdays" kullanıcıdan gelen bir SAYI değil, iki tarih arasındaki
  // GERÇEK takvim aralığıdır — yine de kullanıcı yanlışlıkla çok uzak bir yıl
  // yazarsa (ör. 2126) aynı donma riskini önlemek için bir üst sınır (iterasyon
  // sayısı, gün) eklenir.
  let count = 0;
  let iterations = 0;
  const cursor = startOfDay(start);
  const endDay = startOfDay(end);
  while (cursor < endDay && iterations < MAX_SAFE_WORKDAYS * 2) {
    if (isWorkday(cursor, holidayKeys)) count++;
    cursor.setDate(cursor.getDate() + 1);
    iterations += 1;
  }
  return Math.max(1, count);
};

// Sipariş oluşturma formu için hiç işçi ataması yok (henüz Order/DeliverySplit
// oluşturulmadı) — backend'in de bileşen türetirken kullandığı varsayılanla
// (default_emp, bkz. gantt.py _derive_component_orders) aynı: her aşama 1 işçi.
export const DEFAULT_PREVIEW_EMP: EmployeeCounts = { assembly: 1, production: 1, test: 1 };

// `blockDays` sayisal degerler bekler (dakika alanlarini `+` ile TOPLAR) — form
// state'i ise <input> alanlarindan geldigi icin STRING'tir ("1"+"1"+"1" sayisal
// toplama degil METIN BIRLESTIRME yapip "111" gibi devasa bir "gun" sayisina yol
// acar). Bu yuzden `fields` (form STRING'leri de, zaten sayisal olan ProductInfoItem
// de olabilir) burada TEK SEFERDE gercek sayiya cevrilir.
export const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

export const normalizeScheduleParams = (fields: any): ScheduleParams => ({
  supply_days: toNum(fields.supply_days),
  assembly_days: toNum(fields.assembly_days),
  production_days: toNum(fields.production_days),
  outsource_days: toNum(fields.outsource_days),
  quality_minutes: toNum(fields.quality_minutes),
  epoxy_minutes: toNum(fields.epoxy_minutes),
  conformal_minutes: toNum(fields.conformal_minutes),
  montaj_minutes: toNum(fields.montaj_minutes),
  montaj_kalite_minutes: toNum(fields.montaj_kalite_minutes),
  test1_minutes: toNum(fields.test1_minutes),
  test2_minutes: toNum(fields.test2_minutes),
  final_test_minutes: toNum(fields.final_test_minutes),
  delivery_days: toNum(fields.delivery_days),
  duration_mode: fields.duration_mode === 'per_unit' ? 'per_unit' : fields.duration_mode === 'flat' ? 'flat' : null,
  production_flat_days: toNum(fields.production_flat_days),
  test_flat_days: toNum(fields.test_flat_days),
  assembly_flat_days: toNum(fields.assembly_flat_days),
});

// Tek bir urunun Tedarik+Dizgi+Uretim+Test gun toplamini hesaplar (Teslimat HARIC —
// bilesenlerin (BOM alt urun) kendisi teslim edilmedigi icin Teslimat asamasi yok,
// backend calculate_component_end_date ile ayni kural). `fields` hem form state'i
// (string degerler) hem de bir ProductInfoItem (sayisal degerler) olabilir.
// Backend `_block_days` ile AYNI (paylaşılan) fonksiyon kullanılır — burada AYRI
// bir kopya TUTULMAZ, çünkü daha önce tam olarak bu yüzden (paralel implementasyon
// sapması: dakika alanları tek tek Math.ceil'lenip toplanıyordu, backend ise ÖNCE
// toplayıp TEK SEFERDE Math.ceil yapıyor) BOM alt ürünlerinin toplam süresi
// olduğundan uzun hesaplanıp Tedarik/Üretim arasında haftalarca boşluğa yol açan
// bir bug oluşmuştu.
export const computePipelineDays = (
  rawFields: any,
  qty: number,
  workMinutesPerDay: number,
  isOutsourced: boolean,
) => {
  const fields = normalizeScheduleParams(rawFields);
  return {
    supply: blockDays('supply', fields, qty, DEFAULT_PREVIEW_EMP, workMinutesPerDay, isOutsourced) ?? 1,
    assembly: blockDays('assembly', fields, qty, DEFAULT_PREVIEW_EMP, workMinutesPerDay, isOutsourced) ?? 1,
    production: blockDays('production', fields, qty, DEFAULT_PREVIEW_EMP, workMinutesPerDay, isOutsourced) ?? 0,
    test: blockDays('test', fields, qty, DEFAULT_PREVIEW_EMP, workMinutesPerDay, isOutsourced) ?? 0,
  };
};

// Tek bir yerde hesaplanan, GERÇEKTEN kullanılan (BOM alt ürün süresiyle
// değiştirilmiş) aşama günleri — hem toplam iş günü sayısı (sumCreateWorkdays)
// HEM DE ekrandaki Tedarik/Dizgi/Üretim/Test dökümü (pipelineBreakdown, bkz.
// bileşen içindeki useMemo) AYNI bu fonksiyondan gelir. Eskiden yalnızca toplam
// hesaplanıyordu; dökümü AYRI (naif, BOM'suz) bir kopyayla göstermek "Dizgi: 1
// gün" gibi yanıltıcı bir sayı verirdi çünkü gerçek toplam bundan çok daha uzun
// bir bileşen bekleme süresini içeriyordu — döküm ile toplamın TUTARSIZ
// görünmesine yol açardı.
export const computeEffectivePipeline = (form: any, workMinutesPerDay: number, productInfos?: ProductInfoItem[]) => {
  const qty = Math.max(1, Number(form.quantity) || 1);
  const isOutsourced = Boolean(form.is_outsourced);
  const stages = computePipelineDays(form, qty, workMinutesPerDay, isOutsourced);

  // BOM: bu ürünün alt ürünleri varsa ayrı bir Dizgi adımı YOKTUR — bileşenler
  // kendi hatlarında (Tedarik->Dizgi->Üretim->Test) üretilirken ana ürün PARALEL
  // olarak Tedarik yapar (backend date_utils.py calculate_split_stage_ranges'teki
  // "supply uzatma" kuralıyla birebir aynı — bkz. o fonksiyondaki yorum). Yani
  // bileşenlerin bitmesini bekleme süresi Dizgi'de DEĞİL, Tedarik'in kendi
  // süresini alt sınır olarak kullandığı, en uzun bileşenin TAM hattına (Tedarik+
  // Dizgi+Üretim+Test, Teslimatsız) kadar UZAYAN bir süre olarak Tedarik'e
  // yansır; Dizgi 0 gösterilir (bileşenler daha önce biterse Tedarik de kendi
  // doğal süresinde kalır, toplam değişmez).
  const selectedProduct = productInfos?.find((p) => p.id === form.product_info_id);
  const subProducts = selectedProduct?.sub_products ?? [];
  const hasSubProducts = subProducts.length > 0 && Boolean(productInfos);

  let effectiveSupply = stages.supply;
  let effectiveAssembly = stages.assembly;

  if (hasSubProducts) {
    let maxSubPipelineDays = 0;
    for (const sub of subProducts) {
      const subInfo = productInfos!.find((p) => p.id === sub.product_id);
      if (!subInfo) continue;
      // Elde mevcut miktar (bkz. on_hand_by_sub_product_id) ihtiyaçtan düşülür —
      // backend (_derive_component_orders) ile aynı kural. Tamamı stoktan
      // karşılanıyorsa (subQty <= 0) bu bileşen süreye hiç katkı yapmaz (backend'de
      // "an itibariyle hazır" sayılıp component_ends'e start_dt eklenmesiyle aynı fikir).
      const onHandRaw = form.on_hand_by_sub_product_id?.[sub.product_id];
      const onHand = Math.max(0, Number(onHandRaw) || 0);
      const subQty = Math.max(0, qty * (Number(sub.quantity) || 1) - onHand);
      if (subQty <= 0) continue;
      const subStages = computePipelineDays(subInfo, subQty, workMinutesPerDay, false);
      const subPipelineDays = subStages.supply + subStages.assembly + subStages.production + subStages.test;
      maxSubPipelineDays = Math.max(maxSubPipelineDays, subPipelineDays);
    }
    effectiveSupply = Math.max(stages.supply, maxSubPipelineDays);
    effectiveAssembly = 0;
  }

  const deliveryRaw = Number(form.delivery_days) || 0;
  const delivery = deliveryRaw > 0 ? deliveryRaw : 1;

  return {
    supply: effectiveSupply,
    assembly: effectiveAssembly,
    production: stages.production,
    test: stages.test,
    delivery,
    total: effectiveSupply + effectiveAssembly + stages.production + stages.test + delivery,
  };
};

export const sumCreateWorkdays = (form: any, workMinutesPerDay: number, productInfos?: ProductInfoItem[]) =>
  computeEffectivePipeline(form, workMinutesPerDay, productInfos).total;

export const parsePositiveInteger = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
};

export const parseNonNegativeInteger = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
};
