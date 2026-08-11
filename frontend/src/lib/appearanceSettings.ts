/**
 * Kullanicinin KISISEL gorunum tercihleri.
 *
 * Sunucuda degil, tarayicida (localStorage) saklanir — bunlar yalnizca ekranin
 * nasil gorundugunu degistirir, kimsenin planini/verisini etkilemez. Sistem
 * geneli uretim parametreleri bunun tam tersidir ve backend'de tutulur
 * (bkz. /settings — "Konfigurasyon" sayfasi).
 *
 * Ayni ayari birden fazla bilesen okur (ayar sayfasi yazar, takvim okur), bu
 * yuzden degisiklik bir CustomEvent ile yayinlanir: React state'i olmayan
 * yollardan (baska sekme, baska bilesen) yapilan degisiklikler de aninda
 * yansisin diye.
 */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'dps_appearance';
const CHANGE_EVENT = 'dps-appearance-change';

export interface AppearanceSettings {
  /** Kapatilmis (collapse edilmis) siparis/parca satirinda, gizlenen tum
   *  asamalari kapsayan TEK bir ozet bar gosterilsin mi? Kapaliyken satir bos
   *  kalir (eski davranis). */
  collapsedSummaryBar: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  collapsedSummaryBar: true,
};

export function readAppearanceSettings(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_APPEARANCE;
    // Varsayilanlarla birlestirilir: ileride yeni bir ayar eklendiginde, eski
    // kayitli JSON'da o anahtar bulunmadigi icin undefined kalmasin.
    return { ...DEFAULT_APPEARANCE, ...parsed };
  } catch {
    // Bozuk/erisilemeyen localStorage (gizli sekme, kota dolu) ayarlar yuzunden
    // takvimi cokertmemeli — varsayilana duselim.
    return DEFAULT_APPEARANCE;
  }
}

export function setAppearanceSetting<K extends keyof AppearanceSettings>(
  key: K,
  value: AppearanceSettings[K],
): void {
  const next = { ...readAppearanceSettings(), [key]: value };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Yazilamasa bile (kota/gizli mod) en azindan bu oturumdaki dinleyiciler
    // guncellensin — ayar kalici olmaz ama arayuz tutarsiz gorunmez.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Ayarları okuyan ve değişiklikleri canlı izleyen hook. */
export function useAppearanceSettings(): AppearanceSettings {
  const [settings, setSettings] = useState<AppearanceSettings>(readAppearanceSettings);

  useEffect(() => {
    const sync = () => setSettings(readAppearanceSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    // 'storage' yalnizca BASKA sekmelerdeki degisikliklerde tetiklenir —
    // ayni sekmedeki degisiklikler icin yukaridaki CustomEvent gerekli.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return settings;
}
