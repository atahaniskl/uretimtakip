import { useEffect, useRef, useState } from 'react';

export interface EmployeeCapacityValues {
  assembly: number;
  production: number;
  test: number;
}

interface ConcurrencyConflict {
  date: string;
  total_employees: number;
  suggestion: string;
}

interface EmployeeCapacityEditorProps {
  initialValues: EmployeeCapacityValues | null;
  isOutsourced?: boolean;
  floorLocked?: { production?: boolean; test?: boolean };
  loadError?: string;
  onDraftChange: (values: EmployeeCapacityValues | null) => void;
  refreshToken?: number;
  // Kapasite uyarısı — bu değerlerle kaydedilirse conflict oluşuyor.
  capacityWarning?: { max: number; conflicts: ConcurrencyConflict[] } | null;
  // Her adım için kalan kullanılabilir çalışan sayısı.
  remainingCapacity?: Record<string, number>;
  // VIEWER rolü gibi düzenleme yetkisi olmayan kullanıcılar için: kutular yerine
  // salt-okunur değer gösterilir, hiçbir taslak değişikliği üst bileşene bildirilmez.
  readOnly?: boolean;
  // BOM ana ürün kartları için: bu ürünün alt ürünleri varsa kendi Dizgi adımı
  // yoktur (bileşenlerin Dizgi'siyle yapılmış sayılır) — "Dizgi" satırı hiçbir
  // işe yaramayacağı için tamamen gizlenir (isOutsourced'daki "Fason" rozeti
  // gibi salt-okunur bile gösterilmez).
  hideAssembly?: boolean;
}

const parseDecimalInput = (value: string): number => {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return NaN;
  return Number(normalized);
};

const formatDecimalInput = (value: number): string => String(value).replace('.', ',');

const formatConflictDate = (iso: string): string => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('tr-TR');
};

const STEP_FIELDS: { key: keyof EmployeeCapacityValues; label: string }[] = [
  { key: 'assembly', label: 'Dizgi' },
  { key: 'production', label: 'Üretim' },
  { key: 'test', label: 'Test' },
];

const DEFAULT_VALUES: EmployeeCapacityValues = { assembly: 1, production: 1, test: 1 };

