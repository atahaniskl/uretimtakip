import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import api from '../lib/api';
import { resolveDurationMode } from '../lib/durationMode';
import {
  type ProductInfoItem,
  computeEffectivePipeline,
  subtractBusinessDaysFromInclusiveEnd,
  toDateInput,
} from '../lib/deliveryPlanMath';
import DateField from './DateField';

interface QuickAddDeliveryWizardProps {
  productInfos: ProductInfoItem[];
  isLoadingProductInfos: boolean;
  holidayKeySet: Set<string>;
  onClose: () => void;
  // Task listesini (arka planda, spinner tetiklemeden) yenilemesi için parent'a
  // haber verir — "Detayları Düzenle" tıklandığında sağ panelin oluşturulan
  // siparişi hemen bulabilmesi için handleSubmit BU işin bitmesini bekler
  // (Promise dönebilir).
  onCreated: () => void | Promise<void>;
  // Yeni ürün tanımlama ve abonelik (aylık) bölme bu akışa BİLİNÇLİ OLARAK
  // dahil edilmedi (ikisi de kendi başına bir tam ekran gerektiriyor) — bu
  // ihtiyaçlar için eski tam form ("Gelişmiş ekleme") açılır.
  onOpenAdvanced: () => void;
  // "Tamamlandı" adımında "Detayları Düzenle" seçilirse, parent bu id ile
  // mevcut düzenleme ekranını (sağ panel / OrderDetailModal) açar.
  onEditRequested: (taskId: string) => void;
}

type WizardStep = 'product' | 'quantity' | 'date' | 'done';

const STEP_ORDER: WizardStep[] = ['product', 'quantity', 'date'];

const createEmptyForm = () => ({
  product_info_id: '',
  text: '',
  external_id: '',
  quantity: '',
  endDate: '',
  supply_days: '',
  assembly_days: '',
  production_days: '',
  epoxy_minutes: '',
  conformal_minutes: '',
  montaj_minutes: '',
  quality_minutes: '',
  montaj_kalite_minutes: '',
  test1_minutes: '',
  test2_minutes: '',
  final_test_minutes: '',
  delivery_days: '',
  duration_mode: '',
  production_flat_days: '',
  test_flat_days: '',
  assembly_flat_days: '',
});

const fieldLabelClass = 'block text-[11px] uppercase tracking-wide text-surface-500 mb-1.5';

