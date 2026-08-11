/**
 * Product info master-data page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import {
  resolveDurationMode,
  PRODUCTION_MINUTE_FIELDS,
  TEST_MINUTE_FIELDS,
} from '../lib/durationMode';

interface SubProductItem {
  product_id: string;
  product_name: string;
  quantity: number;
}

interface ProductInfoItem {
  id: string;
  product_name: string;
  supply_days: number;
  assembly_days: number;
  delivery_days: number;
  quality_minutes: number | null;
  epoxy_minutes: number | null;
  conformal_minutes: number | null;
  montaj_minutes: number | null;
  montaj_kalite_minutes: number | null;
  test1_minutes: number | null;
  test2_minutes: number | null;
  final_test_minutes: number | null;
  duration_mode: 'per_unit' | 'flat' | null;
  production_flat_days: number | null;
  test_flat_days: number | null;
  assembly_flat_days: number | null;
  sub_products: SubProductItem[];
  created_at: string;
  updated_at: string;
}

interface SubProductRow {
  productId: string;
  quantity: string;
}


interface ProductInfoFormState {
  product_name: string;
  supply_days: string;
  assembly_days: string;
  delivery_days: string;
  quality_minutes: string;
  epoxy_minutes: string;
  conformal_minutes: string;
  montaj_minutes: string;
  montaj_kalite_minutes: string;
  test1_minutes: string;
  test2_minutes: string;
  final_test_minutes: string;
  durationMode: 'per_unit' | 'flat';
  production_flat_days: string;
  test_flat_days: string;
  assembly_flat_days: string;
  subProducts: SubProductRow[];
}

const emptyFormState = (): ProductInfoFormState => ({
  product_name: '',
  supply_days: '',
  assembly_days: '',
  delivery_days: '',
  quality_minutes: '',
  epoxy_minutes: '',
  conformal_minutes: '',
  montaj_minutes: '',
  montaj_kalite_minutes: '',
  test1_minutes: '',
  test2_minutes: '',
  final_test_minutes: '',
  durationMode: 'per_unit',
  production_flat_days: '',
  test_flat_days: '',
  assembly_flat_days: '',
  subProducts: [],
});

const toFormState = (item: ProductInfoItem): ProductInfoFormState => ({
  product_name: item.product_name,
  supply_days: String(item.supply_days),
  assembly_days: String(item.assembly_days),
  delivery_days: String(item.delivery_days),
  quality_minutes: item.quality_minutes != null ? String(item.quality_minutes) : '',
  epoxy_minutes: item.epoxy_minutes != null ? String(item.epoxy_minutes) : '',
  conformal_minutes: item.conformal_minutes != null ? String(item.conformal_minutes) : '',
  montaj_minutes: item.montaj_minutes != null ? String(item.montaj_minutes) : '',
  montaj_kalite_minutes: item.montaj_kalite_minutes != null ? String(item.montaj_kalite_minutes) : '',
  test1_minutes: item.test1_minutes != null ? String(item.test1_minutes) : '',
  test2_minutes: item.test2_minutes != null ? String(item.test2_minutes) : '',
  final_test_minutes: item.final_test_minutes != null ? String(item.final_test_minutes) : '',
  // NULL, hesaplama tarafinda "flat" demektir (bkz. resolveDurationMode) — burada
  // 'per_unit' gosterilirse duzenle ekrani, urunun gercekte nasil hesaplandigiyla
  // celisir ve kaydedince modu sessizce degistirirdi.
  durationMode: resolveDurationMode(item.duration_mode),
  production_flat_days: item.production_flat_days != null ? String(item.production_flat_days) : '',
  test_flat_days: item.test_flat_days != null ? String(item.test_flat_days) : '',
  assembly_flat_days: item.assembly_flat_days != null ? String(item.assembly_flat_days) : '',
  subProducts: item.sub_products.map((sp) => ({ productId: sp.product_id, quantity: String(sp.quantity) })),
});

// Dolu dakika alanlarinin toplami + hangi adimlardan olustugunu anlatan tooltip.
// Hicbiri dolu degilse null — hucre "—" gosterir.
;

/** Sayi + kucuk birim etiketi. Birim her hucrede yazili oldugu icin "gun" ile
 *  "dk/adet" degerleri ayni kolonda bile birbirine karismaz. */
