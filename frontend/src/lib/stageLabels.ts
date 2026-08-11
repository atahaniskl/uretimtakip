/**
 * Üretim aşaması etiketleri — TEK KAYNAK.
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * `STAGE_LABELS` daha önce 4 ayrı dosyada (HierarchicalGantt, RightPanel,
 * StageView, DeliveryCalendarPage) birebir aynı içerikle tanımlıydı. Sabitin
 * kendisi zararsız kopyalanmıştı — asıl sorun ondan TÜREYEN mantıktaydı:
 *
 *   `getTaskStageLabel` iki yerde farklı davranıyordu. StageView fason (dış
 *   dizgi) parçaların Dizgi adımını "Fason (Dış Dizgi)" olarak etiketliyor,
 *   DeliveryCalendarPage ise aynı parçayı düz "Dizgi" gösteriyordu. Backend bu
 *   ayrımı zaten yapıyor (gantt.py stage_labels); frontend kopyalarından biri
 *   bunu unutmuştu. Sonuç: aynı iş, iki ekranda iki farklı isimle görünüyordu.
 *
 * Bu dosya hem sabiti hem de ondan türeyen etiket mantığını tek yerde tutar.
 */

/** Aşama anahtarı -> Türkçe etiket. Backend BLOCK_KEYS ile aynı beş adım. */
export const STAGE_LABELS: Record<string, string> = {
  supply: 'Tedarik',
  assembly: 'Dizgi',
  production: 'Üretim',
  test: 'Test',
  delivery: 'Teslimat',
};

/** Kanonik akış sırası — backend date_utils.BLOCK_KEYS ile birebir aynı. */
export const STAGE_ORDER = ['supply', 'assembly', 'production', 'test', 'delivery'] as const;

/** Fason parçalarda Dizgi adımının etiketi (iş dış firmada yapılır). */
export const OUTSOURCED_ASSEMBLY_LABEL = 'Fason (Dış Dizgi)';

/** Bir aşama anahtarının etiketi. Fason parçalarda Dizgi ayrı isimlenir —
 *  backend gantt.py'deki stage_labels ile aynı kural. */
export const getStageLabel = (stageKey: string, isOutsourced = false): string => {
  const key = String(stageKey || '').trim().toLowerCase();
  if (!key) return '';
  if (key === 'assembly' && isOutsourced) return OUTSOURCED_ASSEMBLY_LABEL;
  return STAGE_LABELS[key] || key;
};

interface StageLabelTask {
  stage?: string | null;
  text?: string | null;
  type?: string | null;
  // null da kabul edilir: /gantt/tasks yanıtında is_outsourced "bilgi yok"
  // anlamında null gelebiliyor (bkz. backend is_outsourced_from_base_data) ve
  // çağıran taraflar bunu olduğu gibi taşıyor.
  isOutsourced?: boolean | null;
  is_outsourced?: boolean | null;
}

/**
 * Bir Gantt görevinin aşama etiketi.
 *
 * Sırayla: (1) `stage` alanı varsa ondan, (2) yoksa görev metninin başındaki
 * aşama adından ("Tedarik — 5 adet" gibi) çıkarılır, (3) o da tutmazsa
 * `fallbackForTask` belirler.
 *
 * `fallbackForTask`: `stage` alanı OLMAYAN eski/otomatik görevlerde
 * (`type === 'task'`) etiketin "Teslimat" varsayılmasını isteyen çağıranlar
 * için — DeliveryCalendarPage bunu istiyor (takvim hücresi boş etiketle
 * anlamsız kalır), StageView istemiyor (boş bırakır). İki ekranın bilinçli
 * farkı; birleştirme sırasında korunması için parametre yapıldı.
 */
export const getTaskStageLabel = (task: StageLabelTask, fallbackForTask = false): string => {
  const isOutsourced = task?.isOutsourced === true || task?.is_outsourced === true;
  const stage = String(task?.stage || '').trim().toLowerCase();
  if (stage) return getStageLabel(stage, isOutsourced);

  const rawText = String(task?.text || '').trim();
  const stageMatch = rawText.match(/^(Tedarik|Dizgi|Üretim|Test|Teslimat|Otomatik Teslimat)\b/i);
  if (stageMatch?.[1]) {
    return stageMatch[1].replace(/^Otomatik Teslimat$/i, 'Teslimat');
  }

  return fallbackForTask && task?.type === 'task' ? 'Teslimat' : '';
};