export default function QuickAddDeliveryWizard({
  productInfos,
  isLoadingProductInfos,
  holidayKeySet,
  onClose,
  onCreated,
  onOpenAdvanced,
  onEditRequested,
}: QuickAddDeliveryWizardProps) {
  const [step, setStep] = useState<WizardStep>('product');
  const [form, setForm] = useState(() => createEmptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [workHoursPerDay, setWorkHoursPerDay] = useState(8);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ value: number }>('/settings/work-hours-per-day')
      .then(({ data }) => setWorkHoursPerDay(data.value))
      .catch(() => {});
  }, []);

  const workMinutesPerDay = workHoursPerDay * 60;

  // BOM alt ürünleri üst seviye seçimden gizlenir — CreateDeliveryModal.tsx'teki
  // selectableProductInfos ile aynı mantık (bir bileşen kendi başına sipariş
  // olarak seçilemez, sadece ana ürünün bir parçası olarak türetilir).
  const selectableProductInfos = useMemo(() => {
    const subProductIds = new Set(
      productInfos.flatMap((p) => (p.sub_products ?? []).map((sp) => sp.product_id)),
    );
    return productInfos.filter((p) => !subProductIds.has(p.id));
  }, [productInfos]);

  const selectedProduct = useMemo(
    () => productInfos.find((p) => p.id === form.product_info_id) ?? null,
    [productInfos, form.product_info_id],
  );

  // Paylaşılan pipeline hesabı (deliveryPlanMath.ts) — CreateDeliveryModal.tsx
  // ile AYNI fonksiyon, BOM alt ürün süresi ve elde-mevcut düşümü dahil (burada
  // elde-mevcut hiç sorulmadığı için 0 kabul edilir — muhafazakâr/güvenli
  // varsayılan, gerekirse "Detayları Düzenle" ekranından ayarlanabilir).
  const pipeline = useMemo(
    () => computeEffectivePipeline(form, workMinutesPerDay, productInfos),
    [form, workMinutesPerDay, productInfos],
  );

  const handleProductSelect = useCallback((productId: string) => {
    const selected = productInfos.find((item) => item.id === productId);
    if (!selected) {
      setForm(createEmptyForm());
      return;
    }
    setForm((prev) => ({
      ...prev,
      product_info_id: selected.id,
      text: selected.product_name,
      supply_days: String(selected.supply_days ?? ''),
      assembly_days: String(selected.assembly_days ?? ''),
      production_days: String(selected.assembly_days ?? ''),
      epoxy_minutes: String(selected.epoxy_minutes ?? ''),
      conformal_minutes: String(selected.conformal_minutes ?? ''),
      montaj_minutes: String(selected.montaj_minutes ?? ''),
      quality_minutes: String(selected.quality_minutes ?? ''),
      montaj_kalite_minutes: String(selected.montaj_kalite_minutes ?? ''),
      test1_minutes: String(selected.test1_minutes ?? ''),
      test2_minutes: String(selected.test2_minutes ?? ''),
      final_test_minutes: String(selected.final_test_minutes ?? ''),
      delivery_days: String(selected.delivery_days ?? ''),
      // NULL mod, hesaplama motorunda "flat" demektir — CreateDeliveryModal'daki
      // aynı gerekçeyle burada da açıkça yazılır (davranış değişmez, mod görünür olur).
      duration_mode: resolveDurationMode(selected.duration_mode),
      production_flat_days: String(selected.production_flat_days ?? ''),
      test_flat_days: String(selected.test_flat_days ?? ''),
      assembly_flat_days: String(selected.assembly_flat_days ?? ''),
    }));
  }, [productInfos]);

  const plannedStartDate = useMemo(() => {
    if (!form.endDate) return null;
    const totalDays = Math.max(1, Math.round(pipeline.total));
    const endDate = new Date(`${form.endDate}T00:00:00`);
    if (Number.isNaN(endDate.getTime())) return null;
    return subtractBusinessDaysFromInclusiveEnd(endDate, totalDays, holidayKeySet);
  }, [form.endDate, pipeline.total, holidayKeySet]);

  const canGoNextFromProduct = Boolean(form.product_info_id);
  const canGoNextFromQuantity = Number(form.quantity) > 0;
  const canSubmit = canGoNextFromProduct && canGoNextFromQuantity && Boolean(form.endDate) && plannedStartDate !== null;

  const goToStep = (nextStep: WizardStep) => {
    setError('');
    setStep(nextStep);
  };

  const handleSubmit = async () => {
    if (!plannedStartDate) return;
    setSubmitting(true);
    setError('');

    try {
      const quantity = Number(form.quantity);
      const toIsoEndExclusive = (dateInput: string) => {
        const d = new Date(`${dateInput}T00:00:00`);
        d.setDate(d.getDate() + 1);
        return `${toDateInput(d)}T00:00:00Z`;
      };

      const createRes = await api.post('/gantt/tasks', {
        text: form.text,
        external_id: form.external_id || undefined,
        quantity,
        start_date: `${toDateInput(plannedStartDate)}T00:00:00Z`,
        end_date: toIsoEndExclusive(form.endDate),
        promised_date: form.endDate || undefined,
        is_outsourced: false,
        supply_days: form.supply_days ? parseInt(form.supply_days, 10) : undefined,
        production_days: (form.assembly_days || form.production_days)
          ? parseInt(form.assembly_days || form.production_days, 10)
          : undefined,
        assembly_days: form.assembly_days ? parseInt(form.assembly_days, 10) : undefined,
        epoxy_minutes: form.epoxy_minutes ? parseInt(form.epoxy_minutes, 10) : undefined,
        conformal_minutes: form.conformal_minutes ? parseInt(form.conformal_minutes, 10) : undefined,
        montaj_minutes: form.montaj_minutes ? parseInt(form.montaj_minutes, 10) : undefined,
        quality_minutes: form.quality_minutes ? parseInt(form.quality_minutes, 10) : undefined,
        montaj_kalite_minutes: form.montaj_kalite_minutes ? parseInt(form.montaj_kalite_minutes, 10) : undefined,
        test1_minutes: form.test1_minutes ? parseInt(form.test1_minutes, 10) : undefined,
        test2_minutes: form.test2_minutes ? parseInt(form.test2_minutes, 10) : undefined,
        final_test_minutes: form.final_test_minutes ? parseInt(form.final_test_minutes, 10) : undefined,
        delivery_days: form.delivery_days ? parseInt(form.delivery_days, 10) : undefined,
        duration_mode: form.duration_mode || undefined,
        production_flat_days: form.production_flat_days ? parseFloat(form.production_flat_days) : undefined,
        test_flat_days: form.test_flat_days ? parseFloat(form.test_flat_days) : undefined,
        assembly_flat_days: form.assembly_flat_days ? parseFloat(form.assembly_flat_days) : undefined,
      });

      toast.success('Teslimat başarıyla eklendi');
      // `createRes.data.id` (bkz. backend create_manual_task) çıplak
      // "split_<uuid>" formatındadır — ama liste ekranı (GET /gantt/tasks),
      // ürünün aşama süreleri (Tedarik/Dizgi/Üretim/Test) tanımlıysa bu
      // siparişi split_<uuid>_supply / _assembly / ... gibi AŞAMA bazlı alt
      // görevlere böler, çıplak split_<uuid> id'si listede HİÇ görünmez.
      // `createRes.data.parent` ise her zaman "order_<uuid>" formatındadır ve
      // liste her koşulda (aşama bazlı bölünse de bölünmese de) bu id'yi
      // içerir — "Detayları Düzenle" bu yüzden sipariş id'sini kullanır,
      // aksi halde sağ panel eşleşen görev bulamayıp boş açılırdı (canlı bug).
      setCreatedTaskId(String(createRes.data.parent));
      // Sağ panelin siparişi hemen bulabilmesi için liste yenilemesinin
      // bitmesi beklenir — aksi halde "Detayları Düzenle"ye erkenden basılırsa
      // (fetchTasks henüz tamamlanmadıysa) yine boş panel riski olurdu.
      await onCreated();
      setStep('done');
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (Array.isArray(detail)) {
        setError(detail.map((d: any) => `${d.loc.join('.')}: ${d.msg}`).join(', '));
      } else {
        setError(typeof detail === 'string' ? detail : (err?.message || 'Teslimat eklenemedi.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const stepIndex = STEP_ORDER.indexOf(step);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6 animate-fade-in"
      onClick={step === 'done' ? undefined : onClose}
    >
      <div
        className="glass-card w-full max-w-lg max-h-full flex flex-col overflow-hidden relative animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-surface-700/50 bg-surface-900/60">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-white tracking-tight">Yeni Teslimat Ekle</h2>
            <p className="text-surface-400 text-sm mt-1">
              Ürün seçin, adet ve teslim tarihini girin — üretim başlangıcı otomatik hesaplanır.
            </p>
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

        {step !== 'done' && (
          <div className="flex items-center justify-center gap-2 px-6 pt-5">
            {STEP_ORDER.map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                    step === s
                      ? 'bg-primary-600 text-white shadow-glow'
                      : stepIndex > i
                        ? 'bg-emerald-600 text-white'
                        : 'bg-surface-800 text-surface-500'
                  }`}
                >
                  {stepIndex > i ? '✓' : i + 1}
                </div>
                {i < STEP_ORDER.length - 1 && (
                  <div className={`w-12 h-0.5 ${stepIndex > i ? 'bg-emerald-600' : 'bg-surface-700'}`} />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && <div className="detail-error mb-4">{error}</div>}

          {step === 'product' && (
            <section className="space-y-4">
              <div>
                <label className={fieldLabelClass}>Ürün *</label>
                <select
                  className="input-field"
                  value={form.product_info_id}
                  onChange={(e) => handleProductSelect(e.target.value)}
                  disabled={isLoadingProductInfos}
                  autoFocus
                >
                  <option value="">{isLoadingProductInfos ? 'Ürünler yükleniyor...' : 'Ürün seçin'}</option>
                  {selectableProductInfos.map((product) => (
                    <option key={product.id} value={product.id}>{product.product_name}</option>
                  ))}
                </select>
              </div>

              {selectedProduct && (selectedProduct.sub_products?.length ?? 0) > 0 && (
                <p className="text-xs text-primary-200/80 bg-primary-500/10 border border-primary-500/20 rounded-lg px-3 py-2">
                  Bu ürünün {selectedProduct!.sub_products!.length} alt bileşeni var — bunlar otomatik olarak önce
                  üretilecek şekilde planlanacak. Elde mevcut adetlerini isterseniz daha sonra "Detayları Düzenle"
                  ekranından ayarlayabilirsiniz.
                </p>
              )}

              <button
                type="button"
                className="text-xs text-primary-400 hover:text-primary-300 underline underline-offset-2"
                onClick={onOpenAdvanced}
              >
                Listede yok mu veya abonelik (aylık) mi? Gelişmiş ekleme ekranını kullanın →
              </button>
            </section>
          )}

          {step === 'quantity' && (
            <section className="space-y-4">
              <div>
                <label className={fieldLabelClass}>Sipariş Adedi *</label>
                <input
                  type="number"
                  min={1}
                  className="input-field"
                  value={form.quantity}
                  onChange={(e) => setForm((prev) => ({ ...prev, quantity: e.target.value }))}
                  placeholder="Örn: 100"
                  autoFocus
                />
              </div>
              <div>
                <label className={fieldLabelClass}>Sipariş No</label>
                <input
                  type="text"
                  className="input-field"
                  value={form.external_id}
                  onChange={(e) => setForm((prev) => ({ ...prev, external_id: e.target.value }))}
                  placeholder="Opsiyonel"
                />
              </div>
              {canGoNextFromQuantity && (
                <p className="text-xs text-surface-400">
                  Tahmini üretim süresi: <span className="text-surface-200 font-medium">{Math.round(pipeline.total)} iş günü</span>
                </p>
              )}
            </section>
          )}

          {step === 'date' && (
            <section className="space-y-4">
              <div>
                <label className={fieldLabelClass}>Bitiş / Söz Verilen Tarih *</label>
                <DateField
                  value={form.endDate}
                  onChange={(next) => setForm((prev) => ({ ...prev, endDate: next }))}
                  autoFocus
                  clearable={false}
                />
              </div>
              {plannedStartDate && (
                <p className="text-xs text-surface-400">
                  Planlanan başlangıç tarihi:{' '}
                  <span className="text-surface-200 font-medium">{plannedStartDate.toLocaleDateString('tr-TR')}</span>
                  {' '}({Math.round(pipeline.total)} iş günü)
                </p>
              )}
            </section>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center text-center py-6 gap-4">
              <span className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <div>
                <h3 className="text-lg font-semibold text-white">Teslimat oluşturuldu</h3>
                <p className="text-surface-400 text-sm mt-1 max-w-sm">
                  İsterseniz müşteri, fason, elde mevcut adedi gibi detayları şimdi düzenleyebilirsiniz.
                </p>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <button type="button" className="btn-ghost text-sm" onClick={onClose}>Tamam, Kapat</button>
                <button
                  type="button"
                  className="btn-success text-sm"
                  onClick={() => {
                    if (createdTaskId) onEditRequested(createdTaskId);
                    onClose();
                  }}
                >
                  Detayları Düzenle
                </button>
              </div>
            </div>
          )}
        </div>

        {step !== 'done' && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-surface-700/50 bg-surface-900/60">
            <div>
              {step !== 'product' && (
                <button
                  type="button"
                  className="btn-ghost text-sm"
                  onClick={() => goToStep(STEP_ORDER[stepIndex - 1])}
                  disabled={submitting}
                >
                  Geri
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button type="button" className="btn-ghost text-sm" onClick={onClose} disabled={submitting}>İptal</button>
              {step === 'product' && (
                <button
                  type="button"
                  className="btn-success text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={!canGoNextFromProduct}
                  onClick={() => goToStep('quantity')}
                >
                  İleri
                </button>
              )}
              {step === 'quantity' && (
                <button
                  type="button"
                  className="btn-success text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={!canGoNextFromQuantity}
                  onClick={() => goToStep('date')}
                >
                  İleri
                </button>
              )}
              {step === 'date' && (
                <button
                  type="button"
                  className="btn-success text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={!canSubmit || submitting}
                  onClick={handleSubmit}
                >
                  {submitting ? 'Kaydediliyor...' : 'Teslimatı Oluştur'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
