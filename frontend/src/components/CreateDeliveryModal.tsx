import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'react-hot-toast';
import { resolveDurationMode } from '../lib/durationMode';
import api from '../lib/api';
import { computeMonthlyFromMonths, computeMonthsFromMonthly, generateSubscriptionSegments } from '../lib/subscriptionSplit';
import { getApiErrorMessage } from '../lib/errorMessage';
import DateField from './DateField';
import {
  type ProductInfoItem,
  addBusinessDays,
  computeEffectivePipeline,
  countBusinessDays,
  parseNonNegativeInteger,
  parsePositiveInteger,
  subtractBusinessDaysFromInclusiveEnd,
  sumCreateWorkdays,
  toDateInput,
} from '../lib/deliveryPlanMath';

export type { ProductInfoItem };

interface CreateDeliveryModalProps {
  productInfos: ProductInfoItem[];
  isLoadingProductInfos: boolean;
  holidayKeySet: Set<string>;
  onClose: () => void;
  onCreated: () => void;
  onProductCreated: () => void;
}

const createEmptyDeliveryForm = () => ({
  product_info_id: '',
  product_mode: '',
  text: '',
  external_id: '',
  quantity: '',
  startDate: '',
  endDate: '',
  plan_workdays: '',
  customer_name: '',
  responsible_personnel: '',
  order_date: '',
  promised_date: '',
  requirement_date: '',
  penalty_date: '',
  is_outsourced: false,
  supply_days: '',
  assembly_days: '',
  outsource_days: '',
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
  on_hand_by_sub_product_id: {} as Record<string, string>,
});