export default function EmployeeCapacityEditor({
  initialValues,
  isOutsourced = false,
  floorLocked,
  loadError,
  onDraftChange,
  refreshToken = 0,
  capacityWarning,
  remainingCapacity,
  readOnly = false,
  hideAssembly = false,
}: EmployeeCapacityEditorProps) {
  const [original, setOriginal] = useState<EmployeeCapacityValues | null>(null);
  const [values, setValues] = useState<EmployeeCapacityValues>(DEFAULT_VALUES);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  // Değer imzası değişmedikçe sıfırlama yapılmaz — parent yeniden render olup
  // aynı içerikli yeni bir obje geçtiğinde kullanıcının yazdıkları silinmesin.
  const lastInitRef = useRef('');
  useEffect(() => {
    const next = initialValues ?? DEFAULT_VALUES;
    const signature = `${next.assembly}|${next.production}|${next.test}`;
    if (signature === lastInitRef.current) return;
    lastInitRef.current = signature;
    setOriginal(next);
    setValues(next);
    setInputs({
      assembly: formatDecimalInput(next.assembly),
      production: formatDecimalInput(next.production),
      test: formatDecimalInput(next.test),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValues]);

  // Her render'da güncel tutulur — kayıttan sonraki taban sıfırlama effect'i
  // sunucuya tekrar gitmeden, o an ekranda görünen (az önce kaydedilmiş) değerleri
  // okuyabilsin diye (`refreshToken` bağımlılığına `values`'u eklemeden).
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // Başarılı bir kayıttan sonra sunucuya TEKRAR GİTMEDEN (bu, kart içinde
  // rahatsız edici bir "yükleniyor" yanıp sönmesine sebep oluyordu) — az önce
  // kaydedilen mevcut değerler yeni "orijinal" taban olarak işaretlenir.
  const isFirstRefresh = useRef(true);
  useEffect(() => {
    // `original === null` demek: initialValues efekti henüz gerçek sunucu
    // verisiyle tabanı kurmadı (ör. React'ın geliştirme modunda efektleri
    // bilinçli olarak iki kez çalıştırması — StrictMode — bu efekti gerçek veri
    // render'a yansımadan ÖNCE bir kez daha tetikleyebiliyor). Böyle bir anda
    // `valuesRef.current` hâlâ DEFAULT_VALUES'u (1/1/1) taşıyor olabilir ve bunu
    // "orijinal" diye kaydetmek, kullanıcı gerçekten 1/1/1 girdiğinde bunu
    // "değişiklik yok" sanıp taslağı sessizce silmeye yol açıyordu.
    if (isFirstRefresh.current || original === null) {
      isFirstRefresh.current = false;
      return;
    }
    setOriginal(valuesRef.current);
    onDraftChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleChange = (field: keyof EmployeeCapacityValues, raw: string) => {
    setInputs((prev) => ({ ...prev, [field]: raw }));
    const parsed = parseDecimalInput(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      const nextValues = { ...values, [field]: parsed };
      setValues(nextValues);
      if (original) {
        const changed =
          nextValues.assembly !== original.assembly ||
          nextValues.production !== original.production ||
          nextValues.test !== original.test;
        onDraftChange(changed ? nextValues : null);
      }
    }
  };

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-surface-500 mb-2">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m5-5.13a4 4 0 100-8 4 4 0 000 8zm6 3a4 4 0 10-8 0" />
        </svg>
        Çalışan Ayarları
        <span className="normal-case text-surface-600 font-normal">— bu adımda aynı anda kaç kişi çalışsın</span>
      </div>
      {loadError ? (
        <div className="text-xs text-red-400">{loadError}</div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {STEP_FIELDS.filter(({ key }) => !(key === 'assembly' && hideAssembly)).map(({ key, label }) =>
              key === 'assembly' && isOutsourced ? (
                <div key={key} className="flex items-center gap-2 text-sm text-surface-300">
                  <span className="w-10 shrink-0">{label}</span>
                  <span
                    className="px-2 py-1 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-medium"
                    title="Fason (dış dizgi) siparişlerde bu adımda kendi çalışanınız çalışmaz"
                  >
                    Fason
                  </span>
                </div>
              ) : (
                <div key={key} className="flex items-center gap-2">
                  <label className="text-sm text-surface-300 w-10 shrink-0">{label}</label>
                  {readOnly ? (
                    <span className="w-14 px-1.5 py-1 bg-surface-800/40 border border-surface-700/30 rounded text-surface-300 text-sm font-medium text-center">
                      {inputs[key] ?? ''}
                    </span>
                  ) : (
                    <input
                      type="text"
                      inputMode="decimal"
                      value={inputs[key] ?? ''}
                      onChange={(e) => handleChange(key, e.target.value)}
                      className="w-14 px-1.5 py-1 bg-surface-800/60 border border-surface-700/50 rounded text-surface-100 text-sm font-medium text-center focus:outline-none focus:ring-2 focus:ring-primary-500/50"
                    />
                  )}
                  <span className="text-surface-600 text-sm shrink-0">kişi</span>
                  {!readOnly && (
                    <span className="text-sm text-surface-500 ml-4">
                      {(() => {
                        // `remainingCapacity[key]` backend'den gelen, bu adımın KENDİ
                        // atamasını hariç tutan bir TAVAN değeridir (aynı anda toplamda
                        // en fazla kaç kişi çalışabilir) — kutuya ne yazılırsa yazılsın
                        // SABİT kalır. "Kalan" etiketi kullanıcıya "şu an yazdığım
                        // sayıdan sonra daha kaç kişi ekleyebilirim" gibi geldiği için,
                        // burada kutudaki GÜNCEL değer bu tavandan düşülerek anlık,
                        // gerçekten "kalan" bir sayı gösterilir.
                        const ceiling = remainingCapacity?.[key];
                        if (ceiling == null) return '';
                        const current = values[key] || 0;
                        const remainingAfterOwn = Math.max(0, ceiling - current);
                        return `Kalan: ${remainingAfterOwn}`;
                      })()}
                    </span>
                  )}
                </div>
              ),
            )}
          </div>

          {(floorLocked?.production || floorLocked?.test) && (
            <div className="mt-2 flex flex-col gap-1">
              {floorLocked.production && (
                <span className="text-xs text-amber-400/80 leading-tight">
                  ⚠️ Üretim adımının toplam iş yükü 1 iş gününün altında — kişi eklemek süreyi kısaltmaz.
                </span>
              )}
              {floorLocked.test && (
                <span className="text-xs text-amber-400/80 leading-tight">
                  ⚠️ Test adımının toplam iş yükü 1 iş gününün altında — kişi eklemek süreyi kısaltmaz.
                </span>
              )}
            </div>
          )}

          {capacityWarning && (
            <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <p className="font-semibold mb-1">
                Bu çalışan sayıları genel kapasiteyi aşıyor (aynı anda en fazla {capacityWarning.max} kişi) —
                bu değerlerle kayıt yapılamaz
              </p>
              {capacityWarning.conflicts.slice(0, 3).map((c) => (
                <p key={c.date} className="text-amber-200/90">
                  {formatConflictDate(c.date)}: toplam {c.total_employees} kişi — {c.suggestion}
                </p>
              ))}
              {capacityWarning.conflicts.length > 3 && (
                <p className="text-amber-300/70 mt-0.5">
                  +{capacityWarning.conflicts.length - 3} gün daha…
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