function ValueCell({
  value,
  unit,
  title,
  accent = false,
  accentClass = 'text-amber-200',
  compact = false,
}: {
  value: number | null | undefined;
  unit: string;
  title?: string;
  accent?: boolean;
  /** Vurgulu deger rengi — uretim adimlari amber, test adimlari sky. */
  accentClass?: string;
  compact?: boolean;
}) {
  const pad = compact ? 'py-2 px-3' : 'py-3 px-4';
  if (value === null || value === undefined) {
    return <td className={`${pad} text-surface-600 whitespace-nowrap`}>—</td>;
  }
  return (
    <td className={`${pad} whitespace-nowrap`} title={title}>
      <span className={accent ? accentClass : 'text-surface-200'}>{value}</span>
      <span className="ml-1 text-[10px] text-surface-500">{unit}</span>
    </td>
  );
}

/** Dizgi + her uretim/test adimi AYRI birer hucre. Eskiden Uretim ve Test tek bir
 *  toplamda birlestirilip dokum tooltip'e saklaniyordu; artik her adim kendi
 *  sutununda, cunku hangi adimin ne kadar surdugu tabloda dogrudan gorunmeli.
 *  Degerler HER ZAMAN adet basinadir (g/ad, dk/ad) — sure modu kavrami kaldirildi. */
function DurationCells({ item, compact }: { item: ProductInfoItem; compact?: boolean }) {
  const pad = compact ? 'py-2 px-3' : 'py-3 px-4';
  const minuteCell = (field: string, label: string, accentClass: string) => {
    const raw = (item as unknown as Record<string, number | null>)[field];
    if (raw === null || raw === undefined) {
      return <td key={field} className={`${pad} text-surface-600 whitespace-nowrap`}>—</td>;
    }
    return (
      <ValueCell
        key={field}
        value={raw}
        unit="dk/ad"
        accent
        accentClass={accentClass}
        compact={compact}
        title={`${label} — adet başına dakika`}
      />
    );
  };
  return (
    <>
      <ValueCell
        value={item.assembly_days}
        unit="g/ad"
        accent
        compact={compact}
        title="Dizgi — adet başına gün; sipariş süresi = değer × adet ÷ dizgi işçisi"
      />
      {PRODUCTION_MINUTE_FIELDS.map(([field, label]) => minuteCell(field, label, 'text-amber-300'))}
      {TEST_MINUTE_FIELDS.map(([field, label]) => minuteCell(field, label, 'text-sky-300'))}
    </>
  );
}


/** Bir urunu (ve acilmissa alt urunlerini) AYNI tablonun satirlari olarak render
 *  eder — alt urunler icin ayri bir <table> kurulmaz, boylece tum seviyelerdeki
 *  kolonlar hizali kalir ve hiyerarsi yalnizca girintiyle anlatilir. */
