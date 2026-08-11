/**
 * Appearance / display preferences page.
 *
 * Kullanicinin KENDI gorunum tercihleri icin ayrilmis sayfa — sistem geneli
 * uretim parametrelerini tutan Konfigurasyon (SettingsPage.tsx) sayfasindan
 * bilincli olarak AYRIDIR: oradaki degerler herkesin planini etkiler, buradakiler
 * yalnizca ekranin nasil gorundugunu degistirir ve tarayicida saklanir.
 */

import { useAppearanceSettings, setAppearanceSetting } from '../lib/appearanceSettings';

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 p-4 rounded-xl bg-surface-800/40 border border-surface-700/50 cursor-pointer hover:border-surface-600 transition-colors">
      <input
        type="checkbox"
        className="mt-0.5 w-4 h-4 accent-primary-500 cursor-pointer flex-shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm text-surface-200 font-medium">{title}</span>
        <span className="block text-xs text-surface-500 mt-1 leading-relaxed">{description}</span>
      </span>
    </label>
  );
}

export default function AppearancePage() {
  const settings = useAppearanceSettings();

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Görünüm Ayarları</h1>
          <p className="text-surface-400 text-sm mt-1">
            Ekranın nasıl göründüğüyle ilgili kişisel tercihlerinizi buradan yönetin.
          </p>
        </div>
      </div>

      <div className="glass-card p-6 max-w-3xl">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider mb-1">
          Hiyerarşik Gantt
        </h2>
        <p className="text-xs text-surface-500 mb-4">
          Teslimat Takvimi'ndeki Dikey ve Yatay Gantt görünümlerini etkiler.
        </p>

        <div className="space-y-3">
          <ToggleRow
            title="Kapatılan satırlarda özet bar göster"
            description="Bir siparişi, parçalı teslimatı veya alt ürünü kapattığınızda satırı boş bırakmak yerine, gizlenen tüm adımları kapsayan tek bir bar çizilir. Böylece kalabalık olmadan başlangıç ve bitiş tarihini görmeye devam edersiniz. Bara tıklamak satırı yeniden açar."
            checked={settings.collapsedSummaryBar}
            onChange={(next) => setAppearanceSetting('collapsedSummaryBar', next)}
          />
        </div>

        <p className="text-xs text-surface-600 mt-5">
          Bu tercihler yalnızca sizin tarayıcınızda saklanır; başka kullanıcıları veya
          üretim planını etkilemez. Sistem geneli üretim parametreleri için{' '}
          <span className="text-surface-500">Konfigürasyon</span> sayfasını kullanın.
        </p>
      </div>
    </div>
  );
}