export default function CreateDeliveryModal({
  productInfos,
  isLoadingProductInfos,
  holidayKeySet,
  onClose,
  onCreated,
  onProductCreated,
}: CreateDeliveryModalProps) {
  const [form, setForm] = useState<any>(() => createEmptyDeliveryForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [workHoursPerDay, setWorkHoursPerDay] = useState(8);
  // "Abonelik / Aylık Otomatik Böl" — sipariş İLK oluşturulurken, sonradan
  // "Parçalı Teslimat Oluştur" ile bölmeye gerek kalmadan, doğrudan N aylık
  // parçaya bölünmüş şekilde kaydedilebilsin diye (bkz. OrderDetailModal.tsx'teki
  // aynı özellik — ortak hesap mantığı subscriptionSplit.ts'te paylaşılıyor).
  // subscriptionSegments boşsa özellik hiç kullanılmıyor demektir, normal
  // (tek teslimat) akış tamamen ETKİLENMEZ.
  const [subOpen, setSubOpen] = useState(false);
  const [subMonthly, setSubMonthly] = useState('');
  const [subMonths, setSubMonths] = useState('');
  const [subStartMonth, setSubStartMonth] = useState('');
  const [subDay, setSubDay] = useState('');
  const [subLastEdited, setSubLastEdited] = useState<'monthly' | 'months'>('monthly');
  const [subscriptionSegments, setSubscriptionSegments] = useState<
    Array<{ quantity: string; endDate: string; is_outsourced: boolean; outsource_days: string }>
  >([]);

  useEffect(() => {
    api.get<{ value: number }>('/settings/work-hours-per-day')
      .then(({ data }) => setWorkHoursPerDay(data.value))
      .catch(() => {});
  }, []);

  const workMinutesPerDay = workHoursPerDay * 60;

  const selectableProductInfos = useMemo(() => {
    const subProductIds = new Set(
      productInfos.flatMap((p) => (p.sub_products ?? []).map((sp) => sp.product_id))
    );
    return productInfos.filter((p) => !subProductIds.has(p.id));
  }, [productInfos]);

  const totalWorkdays = useMemo(() => sumCreateWorkdays(form, workMinutesPerDay, productInfos), [
    form.supply_days,
    form.assembly_days,
    form.production_days,
    form.outsource_days,
    form.is_outsourced,
    form.epoxy_minutes,
    form.conformal_minutes,
    form.montaj_minutes,
    form.quality_minutes,
    form.montaj_kalite_minutes,
    form.test1_minutes,
    form.test2_minutes,
    form.final_test_minutes,
    form.delivery_days,
    form.quantity,
    form.product_info_id,
    form.duration_mode,
    form.production_flat_days,
    form.test_flat_days,
    form.assembly_flat_days,
    workMinutesPerDay,
    productInfos,
  ]);
  const isCreatingNewProduct = form.product_mode === 'new';
  const isUsingSavedProduct = Boolean(form.product_info_id) && !isCreatingNewProduct;
  // Bu siparişin süreleri İş Günü (sabit toplam gün) olarak mı yorumlanıyor?
  // Hangi aşamalarda "Sistem Önerisi"ni besleyecek adet başına veri eksik?

  // Kayıtlı bir ürün seçildiğinde Dizgi/Üretim/Test (toplam gün) kutuları hiç
  // gösterilmez (süreler "kilitli" — bkz. yukarıdaki not) — kullanıcı yalnızca
  // aşağıdaki tek bir "Toplam ürün süresi" toplam sayısını görür, sistemin bu
  // sipariş için Tedarik/Dizgi/Üretim/Test'i AYRI AYRI nasıl hesapladığını hiç
  // göremez. Bu, "sistem benim için süreleri hesaplayıp yardımcı olsun" isteğini
  // salt-okunur bir döküm göstererek karşılar — buton gerekmez, adet her
  // değiştiğinde zaten canlı yeniden hesaplanır. `computeEffectivePipeline`
  // (totalWorkdays'in de kullandığı AYNI fonksiyon) kullanılır — ayrı/naif bir
  // hesap DEĞİL, aksi halde BOM'lu bir üründe "Dizgi: 1 gün" gibi yanıltıcı bir
  // sayı gösterip döküm toplamı "Toplam ürün süresi" ile TUTARSIZ görünürdü
  // (Dizgi, bileşenlerin kendi hattı daha uzunsa onunla değiştirilir).
  const pipelineBreakdown = useMemo(
    () => computeEffectivePipeline(form, workMinutesPerDay, productInfos),
    [
      form.supply_days,
      form.assembly_days,
      form.production_days,
      form.outsource_days,
      form.is_outsourced,
      form.epoxy_minutes,
      form.conformal_minutes,
      form.montaj_minutes,
      form.quality_minutes,
      form.montaj_kalite_minutes,
      form.test1_minutes,
      form.test2_minutes,
      form.final_test_minutes,
      form.delivery_days,
      form.quantity,
      form.product_info_id,
      form.duration_mode,
      form.production_flat_days,
      form.test_flat_days,
      form.assembly_flat_days,
      form.on_hand_by_sub_product_id,
      workMinutesPerDay,
      productInfos,
    ],
  );

  // ESKİDEN burada: kayıtlı bir ürün "Gün" (flat) modundaysa ama Üretim/Test
  // (toplam) alanları ürün master'ında boşsa (null), "geçerli bir adet girilir
  // girilmez" o ANLIK adede göre hesaplanan eşdeğer form.production_flat_days'e
  // KALICI olarak YAZILIYORDU. Niyet: sayının adet değiştikçe "canlı" değişmesini
  // önlemekti. Ama bu, kullanıcı çok haneli bir adet TEK TEK YAZARKEN (ör.
  // "1"→"10"→"100"→"1000") İLK haneden (adet=1) hesaplanan eşdeğeri KİLİTLEYİP
  // sonraki haneleri YOK SAYMASINA yol açıyordu — Üretim/Test kutuları gerçek
  // adet ne olursa olsun o ilk (küçük) değerde DONMUŞ görünüyordu (canlı rapor:
  // adet 1000 yazılmasına rağmen Üretim/Test hep "1" kalıyordu). Artık bu alanlar
  // hiç yazılmıyor (form.production_flat_days boş kalmaya devam ediyor) — bu
  // sayede pipelineBreakdown/totalWorkdays (aşağıda) HER render'da güncel adede
  // göre TAZE hesaplanan eşdeğeri gösterir. Siparişi oluştururken de bu alan boş
  // gönderilir (backend kendi eşdeğer hesabını NİHAİ adetle bağımsız olarak
  // yapar — aynı `_block_days` mantığı, veri kaybı yok).

  const applyPlan = useCallback((nextForm: any) => {
    const promised = nextForm.promised_date;
    const totalDays = parsePositiveInteger(nextForm.plan_workdays) || sumCreateWorkdays(nextForm, workMinutesPerDay, productInfos);
    const hasStart = Boolean(nextForm.startDate);
    const hasEnd = Boolean(promised || nextForm.endDate);
    const hasWorkdays = totalDays > 0;

    if (promised && hasWorkdays) {
      const promisedDate = new Date(`${promised}T00:00:00`);
      if (Number.isNaN(promisedDate.getTime())) return nextForm;
      const startDate = subtractBusinessDaysFromInclusiveEnd(promisedDate, totalDays, holidayKeySet);
      return { ...nextForm, startDate: toDateInput(startDate), endDate: promised };
    }

    if (nextForm.startDate && hasWorkdays && !hasEnd) {
      const startDate = new Date(`${nextForm.startDate}T00:00:00`);
      if (Number.isNaN(startDate.getTime())) return nextForm;
      const endExclusive = addBusinessDays(startDate, totalDays, holidayKeySet);
      const endInclusive = new Date(endExclusive);
      endInclusive.setDate(endInclusive.getDate() - 1);
      return { ...nextForm, endDate: toDateInput(endInclusive) };
    }

    if (hasStart && hasEnd && !hasWorkdays) {
      const startDate = new Date(`${nextForm.startDate}T00:00:00`);
      const endDate = new Date(`${nextForm.endDate}T00:00:00`);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return nextForm;
      const calcDays = countBusinessDays(startDate, endDate, holidayKeySet);
      return { ...nextForm, plan_workdays: String(calcDays) };
    }

    if (hasStart && !hasEnd && !hasWorkdays) {
      return { ...nextForm, endDate: nextForm.startDate };
    }

    if (!hasStart && hasEnd && !hasWorkdays) {
      return { ...nextForm, startDate: nextForm.endDate };
    }

    return nextForm;
  }, [holidayKeySet, workMinutesPerDay]);

  // Baslangic/Bitis tarihi kutucuklari BILEREK applyPlan'in genel (oncelik sirali)
  // mantigindan GECMEZ: applyPlan'da "Soz Verilen Tarih" (promised_date) dolu
  // olan HER durumda ilk sirada kontrol ediliyor (bkz. yukarida "if (promised &&
  // hasWorkdays)") — kullanici az once Baslangic Tarihi'ni degistirse bile, daha
  // once (ornegin Bitis kutusuna kisaca dokunulmus/yanlislikla girilmis) set
  // edilmis eski bir promised_date VARSA, o eski tarih Baslangic'i GERIYE DOGRU
  // yeniden hesaplayip ekrana YENI yazdigi tarihin uzerine yazıyor, Bitis de o
  // eski (yanlis) tarihte KALIYOR. Iki ayri, ACIK yonlu handler kullanarak
  // "hangi alani en son SIZ degistirdiyseniz o alan sabit kalir, digeri ondan
  // hesaplanir" garantisi saglaniyor.
  const handleStartDateChange = useCallback((value: string) => {
    setForm((prev: any) => {
      const next = { ...prev, startDate: value };
      if (!value) return next;
      const totalDays = parsePositiveInteger(next.plan_workdays) || sumCreateWorkdays(next, workMinutesPerDay, productInfos);
      if (totalDays <= 0) return next;
      const startDate = new Date(`${value}T00:00:00`);
      if (Number.isNaN(startDate.getTime())) return next;
      const endExclusive = addBusinessDays(startDate, totalDays, holidayKeySet);
      const endInclusive = new Date(endExclusive);
      endInclusive.setDate(endInclusive.getDate() - 1);
      const endStr = toDateInput(endInclusive);
      return { ...next, endDate: endStr, promised_date: endStr };
    });
  }, [holidayKeySet, workMinutesPerDay]);

  const handleEndDateChange = useCallback((value: string) => {
    setForm((prev: any) => {
      const next = { ...prev, endDate: value, promised_date: value };
      if (!value) return next;
      const totalDays = parsePositiveInteger(next.plan_workdays) || sumCreateWorkdays(next, workMinutesPerDay, productInfos);
      if (totalDays <= 0) return next;
      const endDate = new Date(`${value}T00:00:00`);
      if (Number.isNaN(endDate.getTime())) return next;
      const startDate = subtractBusinessDaysFromInclusiveEnd(endDate, totalDays, holidayKeySet);
      return { ...next, startDate: toDateInput(startDate) };
    });
  }, [holidayKeySet, workMinutesPerDay]);

  const updateForm = useCallback((patch: Record<string, any>, recalculate = false) => {
    setForm((prev: any) => {
      const next = { ...prev, ...patch };
      return recalculate ? applyPlan(next) : next;
    });
  }, [applyPlan]);

  // "Abonelik / Aylık Otomatik Böl" — bkz. OrderDetailModal.tsx'teki aynı özellik
  // (ortak hesap mantığı subscriptionSplit.ts'te). Burada "toplam", kullanıcının
  // az önce girdiği "Sipariş Adedi" (form.quantity) alanıdır.
  const subOrderQuantity = Number(form.quantity) || 0;

  const handleSubMonthlyChange = (value: string) => {
    setSubLastEdited('monthly');
    setSubMonthly(value);
    const months = computeMonthsFromMonthly(subOrderQuantity, parseFloat(value));
    if (months !== null) setSubMonths(String(months));
  };
  const handleSubMonthsChange = (value: string) => {
    setSubLastEdited('months');
    setSubMonths(value);
    const monthly = computeMonthlyFromMonths(subOrderQuantity, parseInt(value, 10));
    if (monthly !== null) setSubMonthly(String(monthly));
  };

  const subComputedMonths = subLastEdited === 'months'
    ? (parseInt(subMonths, 10) > 0 ? parseInt(subMonths, 10) : null)
    : computeMonthsFromMonthly(subOrderQuantity, parseFloat(subMonthly));

  const handleGenerateSubscriptionSegments = () => {
    const months = subComputedMonths;
    const day = parseInt(subDay, 10);
    if (!subOrderQuantity || !months || months < 1 || !subStartMonth || !day || day < 1 || day > 31) {
      setError('Abonelik için önce Sipariş Adedi\'ni, sonra Aylık Adet/Ay Sayısı, Başlangıç Ayı ve Gün alanlarını doldurun.');
      return;
    }
    const generated = generateSubscriptionSegments(subOrderQuantity, months, subStartMonth, day);
    setError('');
    setSubscriptionSegments(generated);
    // Formun kendi Başlangıç/Bitiş alanları da (üstteki "Zamanlama" section'ının
    // önizlemesi anlamsız kalmasın, validate() de sorunsuz geçsin diye) ilk/son
    // ayın tarihine senkronize edilir — gerçek hesap, kayıt sonrası split-multi
    // çağrısında her ay için AYRI AYRI yapılacak, bu sadece görsel tutarlılık için.
    updateForm({ startDate: generated[0].endDate, endDate: generated[generated.length - 1].endDate, promised_date: generated[generated.length - 1].endDate });
  };

  const updateSubscriptionSegment = (index: number, field: string, value: string) => {
    setSubscriptionSegments((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: field === 'is_outsourced' ? value === 'true' : value } : item)),
    );
  };
  const addSubscriptionSegment = () => {
    setSubscriptionSegments((prev) => {
      const last = prev[prev.length - 1];
      return [...prev, { quantity: '', endDate: last?.endDate ?? '', is_outsourced: false, outsource_days: '' }];
    });
  };
  const removeSubscriptionSegment = (index: number) => {
    setSubscriptionSegments((prev) => prev.filter((_, i) => i !== index));
  };
  const subscriptionTotalQuantity = subscriptionSegments.reduce((acc, seg) => acc + (Number(seg.quantity) || 0), 0);
  const subscriptionRemainingQuantity = subOrderQuantity - subscriptionTotalQuantity;

  // "Tek Teslimat"a geri dönüldüğünde abonelik planı tamamen temizlenir —
  // aksi halde eski (artık görünmeyen) segmentler validate()/submit'te hâlâ
  // "abonelik modu aktif" sanılıp normal akışı sessizce bozardı.
  const handleSwitchToSingleDelivery = () => {
    setSubOpen(false);
    setSubscriptionSegments([]);
  };

  // "Sistem Önerisi" — İş Günü (Gün) modunda yeni ürün eklerken Dizgi/Üretim/Test
  // (toplam gün) alanları boşsa, Adet Başına tarafındaki dakika/oran verilerinden
  // (kullanıcı Süre Modu'nu "Adet Başına"dan "İş Günü"ne çevirmeden ÖNCE girmiş
  // olabilir — bu değerler form state'inde SAKLI kalır, yalnızca bu moddayken
  // gösterilmez) hesaplanan eşdeğerle doldurur. OrderDetailModal'daki aynı
  // butonla BİREBİR aynı kural: yalnızca BOŞ alanlar doldurulur, kullanıcının
  // zaten elle girdiği bir değere ASLA dokunulmaz (bkz. o taraftaki "Dizgi=2.5
  // iken üzerine 20 yazıldı" hatası — aynı riski burada da önlemek için).
  const handleProductSelect = useCallback((productId: string) => {
    if (productId === '__new__') {
      updateForm({
        product_info_id: '',
        product_mode: 'new',
        text: '',
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
              // Boş bırakılırsa (backend'de null) hesaplama kuralı bunu "flat" (İş
        // Günü) kabul ediyor — ama aşağıdaki anahtar burada "Adet" (per_unit)
        // görünüyor; bu görünüm/varsayılan uyuşmazlığını önlemek için yeni ürün
        // her zaman AÇIKÇA 'per_unit' ile başlar (bkz. ProductInfoPage.tsx'teki
        // aynı varsayılan).
        duration_mode: 'per_unit',
        production_flat_days: '',
        test_flat_days: '',
        assembly_flat_days: '',
        plan_workdays: '',
        on_hand_by_sub_product_id: {},
      }, true);
      return;
    }

    if (!productId) {
      updateForm({
        product_info_id: '',
        product_mode: '',
        text: '',
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
        plan_workdays: '',
        on_hand_by_sub_product_id: {},
      }, true);
      return;
    }

    const selected = productInfos.find((item) => item.id === productId);
    if (!selected) return;

    updateForm({
      product_info_id: selected.id,
      product_mode: 'saved',
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
      // Ürün master'ında mod hiç seçilmemişse (NULL) hesaplama motoru bunu zaten
      // "flat" kabul ediyor (scheduleMath.ts blockDays / date_utils.py _block_days).
      // Boş bırakıp backend'in varsayılanına güvenmek yerine burada AÇIKÇA yazılır:
      // davranış birebir aynı kalır, ama siparişin base_data'sında mod görünür olur
      // ve sipariş detayı/önizleme ekranları "Adet Başına" gibi yanlış bir mod
      // göstermez (ANT-826C'de tam olarak bu tutarsızlık yaşandı).
      duration_mode: resolveDurationMode(selected.duration_mode),
      production_flat_days: String(selected.production_flat_days ?? ''),
      test_flat_days: String(selected.test_flat_days ?? ''),
      assembly_flat_days: String(selected.assembly_flat_days ?? ''),
      plan_workdays: '',
      on_hand_by_sub_product_id: {},
    }, true);
  }, [productInfos, updateForm]);

  const validate = useCallback((plannedForm: any): string | null => {
    const quantity = Number(plannedForm.quantity);

    if (!plannedForm.text || !Number.isFinite(quantity) || quantity <= 0) {
      return 'Lütfen ürün adı ve sipariş adedini girin.';
    }

    // Abonelik modu: üstteki Başlangıç/Bitiş/Plan İş Günü alanları devre dışı
    // ve anlamsız (her ayın kendi tarihi split-multi çağrısında AYRI AYRI
    // hesaplanacak) — bu yüzden onları değil, doğrudan aylık parça listesinin
    // kendisini (adet toplamı + her ayın dolu olması) doğrularız.
    if (subscriptionSegments.length > 0) {
      const segTotal = subscriptionSegments.reduce((acc, seg) => acc + (Number(seg.quantity) || 0), 0);
      if (Math.abs(segTotal - quantity) > 0.001) {
        return `Aylık parça adetlerinin toplamı (${segTotal}), sipariş adedine (${quantity}) eşit olmalı.`;
      }
      if (subscriptionSegments.some((seg) => !seg.quantity || Number(seg.quantity) <= 0 || !seg.endDate)) {
        return 'Abonelik planındaki her ay için geçerli bir adet ve tarih girilmeli.';
      }
      return null;
    }

    const hasStart = Boolean(plannedForm.startDate);
    const hasEnd = Boolean(plannedForm.endDate || plannedForm.promised_date);
    const planWorkdays = parsePositiveInteger(plannedForm.plan_workdays) || sumCreateWorkdays(plannedForm, workMinutesPerDay, productInfos);
    const hasWorkdays = planWorkdays > 0;

    if (!hasStart && !hasEnd) {
      return 'En az başlangıç veya bitiş tarihi girmelisiniz.';
    }

    if (hasStart && hasEnd) {
      const start = new Date(`${plannedForm.startDate}T00:00:00`);
      const end = new Date(`${plannedForm.endDate}T00:00:00`);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
        return 'Bitiş tarihi, başlangıç tarihinden önce olamaz.';
      }
    }

    if (hasStart && !hasEnd && !hasWorkdays) {
      return 'Bitiş tarihi girmediğiniz için en az 1 iş günü belirtmelisiniz.';
    }

    if (!hasStart && hasEnd && !hasWorkdays) {
      return 'Başlangıç tarihi girmediğiniz için en az 1 iş günü belirtmelisiniz.';
    }

    const isFason = Boolean(plannedForm.is_outsourced);

    // Fason iken dizgi yerine fason süresi zorunludur (her iki ürün modunda da).
    if (isFason) {
      const outsource = Number(plannedForm.outsource_days);
      if (!Number.isFinite(outsource) || outsource <= 0) {
        return 'Fason üretim için Fason Süresi (gün) girin (0\'dan büyük).';
      }
    }

    if (isCreatingNewProduct) {
      // "Dizgi (gün/adet)" artik her zaman sureyi belirler (sure modu kaldirildi);
      // yalnizca fasonda yerini "Fason Suresi" alir.
      const assemblyDaysRequired = !isFason;
      const requiredDurations = [
        plannedForm.supply_days,
        ...(assemblyDaysRequired ? [plannedForm.assembly_days] : []),
        plannedForm.delivery_days,
      ];
      if (requiredDurations.some((value) => parseNonNegativeInteger(value) === null)) {
        return assemblyDaysRequired
          ? 'Yeni ürün için tüm aşama sürelerini girin (Tedarik, Dizgi, Teslimat).'
          : 'Yeni ürün için aşama sürelerini girin (Tedarik, Teslimat).';
      }
      // İş Günü (flat) modunda Üretim/Test dakika alanları hiç gösterilmiyor —
      // tek süre kaynağı bu iki toplam-gün alanı, o yüzden burada boş bırakılırsa
      // ürün, adete göre kayan aynı belirsiz duruma (bkz. ProductInfoPage.tsx'teki
      // aynı kural) düşer.
      if (plannedForm.duration_mode === 'flat') {
        const productionFlat = Number(plannedForm.production_flat_days);
        const testFlat = Number(plannedForm.test_flat_days);
        // Fason (dış dizgi) parçalarda Dizgi alanı yerine Fason Süresi (outsource_days)
        // kullanılıyor — assembly_flat_days o durumda ekranda hiç gösterilmiyor,
        // zorunluluğa da tabi tutulmamalı.
        const assemblyFlat = isFason ? 1 : Number(plannedForm.assembly_flat_days);
        if (
          !Number.isFinite(productionFlat) || productionFlat <= 0
          || !Number.isFinite(testFlat) || testFlat <= 0
          || !Number.isFinite(assemblyFlat) || assemblyFlat <= 0
        ) {
          return isFason
            ? 'İş Günü modunda Üretim (toplam gün) ve Test (toplam gün) alanlarını girin (0\'dan büyük).'
            : 'İş Günü modunda Dizgi (toplam gün), Üretim (toplam gün) ve Test (toplam gün) alanlarını girin (0\'dan büyük).';
        }
      }
    }

    if (isUsingSavedProduct) {
      const checks: Record<string, string> = {
        supply_days: 'Tedarik (gün)',
        delivery_days: 'Teslimat (gün)',
      };
      if (!isFason) checks.assembly_days = 'Dizgi (gün/adet)';
      for (const [field, label] of Object.entries(checks)) {
        const val = Number(plannedForm[field]);
        if (!Number.isFinite(val) || val < 0) {
          return `${label} bilgisi girilmemiş. Lütfen önce ürün bilgilerini güncelleyin.`;
        }
        if (field === 'assembly_days' && val <= 0) {
          return `${label} 0 veya geçersiz. Lütfen önce ürün bilgilerini güncelleyin.`;
        }
      }
    }

    return null;
  }, [isCreatingNewProduct, isUsingSavedProduct, workMinutesPerDay, subscriptionSegments]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const plannedForm = applyPlan(form);

    const validationError = validate(plannedForm);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const quantity = Number(plannedForm.quantity);
      const toIsoStart = (dateInput: string) => `${dateInput}T00:00:00Z`;
      const toIsoEndExclusive = (dateInput: string) => {
        const d = new Date(`${dateInput}T00:00:00`);
        d.setDate(d.getDate() + 1);
        return `${toDateInput(d)}T00:00:00Z`;
      };

      if (isCreatingNewProduct) {
        // duration_mode + dakika/toplam-gün alanları da gönderilmezse, ürün master'ı
        // bu verilerden yoksun kalır — bu ürün ikinci kez bir siparişte seçildiğinde
        // (bu sefer "Kayıtlı Ürün" yoluyla) duration_mode yine null'a düşer ve aynı
        // adete-göre-kayan belirsizlik tekrar baş gösterir. Bu yüzden burada da
        // aşağıdaki /gantt/tasks çağrısıyla AYNI değerler ürün master'ına yazılır.
        await api.post('/product-info/', {
          product_name: plannedForm.text.trim(),
          supply_days: parseNonNegativeInteger(plannedForm.supply_days),
          // Fason'da dizgi süresi ürüne girilmez; ürün master'ı için 0 yazılır.
          assembly_days: parseNonNegativeInteger(plannedForm.assembly_days) ?? 0,
          delivery_days: parseNonNegativeInteger(plannedForm.delivery_days),
          duration_mode: plannedForm.duration_mode || undefined,
          production_flat_days: plannedForm.production_flat_days ? parseFloat(plannedForm.production_flat_days) : undefined,
          test_flat_days: plannedForm.test_flat_days ? parseFloat(plannedForm.test_flat_days) : undefined,
          assembly_flat_days: plannedForm.assembly_flat_days ? parseFloat(plannedForm.assembly_flat_days) : undefined,
          epoxy_minutes: plannedForm.epoxy_minutes ? parseInt(plannedForm.epoxy_minutes) : undefined,
          conformal_minutes: plannedForm.conformal_minutes ? parseInt(plannedForm.conformal_minutes) : undefined,
          montaj_minutes: plannedForm.montaj_minutes ? parseInt(plannedForm.montaj_minutes) : undefined,
          quality_minutes: plannedForm.quality_minutes ? parseInt(plannedForm.quality_minutes) : undefined,
          montaj_kalite_minutes: plannedForm.montaj_kalite_minutes ? parseInt(plannedForm.montaj_kalite_minutes) : undefined,
          test1_minutes: plannedForm.test1_minutes ? parseInt(plannedForm.test1_minutes) : undefined,
          test2_minutes: plannedForm.test2_minutes ? parseInt(plannedForm.test2_minutes) : undefined,
          final_test_minutes: plannedForm.final_test_minutes ? parseInt(plannedForm.final_test_minutes) : undefined,
        });
        onProductCreated();
      }

      const createRes = await api.post('/gantt/tasks', {
        text: plannedForm.text,
        external_id: plannedForm.external_id || undefined,
        quantity,
        start_date: toIsoStart(plannedForm.startDate),
        end_date: toIsoEndExclusive(plannedForm.endDate),
        customer_name: plannedForm.customer_name || undefined,
        responsible_personnel: plannedForm.responsible_personnel || undefined,
        order_date: plannedForm.order_date || undefined,
        promised_date: plannedForm.promised_date || plannedForm.endDate || undefined,
        requirement_date: plannedForm.requirement_date || undefined,
        penalty_date: plannedForm.penalty_date || undefined,
        is_outsourced: plannedForm.is_outsourced,
        outsource_days: plannedForm.outsource_days ? parseFloat(plannedForm.outsource_days) : undefined,
        supply_days: plannedForm.supply_days ? parseInt(plannedForm.supply_days) : undefined,
        production_days: (plannedForm.assembly_days || plannedForm.production_days)
          ? parseInt(plannedForm.assembly_days || plannedForm.production_days)
          : undefined,
        assembly_days: plannedForm.assembly_days ? parseInt(plannedForm.assembly_days) : undefined,
        epoxy_minutes: plannedForm.epoxy_minutes ? parseInt(plannedForm.epoxy_minutes) : undefined,
        conformal_minutes: plannedForm.conformal_minutes ? parseInt(plannedForm.conformal_minutes) : undefined,
        montaj_minutes: plannedForm.montaj_minutes ? parseInt(plannedForm.montaj_minutes) : undefined,
        quality_minutes: plannedForm.quality_minutes ? parseInt(plannedForm.quality_minutes) : undefined,
        montaj_kalite_minutes: plannedForm.montaj_kalite_minutes ? parseInt(plannedForm.montaj_kalite_minutes) : undefined,
        test1_minutes: plannedForm.test1_minutes ? parseInt(plannedForm.test1_minutes) : undefined,
        test2_minutes: plannedForm.test2_minutes ? parseInt(plannedForm.test2_minutes) : undefined,
        final_test_minutes: plannedForm.final_test_minutes ? parseInt(plannedForm.final_test_minutes) : undefined,
        delivery_days: plannedForm.delivery_days ? parseInt(plannedForm.delivery_days) : undefined,
        duration_mode: plannedForm.duration_mode || undefined,
        production_flat_days: plannedForm.production_flat_days ? parseFloat(plannedForm.production_flat_days) : undefined,
        test_flat_days: plannedForm.test_flat_days ? parseFloat(plannedForm.test_flat_days) : undefined,
        assembly_flat_days: plannedForm.assembly_flat_days ? parseFloat(plannedForm.assembly_flat_days) : undefined,
        sub_product_on_hand: (() => {
          const entries = Object.entries(plannedForm.on_hand_by_sub_product_id || {})
            .map(([id, raw]) => [id, Number(raw)] as const)
            .filter(([, val]) => Number.isFinite(val) && val > 0);
          return entries.length > 0 ? Object.fromEntries(entries) : undefined;
        })(),
      });

      if (subscriptionSegments.length > 0) {
        // Sipariş GERÇEKTEN oluştu (tek teslimat olarak) — şimdi az önce
        // üretilen aylık parçalara bölünür. `createRes.data.id` zaten
        // `split_<uuid>` formatında dönüyor, split-multi'nin beklediği taskId
        // ile birebir aynı (bkz. OrderDetailModal.tsx'teki aynı çağrı deseni).
        try {
          const segments = subscriptionSegments.map((seg) => ({
            quantity: parseFloat(seg.quantity),
            end_date: toIsoEndExclusive(seg.endDate),
            is_outsourced: seg.is_outsourced,
            outsource_days: seg.is_outsourced && seg.outsource_days ? parseFloat(seg.outsource_days) : undefined,
          }));
          const splitRes = await api.post(`/gantt/tasks/${createRes.data.id}/split-multi`, { segments });
          const warnings: string[] = splitRes.data?.warnings || [];
          warnings.forEach((w) => toast(w, { icon: '⚠️', duration: 6000 }));
          toast.success(`Sipariş oluşturuldu ve ${segments.length} aylık parçaya bölündü.`);
        } catch (splitErr) {
          // Sessizce yutmak yerine: sipariş VAR ama abonelik bölmesi
          // başarısız oldu — kullanıcı siparişi açıp "Parçalı Teslimat
          // Oluştur" ile elle bölebilir.
          toast.error(getApiErrorMessage(
            splitErr,
            'Sipariş oluşturuldu ama aylık parçalara bölünemedi — siparişi açıp "Parçalı Teslimat Oluştur" ile elle bölebilirsiniz.',
          ));
        }
      } else {
        toast.success('Teslimat başarıyla eklendi');
      }
      onClose();
      onCreated();
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

  const sectionHeadingClass = 'text-sm font-semibold text-surface-200 mb-3 flex items-center gap-2';
  const fieldLabelClass = 'block text-[11px] uppercase tracking-wide text-surface-500 mb-1.5';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6 md:p-12 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="glass-card w-full max-w-[95vw] xl:max-w-[1100px] max-h-full flex flex-col overflow-hidden relative animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-surface-700/50 bg-surface-900/60">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-lg bg-primary-500/15 flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-white tracking-tight">Yeni Teslimat Ekle</h2>
              <p className="text-surface-400 text-sm mt-1">
                Ürün seçin, adet ve teslim tarihini girin — üretim başlangıcı otomatik hesaplanır.
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
          {error && <div className="detail-error">{error}</div>}

          <section>
            <h3 className={sectionHeadingClass}>
              <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              Ürün
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className={fieldLabelClass}>Ürün *</label>
                <select
                  className="input-field"
                  value={isCreatingNewProduct ? '__new__' : form.product_info_id}
                  onChange={(e) => handleProductSelect(e.target.value)}
                  disabled={isLoadingProductInfos}
                >
                  <option value="">{isLoadingProductInfos ? 'Ürünler yükleniyor...' : 'Ürün seçin'}</option>
                  {selectableProductInfos.map((product) => (
                    <option key={product.id} value={product.id}>{product.product_name}</option>
                  ))}
                  <option value="__new__">+ Yeni ürün ekle</option>
                </select>
              </div>

              {(() => {
                const selectedProduct = !isCreatingNewProduct
                  ? productInfos.find((p) => p.id === form.product_info_id)
                  : null;
                const subProducts = selectedProduct?.sub_products ?? [];
                if (subProducts.length === 0) return null;
                const mainQty = Number(form.quantity) || 0;
                return (
                  <div className="sm:col-span-2 text-xs text-primary-200/80 bg-primary-500/10 border border-primary-500/20 rounded-lg px-3 py-2 space-y-2">
                    <p>
                      Bu ürünün {subProducts.length} alt ürünü var — bunlar otomatik olarak önce üretilecek şekilde planlanacak.
                      Elinizde hazır olarak mevcut olan miktarı girerseniz, sadece eksik kalan kısım üretilecek şekilde planlanır.
                    </p>
                    <div className="space-y-1.5">
                      {subProducts.map((sp) => {
                        const needed = mainQty * (Number(sp.quantity) || 1);
                        const onHandRaw = form.on_hand_by_sub_product_id[sp.product_id] ?? '';
                        const onHand = Math.max(0, Number(onHandRaw) || 0);
                        const toProduce = Math.max(0, needed - onHand);
                        return (
                          <div key={sp.product_id} className="flex items-center gap-2 flex-wrap">
                            <span className="min-w-[7rem] font-medium text-primary-100">{sp.product_name}</span>
                            <span className="text-primary-300/70">İhtiyaç: {needed || 0}</span>
                            <label className="flex items-center gap-1.5 ml-auto whitespace-nowrap">
                              Elde mevcut:
                              <input
                                type="number"
                                min={0}
                                value={onHandRaw}
                                onChange={(e) => updateForm({
                                  on_hand_by_sub_product_id: {
                                    ...form.on_hand_by_sub_product_id,
                                    [sp.product_id]: e.target.value,
                                  },
                                }, true)}
                                className="input-field w-20 py-0.5 px-1.5 text-xs"
                                placeholder="0"
                              />
                            </label>
                            <span className={toProduce === 0 && onHand > 0 ? 'text-emerald-400 font-semibold' : 'text-primary-100 font-semibold'}>
                              Üretilecek: {toProduce}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {isCreatingNewProduct && (
                <div className="sm:col-span-2">
                  <label className={fieldLabelClass}>Yeni Ürün Adı *</label>
                  <input
                    type="text"
                    className="input-field"
                    placeholder="Örn: Ürün A"
                    value={form.text}
                    onChange={(e) => updateForm({ text: e.target.value })}
                  />
                </div>
              )}

              <div>
                <label className={fieldLabelClass}>Sipariş Adedi *</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="input-field"
                  value={form.quantity}
                  onChange={(e) => updateForm({ quantity: e.target.value }, true)}
                />
                {totalWorkdays > 3650 && (
                  <p className="text-[11px] text-amber-400 mt-1">
                    ⚠️ Bu adet ve ürün süreleriyle hesaplanan toplam süre {totalWorkdays} iş günü (~{Math.round(totalWorkdays / 365)} yıl) —
                    muhtemelen adet ya da dakika/gün alanlarından biri yanlış girildi.
                  </p>
                )}
              </div>
              <div>
                <label className={fieldLabelClass}>Sipariş No</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Örn: SP-12345"
                  value={form.external_id}
                  onChange={(e) => updateForm({ external_id: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-surface-700/50 bg-surface-800/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <h3 className={`${sectionHeadingClass} mb-0`}>
                <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Zamanlama
              </h3>
              <div className="flex rounded-lg border border-surface-700 overflow-hidden text-xs font-semibold">
                <button
                  type="button"
                  onClick={handleSwitchToSingleDelivery}
                  className={`px-3 py-1.5 transition-colors ${!subOpen ? 'bg-primary-500 text-white' : 'bg-surface-800 text-surface-400 hover:text-surface-200'}`}
                >
                  Tek Teslimat
                </button>
                <button
                  type="button"
                  onClick={() => setSubOpen(true)}
                  className={`px-3 py-1.5 transition-colors ${subOpen ? 'bg-primary-500 text-white' : 'bg-surface-800 text-surface-400 hover:text-surface-200'}`}
                >
                  🔁 Abonelik (Aylık)
                </button>
              </div>
            </div>

            {!subOpen ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4 -mt-2 mb-4">
                  <p className="text-xs text-surface-500">
                    Teslim tarihi + adet girince üretim başlangıcı otomatik hesaplanır. İstersen Plan İş Günü'nü manuel değiştirebilirsin.
                  </p>
                  <div className="text-right">
                    <div className="text-xs text-surface-400">Hesaplanan başlangıç</div>
                    <div className="text-lg font-semibold text-primary-300">{form.startDate || '-'}</div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className={fieldLabelClass}>Başlangıç Tarihi</label>
                    <DateField value={form.startDate} onChange={handleStartDateChange} />
                  </div>
                  <div>
                    <label className={fieldLabelClass}>Bitiş / Söz Verilen Tarih</label>
                    <DateField value={form.endDate} onChange={handleEndDateChange} clearable={false} />
                  </div>
                  <div>
                    <label className={fieldLabelClass}>Plan İş Günü</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      className="input-field"
                      placeholder={totalWorkdays ? String(totalWorkdays) : 'Örn: 10'}
                      value={form.plan_workdays}
                      onChange={(e) => updateForm({ plan_workdays: e.target.value }, true)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-surface-400">
                  Sipariş adedini yukarıda girdikten sonra, aylık adet ya da ay sayısından birini girin (diğeri otomatik hesaplanır), başlangıç ayını ve her ay hangi gün teslim edileceğini seçip "Oluştur"a basın — sipariş kaydedilirken otomatik olarak bu aylık parçalara bölünür.
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
                      className="input-field"
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
                      className="input-field"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-surface-300">
                    Başlangıç Ayı
                    <input
                      type="month"
                      value={subStartMonth}
                      onChange={(e) => setSubStartMonth(e.target.value)}
                      className="input-field"
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
                      className="input-field"
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

                {subscriptionSegments.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-400">
                      <span>Hedef adet: {subOrderQuantity}</span>
                      <span>Toplam: {subscriptionTotalQuantity}</span>
                      <span className={Math.abs(subscriptionRemainingQuantity) > 0.001 ? 'text-amber-400' : 'text-emerald-400'}>
                        Kalan: {subscriptionRemainingQuantity}
                      </span>
                    </div>
                    {subscriptionSegments.map((seg, index) => (
                      <div key={index} className="rounded-md border border-surface-700/40 bg-surface-900/40 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-primary-400">Ay {index + 1}</span>
                          {subscriptionSegments.length > 1 && (
                            <button type="button" onClick={() => removeSubscriptionSegment(index)} className="text-red-400 text-xs px-1">
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
                              onChange={(e) => updateSubscriptionSegment(index, 'quantity', e.target.value)}
                              className="input-field"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-surface-300">
                            Bitiş (Teslimat) Tarihi
                            <DateField
                              value={seg.endDate}
                              onChange={(next) => updateSubscriptionSegment(index, 'endDate', next)}
                              clearable={false}
                            />
                          </label>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-surface-300">
                          <input
                            type="checkbox"
                            checked={seg.is_outsourced}
                            onChange={(e) => updateSubscriptionSegment(index, 'is_outsourced', e.target.checked ? 'true' : 'false')}
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
                              onChange={(e) => updateSubscriptionSegment(index, 'outsource_days', e.target.value)}
                              className="input-field"
                            />
                          </label>
                        )}
                      </div>
                    ))}
                    <button type="button" onClick={addSubscriptionSegment} className="btn-ghost text-xs w-full">
                      + Ay Ekle
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-surface-700/50 bg-surface-800/30 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-1">
              <h3 className={`${sectionHeadingClass} mb-0`}>
                <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Ürün Süreleri
                {form.is_outsourced && (
                  <span className="rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-semibold px-2 py-0.5">Fason</span>
                )}
              </h3>
              <div className="text-right">
                <div className="text-xs text-surface-400">Toplam ürün süresi</div>
                <div className="text-lg font-semibold text-primary-300">{totalWorkdays || 0} iş günü</div>
              </div>
            </div>
            <p className="text-xs text-surface-500 mb-4 flex flex-wrap items-center gap-2">
              {isUsingSavedProduct ? 'Kayıtlı üründen geldiği için süreler kilitli.' : 'Yeni ürün için süreleri girin; sipariş kaydedilince ürün de kaydedilir.'}
            </p>

            {/* Kayıtlı ürün: sistem, bu siparişin adedine göre Tedarik/Dizgi/Üretim/
                Test sürelerini otomatik hesaplayıp burada gösterir — kullanıcı elle
                bir şey girmeden/tıklamadan "sistem önerisi" görür, adet değişince
                canlı güncellenir. */}
            {isUsingSavedProduct && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-1">
                {(
                  [
                    // BOM'lu ürünlerde bileşenlerin bitmesini bekleme süresi Tedarik'e
                    // yansır (computeEffectivePipeline'daki "supply uzatma" kuralı) —
                    // ayrı bir satır DEĞİL, Tedarik'in kendisi budur.
                    ['Tedarik', pipelineBreakdown.supply],
                    // BOM'lu ürünlerde ayrı bir Dizgi adımı yoktur, bu yüzden 0 gösterilir
                    // (bkz. computeEffectivePipeline — effectiveAssembly bilinçli olarak
                    // 0'a çekilir, backend'in Dizgi'yi blok listesinden tamamen çıkarmasıyla
                    // aynı fikir).
                    ...(form.is_outsourced ? [] : ([['Dizgi', pipelineBreakdown.assembly]] as [string, number][])),
                    ['Üretim', pipelineBreakdown.production],
                    ['Test', pipelineBreakdown.test],
                  ] as [string, number][]
                ).map(([label, days]) => (
                  <div key={label} className="rounded-lg bg-surface-900/50 border border-surface-700/40 px-3 py-2 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-surface-500 flex items-center justify-center gap-1">
                      <svg className="w-3 h-3 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {label}
                    </div>
                    <div className="text-base font-semibold text-primary-300">{days} gün</div>
                  </div>
                ))}
              </div>
            )}

            {/* Fason (dış dizgi) toggle — süre alanlarını etkilediği için en üstte */}
            <label className="calendar-outsourced-toggle">
              <input type="checkbox" checked={form.is_outsourced} onChange={(e) => updateForm({ is_outsourced: e.target.checked }, true)} />
              <span><strong>Fason Üretim (Dış Dizgi)</strong><small>Dizgiyi dış firma yapar; dizgi süresi yerine fason süresi girilir</small></span>
            </label>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mt-4">
              {([
                ['Tedarik (gün)', 'supply_days'],
                // Fasonda dizgi yerine fason suresi girilir; disinda Dizgi her zaman
                // adet basina (sure modu kaldirildi).
                ...(form.is_outsourced
                  ? ([['Fason Süresi (gün)', 'outsource_days']] as Array<[string, string]>)
                  : ([['Dizgi (gün/adet)', 'assembly_days']] as Array<[string, string]>)),
                ...(([
                      ['Epoxy (dk/adet)', 'epoxy_minutes'],
                      ['Conformal (dk/adet)', 'conformal_minutes'],
                      ['Montaj (dk/adet)', 'montaj_minutes'],
                      ['Kalite (dk/adet)', 'quality_minutes'],
                      ['M.Kalite (dk/adet)', 'montaj_kalite_minutes'],
                      ['Test1 (dk/adet)', 'test1_minutes'],
                      ['Test2 (dk/adet)', 'test2_minutes'],
                      ['F.Test (dk/adet)', 'final_test_minutes'],
                    ] as Array<[string, string]>)),
                ['Teslimat (gün)', 'delivery_days'],
              ] as Array<[string, string]>).map(([label, field]) => (
                <div key={field}>
                  <label className={fieldLabelClass}>{label}</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    className="input-field"
                    value={form[field]}
                    // Fason süresi sipariş özelinde girilir; kayıtlı ürün kilidinden muaf
                    disabled={isUsingSavedProduct && field !== 'outsource_days'}
                    onChange={(e) => updateForm({ [field]: e.target.value, ...(field === 'assembly_days' ? { production_days: e.target.value } : {}) }, true)}
                  />
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className={sectionHeadingClass}>
              <svg className="w-4 h-4 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              Sipariş Detayları
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className={fieldLabelClass}>Müşteri</label>
                <input type="text" className="input-field" placeholder="Örn: ABC Holding" value={form.customer_name} onChange={(e) => updateForm({ customer_name: e.target.value })} />
              </div>
              <div>
                <label className={fieldLabelClass}>Sipariş Sorumlusu</label>
                <input type="text" className="input-field" placeholder="Örn: Ahmet Yılmaz" value={form.responsible_personnel} onChange={(e) => updateForm({ responsible_personnel: e.target.value })} />
              </div>
              <div>
                <label className={fieldLabelClass}>Sipariş Tarihi</label>
                <DateField value={form.order_date} onChange={(next) => updateForm({ order_date: next })} />
              </div>
              <div>
                <label className={fieldLabelClass}>Gereksinim Tarihi</label>
                <DateField value={form.requirement_date} onChange={(next) => updateForm({ requirement_date: next })} />
              </div>
              <div>
                <label className={fieldLabelClass}>Cezaya Konu Tarihi</label>
                <DateField value={form.penalty_date} onChange={(next) => updateForm({ penalty_date: next })} />
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-700/50 bg-surface-900/60">
          <button type="button" className="btn-ghost text-sm" onClick={onClose} disabled={submitting}>İptal</button>
          <button
            type="button"
            className="btn-success text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={submitting || (subOpen && Math.abs(subscriptionRemainingQuantity) > 0.001)}
            title={subOpen && Math.abs(subscriptionRemainingQuantity) > 0.001 ? `Aylık parça adetleri toplamı sipariş adedine eşit olmalı (kalan: ${subscriptionRemainingQuantity})` : undefined}
            onClick={handleSubmit}
          >
            {submitting
              ? 'Kaydediliyor...'
              : subOpen && Math.abs(subscriptionRemainingQuantity) > 0.001
                ? `Toplam ${subOrderQuantity} olmalı (kalan: ${subscriptionRemainingQuantity})`
                : 'Teslimatı Kaydet'}
          </button>
        </div>
      </div>
    </div>
  );
}