function ProductRows({
  item,
  quantity,
  depth,
  itemsById,
  expandedIds,
  toggleExpanded,
  canEdit,
  onEdit,
  onDelete,
  deletingId,
}: {
  item: ProductInfoItem;
  /** Ust urunun 1 adedi icin gereken miktar — yalnizca alt urun satirlarinda dolu. */
  quantity: number | null;
  depth: number;
  itemsById: Map<string, ProductInfoItem>;
  expandedIds: Set<string>;
  toggleExpanded: (id: string) => void;
  canEdit: boolean;
  onEdit: (item: ProductInfoItem) => void;
  onDelete: (item: ProductInfoItem) => void;
  deletingId: string | null;
}) {
  const hasChildren = item.sub_products.length > 0;
  const isOpen = expandedIds.has(item.id);
  const isSub = depth > 0;
  const pad = isSub ? 'py-2 px-3' : 'py-3 px-4';

  return (
    <>
      <tr
        className={`border-b border-surface-800/50 hover:bg-surface-800/30 align-middle ${
          isSub ? 'bg-surface-900/40 text-xs' : ''
        }`}
      >
        <td className={`${pad} whitespace-nowrap`}>
          <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
            {isSub && <span className="text-surface-600 select-none">└</span>}
            {hasChildren ? (
              <button
                type="button"
                className="text-primary-400 hover:text-primary-300 text-[10px] w-3 shrink-0"
                onClick={() => toggleExpanded(item.id)}
                title={isOpen ? 'Alt ürünleri gizle' : 'Alt ürünleri göster'}
              >
                {isOpen ? '▲' : '▼'}
              </button>
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className={isSub ? 'text-surface-300' : 'text-surface-100 font-medium'}>{item.product_name}</span>
            {hasChildren && (
              <span className="text-[10px] text-surface-500">({item.sub_products.length} alt ürün)</span>
            )}
          </div>
        </td>
        <td className={`${pad} whitespace-nowrap`}>
          {quantity === null ? (
            <span className="text-surface-600">—</span>
          ) : (
            <span className="text-surface-300" title="Üst üründen 1 adet üretmek için gereken miktar">
              ×{quantity}
            </span>
          )}
        </td>
        <ValueCell value={item.supply_days} unit="gün" compact={isSub} title="Tedarik — sabit iş günü" />
        <DurationCells item={item} compact={isSub} />
        <ValueCell value={item.delivery_days} unit="gün" compact={isSub} title="Teslimat — sabit iş günü" />
        {canEdit && (
          <td className={`${pad} text-right whitespace-nowrap`}>
            <div className="inline-flex items-center gap-1.5">
              <button type="button" className="btn-ghost text-[11px] px-2 py-1" onClick={() => onEdit(item)}>
                Düzenle
              </button>
              <button
                type="button"
                className="btn-ghost text-[11px] px-2 py-1 border border-red-500/40 text-red-300 hover:bg-red-500/10"
                onClick={() => onDelete(item)}
                disabled={deletingId === item.id}
              >
                {deletingId === item.id ? 'Siliniyor...' : 'Sil'}
              </button>
            </div>
          </td>
        )}
      </tr>

      {isOpen &&
        item.sub_products.map((sp) => {
          const child = itemsById.get(sp.product_id);
          if (!child) return null;
          return (
            <ProductRows
              key={`${item.id}-${sp.product_id}`}
              item={child}
              quantity={sp.quantity}
              depth={depth + 1}
              itemsById={itemsById}
              expandedIds={expandedIds}
              toggleExpanded={toggleExpanded}
              canEdit={canEdit}
              onEdit={onEdit}
              onDelete={onDelete}
              deletingId={deletingId}
            />
          );
        })}
    </>
  );
}

// Kullanıcı ondalık ayırıcı olarak virgül yazabilir (ör. "1,5") — Number() bunu
// NaN sanıp reddetmesin diye noktaya çevriliyor.
const normalizeDecimal = (value: string) => value.trim().replace(',', '.');

const parseInteger = (value: string) => {
  const trimmed = normalizeDecimal(value);
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
};

const parseFloatValue = (value: string) => {
  const trimmed = normalizeDecimal(value);
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

export default function ProductInfoPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<ProductInfoItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ProductInfoItem | null>(null);
  const [formState, setFormState] = useState<ProductInfoFormState>(emptyFormState());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const isAuthorized = user?.role === 'ADMIN' || user?.role === 'PLANNER' || user?.role === 'VIEWER';
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  // Urun | Adet | Tedarik | Dizgi | <uretim/test adimlari> | Teslimat (+ Islem)
  const colCount = canEdit ? 9 : 8;

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.product_name.localeCompare(b.product_name, 'tr-TR')),
    [items],
  );

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // Baska bir urunun alt urunu olarak kullanilan urunler, ust listede tekrar
  // ayri bir siparis edilebilir urun gibi gorunmesin — sadece ait olduklari
  // urunun altinda genisletilince gorunsunler.
  const subProductIdSet = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => item.sub_products.forEach((sp) => set.add(sp.product_id)));
    return set;
  }, [items]);

  const topLevelItems = useMemo(
    () => sortedItems.filter((item) => !subProductIdSet.has(item.id)),
    [sortedItems, subProductIdSet],
  );

  const fetchItems = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get<ProductInfoItem[]>('/product-info/');
      setItems(Array.isArray(data) ? data : []);
      setError('');
    } catch (e: any) {
      setItems([]);
      setError(String(e?.response?.data?.detail || 'Urun bilgileri yuklenemedi.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    fetchItems();
  }, [fetchItems, isAuthorized]);

  const openCreateModal = () => {
    if (!canEdit) return;
    setEditingItem(null);
    setFormState(emptyFormState());
    setSuccess('');
    setError('');
    setIsModalOpen(true);
  };

  const openEditModal = (item: ProductInfoItem) => {
    setEditingItem(item);
    setFormState(toFormState(item));
    setSuccess('');
    setError('');
    setIsModalOpen(true);
  };

  const closeModal = () => {
    if (isSaving) return;
    setIsModalOpen(false);
    setEditingItem(null);
    setFormState(emptyFormState());
  };

  const updateField = (field: keyof ProductInfoFormState, value: string) => {
    // Urun adi disindaki tum alanlar sure/dakika gibi negatif olamayacak
    // buyuklukler (backend de ayni sekilde ge=0 zorunlu tutuyor) — eksi isaretli
    // bir girisi kaydete kadar bekletmeden dogrudan reddet.
    if (field !== 'product_name' && value.includes('-')) return;
    setFormState((prev) => ({ ...prev, [field]: value }));
  };


  const addSubProductRow = () => {
    setFormState((prev) => ({ ...prev, subProducts: [...prev.subProducts, { productId: '', quantity: '1' }] }));
  };

  const updateSubProductRow = (index: number, field: keyof SubProductRow, value: string) => {
    if (field === 'quantity' && value.includes('-')) return;
    setFormState((prev) => ({
      ...prev,
      subProducts: prev.subProducts.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    }));
  };

  const removeSubProductRow = (index: number) => {
    setFormState((prev) => ({ ...prev, subProducts: prev.subProducts.filter((_, i) => i !== index) }));
  };

  const handleSubmit = async () => {
    const cleanedName = formState.product_name.trim();
    const supplyDays = parseInteger(formState.supply_days);
    const assemblyDays = parseFloatValue(formState.assembly_days);
    const deliveryDays = parseInteger(formState.delivery_days);

    if (!cleanedName) {
      setError('Urun adi zorunludur.');
      return;
    }
    if (supplyDays === null || assemblyDays === null || deliveryDays === null) {
      setError('Temel sure alanlarini sayisal olarak doldurun.');
      return;
    }

    const filledSubProductRows = formState.subProducts.filter((row) => row.productId);
    const subProductIds = filledSubProductRows.map((row) => row.productId);
    if (new Set(subProductIds).size !== subProductIds.length) {
      setError('Ayni alt urun birden fazla kez eklenemez.');
      return;
    }
    const subProducts: { product_id: string; quantity: number }[] = [];
    for (const row of filledSubProductRows) {
      const quantity = parseInteger(row.quantity);
      if (quantity === null || quantity < 1) {
        setError('Alt urun miktarlari en az 1 olan tam sayi olmalidir.');
        return;
      }
      subProducts.push({ product_id: row.productId, quantity });
    }

    try {
      setIsSaving(true);
      setError('');
      setSuccess('');

      const payload = {
        product_name: cleanedName,
        supply_days: supplyDays,
        assembly_days: assemblyDays,
        delivery_days: deliveryDays,
        quality_minutes: formState.quality_minutes ? parseFloatValue(formState.quality_minutes) : null,
        epoxy_minutes: formState.epoxy_minutes ? parseFloatValue(formState.epoxy_minutes) : null,
        conformal_minutes: formState.conformal_minutes ? parseFloatValue(formState.conformal_minutes) : null,
        montaj_minutes: formState.montaj_minutes ? parseFloatValue(formState.montaj_minutes) : null,
        montaj_kalite_minutes: formState.montaj_kalite_minutes ? parseFloatValue(formState.montaj_kalite_minutes) : null,
        test1_minutes: formState.test1_minutes ? parseFloatValue(formState.test1_minutes) : null,
        test2_minutes: formState.test2_minutes ? parseFloatValue(formState.test2_minutes) : null,
        final_test_minutes: formState.final_test_minutes ? parseFloatValue(formState.final_test_minutes) : null,
        // Sure modu kaldirildi — sistem her zaman adet basina hesaplar. Alan API
        // sozlesmesinde durdugu icin sabit "per_unit" gonderilir; *_flat_days ise
        // urun ana verisinde artik kullanilmiyor, mevcut degerler aynen korunur
        // (silinmesin diye) ama zamanlamaya etkisi yok.
        duration_mode: 'per_unit',
        production_flat_days: formState.production_flat_days ? parseFloatValue(formState.production_flat_days) : null,
        test_flat_days: formState.test_flat_days ? parseFloatValue(formState.test_flat_days) : null,
        assembly_flat_days: formState.assembly_flat_days ? parseFloatValue(formState.assembly_flat_days) : null,
        sub_products: subProducts,
      };

      if (editingItem) {
        await api.patch(`/product-info/${editingItem.id}`, payload);
        setSuccess('Urun bilgisi guncellendi.');
      } else {
        await api.post('/product-info/', payload);
        setSuccess('Urun bilgisi eklendi.');
      }

      closeModal();
      await fetchItems();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Urun bilgisi kaydedilemedi.';
      setError(String(message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (item: ProductInfoItem) => {
    if (!window.confirm(`"${item.product_name}" urun bilgisini silmek istediginize emin misiniz?`)) {
      return;
    }

    try {
      setDeletingId(item.id);
      setError('');
      setSuccess('');
      await api.delete(`/product-info/${item.id}`);
      setSuccess('Urun bilgisi silindi.');
      await fetchItems();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Urun bilgisi silinemedi.';
      setError(String(message));
    } finally {
      setDeletingId(null);
    }
  };

  if (!isAuthorized) {
    return (
      <div className="p-6">
        <div className="glass-card p-6 text-sm text-red-300 border border-red-500/20">
          Bu alana erisim yetkiniz bulunmuyor.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Urun Bilgisi</h1>
          <p className="text-surface-400 text-sm mt-1">Urun bazli tedarik, dizgi, kalite, test ve teslimat bilgilerini yonetin.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-sm" onClick={fetchItems} disabled={isLoading}>Yenile</button>
          {canEdit && <button className="btn-primary text-sm" onClick={openCreateModal}>Yeni Urun Ekle</button>}
        </div>
      </div>

      {error && !isModalOpen && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-xl text-sm mb-4">
          {success}
        </div>
      )}


      <div className="overflow-x-auto glass-card">
        <table className="w-full text-sm min-w-max">
          <thead>
            <tr className="border-b border-surface-700/50 text-surface-400">
              <th className="text-left py-3 px-4 font-medium whitespace-nowrap">Ürün</th>
              <th className="text-left py-3 px-4 font-medium whitespace-nowrap">Adet</th>
              <th className="text-left py-3 px-4 font-medium whitespace-nowrap">Tedarik</th>
              <th className="text-left py-3 px-4 font-medium whitespace-nowrap">Dizgi</th>
              {PRODUCTION_MINUTE_FIELDS.map(([field, label]) => (
                <th key={field} className="text-left py-3 px-4 font-medium whitespace-nowrap text-amber-400/80">{label}</th>
              ))}
              {TEST_MINUTE_FIELDS.map(([field, label]) => (
                <th key={field} className="text-left py-3 px-4 font-medium whitespace-nowrap text-sky-400/80">{label}</th>
              ))}
              <th className="text-left py-3 px-4 font-medium whitespace-nowrap">Teslimat</th>
              {canEdit && <th className="text-right py-3 px-4 font-medium whitespace-nowrap">İşlem</th>}
            </tr>
            <tr className="border-b border-surface-700/30 text-surface-500 text-xs">
              <th className="text-left py-1 px-4 font-normal">&nbsp;</th>
              <th className="text-left py-1 px-4 font-normal">(alt ürün)</th>
              <th className="text-left py-1 px-4 font-normal">(gün)</th>
              <th className="text-left py-1 px-4 font-normal">(gün/adet)</th>
              {[...PRODUCTION_MINUTE_FIELDS, ...TEST_MINUTE_FIELDS].map(([field]) => (
                <th key={field} className="text-left py-1 px-4 font-normal">(dk/adet)</th>
              ))}
              <th className="text-left py-1 px-4 font-normal">(gün)</th>
              {canEdit && <th className="text-right py-1 px-4 font-normal">&nbsp;</th>}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={colCount} className="py-12 text-center text-surface-500">Yükleniyor...</td>
              </tr>
            )}

            {!isLoading && topLevelItems.length === 0 && (
              <tr>
                <td colSpan={colCount} className="py-12 text-center text-surface-500">Ürün bilgisi kaydı yok.</td>
              </tr>
            )}

            {!isLoading && topLevelItems.map((item) => (
              <ProductRows
                key={item.id}
                item={item}
                quantity={null}
                depth={0}
                itemsById={itemsById}
                expandedIds={expandedIds}
                toggleExpanded={toggleExpanded}
                canEdit={canEdit}
                onEdit={openEditModal}
                onDelete={handleDelete}
                deletingId={deletingId}
              />
            ))}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto glass-card p-6">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <h2 className="text-xl font-bold text-white">{editingItem ? 'Urun Bilgisini Duzenle' : 'Yeni Urun Bilgisi'}</h2>
                <p className="text-sm text-surface-400 mt-1">Her urun icin asama surelerini tek kayitta saklayin.</p>
              </div>
              <button type="button" className="btn-ghost text-sm" onClick={closeModal} disabled={isSaving}>Kapat</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block text-sm text-surface-300 md:col-span-2">
                Urun Adi *
                <input
                  type="text"
                  className="input-field mt-1"
                  value={formState.product_name}
                  onChange={(e) => updateField('product_name', e.target.value)}
                  placeholder="Ornek: Guc Kaynagi"
                />
              </label>

              <label className="block text-sm text-surface-300">
                Tedarik Suresi (gun) *
                <input
                  type="text"
                  inputMode="decimal"
                  className="input-field mt-1"
                  value={formState.supply_days}
                  onChange={(e) => updateField('supply_days', e.target.value)}
                />
              </label>

              {/* Dizgi her zaman ADET BASINA girilir — sure modu kaldirildi.
                  Bir siparise ozel toplam is gunu yazmak isteyen kullanici bunu
                  siparis duzenleme ekranindan yapar, urun ana verisinden degil. */}
              <label className="block text-sm text-surface-300">
                Dizgi Suresi (gun/adet) *
                <input
                  type="text"
                  inputMode="decimal"
                  className="input-field mt-1"
                  value={formState.assembly_days}
                  onChange={(e) => updateField('assembly_days', e.target.value)}
                />
              </label>

                <label className="block text-sm text-surface-300">
                  Kalite (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.quality_minutes}
                    onChange={(e) => updateField('quality_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  Test1 (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.test1_minutes}
                    onChange={(e) => updateField('test1_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  Epoxy (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.epoxy_minutes}
                    onChange={(e) => updateField('epoxy_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  Conformal (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.conformal_minutes}
                    onChange={(e) => updateField('conformal_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  Test2 (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.test2_minutes}
                    onChange={(e) => updateField('test2_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  Montaj (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.montaj_minutes}
                    onChange={(e) => updateField('montaj_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  M.Kalite (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.montaj_kalite_minutes}
                    onChange={(e) => updateField('montaj_kalite_minutes', e.target.value)}
                  />
                </label>

                <label className="block text-sm text-surface-300">
                  F.Test (dk/adet)
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field mt-1"
                    value={formState.final_test_minutes}
                    onChange={(e) => updateField('final_test_minutes', e.target.value)}
                  />
                </label>
              

              <label className="block text-sm text-surface-300">
                Teslimat Suresi (gun) *
                <input
                  type="text"
                  inputMode="decimal"
                  className="input-field mt-1"
                  value={formState.delivery_days}
                  onChange={(e) => updateField('delivery_days', e.target.value)}
                />
              </label>

           </div>

            <div className="mt-6">
              <p className="text-sm text-surface-300">Alt Urunler</p>
              <p className="text-xs text-surface-500 mb-2">
                1 adet "{formState.product_name.trim() || 'bu urun'}" uretmek icin gereken alt urun miktarini yaziniz.
              </p>
              <div className="space-y-2">
                {formState.subProducts.map((row, index) => {
                  const otherSelectedIds = formState.subProducts
                    .filter((_, i) => i !== index)
                    .map((r) => r.productId);
                  const options = sortedItems.filter(
                    (p) => p.id !== editingItem?.id && (p.id === row.productId || !otherSelectedIds.includes(p.id)),
                  );
                  const selectedName = sortedItems.find((p) => p.id === row.productId)?.product_name || 'bu alt urunden';
                  return (
                    <div key={index} className="flex items-center gap-2">
                      <select
                        className="input-field"
                        value={row.productId}
                        onChange={(e) => updateSubProductRow(index, 'productId', e.target.value)}
                      >
                        <option value="">Urun seciniz</option>
                        {options.map((p) => (
                          <option key={p.id} value={p.id}>{p.product_name}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="input-field w-24"
                        placeholder="Adet"
                        title={`1 adet "${formState.product_name.trim() || 'bu urun'}" icin kac adet ${selectedName} gerekiyor?`}
                        value={row.quantity}
                        onChange={(e) => updateSubProductRow(index, 'quantity', e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-ghost text-xs px-3 py-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10"
                        onClick={() => removeSubProductRow(index)}
                      >
                        Kaldir
                      </button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="btn-ghost text-xs mt-2" onClick={addSubProductRow}>
                Alt Urun Ekle
              </button>
            </div>

            <p className="text-xs text-surface-500 mt-3">(*) ile isaretli alanlar zorunludur.</p>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mt-6">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button type="button" className="btn-ghost text-sm" onClick={closeModal} disabled={isSaving}>Vazgec</button>
              <button type="button" className="btn-primary text-sm" onClick={handleSubmit} disabled={isSaving}>
                {isSaving ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}