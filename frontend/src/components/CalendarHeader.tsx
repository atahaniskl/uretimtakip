import type { ReactNode } from 'react';

/**
 * Takvimin TEK header'ı — Özet (Aylık/Yıllık), Adım (Aylık/Yıllık) ve
 * Hiyerarşik Gantt (Dikey/Yatay) görünümlerinin HEPSİ bunu kullanır.
 *
 * Amaç: görünüm değiştirince header'ın yeri, yüksekliği ve düğmelerin x
 * konumu DEĞİŞMESİN. Bunun için:
 *   - Yükseklik sabit (60px) ve `flex-wrap: nowrap` — dar pencerede satır
 *     kırılmaz, header kendi içinde yatay kayar (bkz. index.css
 *     ".calendar-header").
 *   - DÜĞME SIRASI, görünüme göre gelip giden denetimler kümenin ORTASINDA
 *     boşluk bırakmayacak şekilde kurgulanmıştır: gelip gidenler her zaman
 *     kümenin İÇ ucundadır (sol kümede en sağda, sağ kümede en solda —
 *     yani ortadaki başlığa bakan uçta). Sol küme header'ın soluna, sağ küme
 *     sağına yapışık olduğu için, iç uçtaki bir düğme kaybolduğunda kalan
 *     düğmelerin hiçbiri yerinden oynamaz; boşalan yeri esneyen başlık yutar.
 *     Bu sayede yer tutucu (görünmez placeholder) gerekmez.
 *   - Etiketi duruma göre değişen düğmelere (Filtreyi Aç / Filtreyi Kapat)
 *     sabit min-width verilir; metin uzayınca düğme büyüyüp yanındakini
 *     itmesin diye. Durumu METİNLE değil renkle aktaran düğmeler (ör. "Aktif
 *     Siparişler") zaten boyut değiştirmediği için buna ihtiyaç duymaz.
 *
 * Her görünüm bu header'ı KENDİ kökünde, yükleniyor/hata dallarının da
 * ÜSTÜNDE render eder — böylece Özet'ten Detay'a geçerken sayfanın tamamı
 * spinner'a dönmez, yalnızca gövde değişir.
 */
export interface CalendarHeaderProps {
  /**
   * "Aktif Siparişler" panelini açıp kapatan düğme. Verilmezse (Hiyerarşik
   * Gantt'ta olduğu gibi) hiç çizilmez — sol kümenin EN SAĞINDA durduğu için
   * yokluğu soldaki ok düğmelerini oynatmaz.
   */
  sidebar?: { collapsed: boolean; onToggle: () => void };
  onPrev: () => void;
  onNext: () => void;
  prevAriaLabel?: string;
  nextAriaLabel?: string;
  /** Ortadaki başlık: ay adı, yıl ya da Gantt'ın aralık etiketi. */
  title: ReactNode;
  /** Sağ küme: görünüm/zaman/yön anahtarları + filtre düğmesi. */
  controls?: ReactNode;
  /** Verilirse "+ Teslimat" düğmesi gösterilir (yetkisi olmayan kullanıcıda hiç çizilmez). */
  onCreateDelivery?: () => void;
}

export default function CalendarHeader({
  sidebar,
  onPrev,
  onNext,
  prevAriaLabel = 'Önceki',
  nextAriaLabel = 'Sonraki',
  title,
  controls,
  onCreateDelivery,
}: CalendarHeaderProps) {
  return (
    <div className="calendar-header">
      <div className="calendar-header-left">
        <div className="calendar-nav-arrows">
          <button type="button" onClick={onPrev} aria-label={prevAriaLabel}>&lt;</button>
          <button type="button" onClick={onNext} aria-label={nextAriaLabel}>&gt;</button>
        </div>
        {/* Sol kümenin İÇ ucu (en sağı): Hiyerarşik Gantt'ta bu düğme yok,
            olmayınca da soldaki ok düğmeleri yerinden oynamaz.

            Etiket SABİT ("Aktif Siparişler"); panelin açık olup olmadığı
            metinle değil RENKLE aktarılır (is-active → dolu/primary, header'ın
            diğer aktif düğmeleriyle aynı dil). Bu yüzden düğme artık boyut
            değiştirmiyor ve eskiden gereken sabit min-width'e de ihtiyaç yok. */}
        {sidebar && (
          <button
            type="button"
            className={`calendar-nav-toggle calendar-header-sidebar-toggle ${sidebar.collapsed ? '' : 'is-active'}`}
            onClick={sidebar.onToggle}
            aria-pressed={!sidebar.collapsed}
            title={sidebar.collapsed ? 'Aktif Siparişler panelini göster' : 'Aktif Siparişler panelini gizle'}
          >
            Aktif Siparişler
          </button>
        )}
      </div>

      <div className="calendar-header-center">
        <h3 className="calendar-header-title">{title}</h3>
      </div>

      <div className="calendar-header-right">
        {controls}
        {onCreateDelivery && (
          <button
            type="button"
            className="btn-success calendar-header-create !py-1.5 !px-4 !text-sm shadow-glow-success"
            onClick={onCreateDelivery}
          >
            <span style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>+</span> Teslimat
          </button>
        )}
      </div>
    </div>
  );
}
