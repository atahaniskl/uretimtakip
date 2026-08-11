/**
 * Paylaşılan tarih / iş günü yardımcıları — TEK KAYNAK.
 *
 * NEDEN BU DOSYA VAR
 * ------------------
 * Bu fonksiyonlar daha önce 5 ayrı yerde (RightPanel, StageView,
 * DeliveryCalendarPage, useActiveOrders, deliveryPlanMath) birbirinden bağımsız
 * olarak tanımlanmıştı. Hepsi "aynı" olduğu sürece sorun görünmüyordu — ta ki
 * bir düzeltme yalnızca bir kopyaya uygulanana kadar:
 *
 *   `addBusinessDays` içindeki MAX_SAFE_WORKDAYS sınırı, tarayıcının donmasını
 *   önlemek için eklenmişti (canlı test: sipariş adedine 100000 yazılınca sekme
 *   kilitleniyordu). Düzeltme yalnızca deliveryPlanMath.ts'e uygulandı;
 *   StageView.tsx ve DeliveryCalendarPage.tsx kopyaları korumasız kaldı ve o iki
 *   ekranda donma riski aylarca açık kaldı.
 *
 * Bu dosya o sınıf hataları imkânsız kılar: düzeltme bir kez yapılır, her yer
 * aynı anda düzelir.
 */

/** Bir tarihi 'YYYY-MM-DD' anahtarına çevirir (YEREL saat dilimine göre).
 *  DİKKAT: toISOString() KULLANILMAZ — o UTC'ye çevirir ve TR saatinde gece
 *  yarısına yakın tarihlerde günü bir gün geriye kaydırır. */
export const dateKey = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** <input type="date"> değeri için biçim — dateKey ile aynı ('YYYY-MM-DD').
 *  Ayrı bir isim olarak tutulur çünkü çağrı yerlerinde niyeti belli eder. */
export const toDateInput = dateKey;

/** Saat/dakika/saniyeyi sıfırlanmış bir KOPYA döndürür (girdi değiştirilmez). */
export const startOfDay = (date: Date): Date => {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
};

export const isWeekend = (day: Date): boolean => {
  const weekDay = day.getDay();
  return weekDay === 0 || weekDay === 6;
};

/** Hafta içi VE resmi tatil olmayan gün. `holidayKeys` dateKey biçiminde olmalı. */
export const isWorkday = (day: Date, holidayKeys: Set<string>): boolean =>
  !isWeekend(day) && !holidayKeys.has(dateKey(day));

/** Tatil listesini dateKey kümesine çevirir (yalnızca aktif olanlar). */
export const buildHolidayKeySet = (
  items: { holiday_date: string; is_active: boolean }[],
): Set<string> => new Set(items.filter((h) => h.is_active).map((h) => h.holiday_date.slice(0, 10)));

/**
 * Gün-gün ilerleyen döngüler için üst sınır (~80 yıl).
 *
 * `workdays` değeri kullanıcı girdisinden türeyen bir hesabın sonucu olabilir
 * (ör. adet × gün/adet). Sipariş adedine yanlışlıkla 100000 yazılırsa Dizgi
 * süresi tek başına 250.000+ iş günü çıkar; sınırsız bir döngü sekmeyi kilitler.
 * Bu sınır sonucun anlamlı olmasını sağlamaz — yalnızca arayüzün yanıt vermeye
 * devam etmesini garanti eder.
 */
export const MAX_SAFE_WORKDAYS = 20000;

/** `start`'tan itibaren `workdays` iş günü ileri; dönen değer o sürenin BİTİŞİDİR
 *  (exclusive). En az 1 gün, en fazla MAX_SAFE_WORKDAYS işlenir. */
export const addBusinessDays = (start: Date, workdays: number, holidayKeys: Set<string>): Date => {
  let remaining = Math.min(MAX_SAFE_WORKDAYS, Math.max(1, workdays));
  const cursor = startOfDay(start);

  while (remaining > 0) {
    if (isWorkday(cursor, holidayKeys)) {
      remaining -= 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return cursor;
};

/** [start, endExclusive) aralığındaki iş günü sayısı.
 *  Kullanıcı çok uzak bir yıl girdiğinde (ör. 2126) döngünün sonsuza yakın
 *  sürmemesi için iterasyon sınırı vardır. */
export const countWorkdaysInRange = (
  start: Date,
  endExclusive: Date,
  holidayKeys: Set<string>,
): number => {
  let count = 0;
  let iterations = 0;
  const cursor = startOfDay(start);
  const end = startOfDay(endExclusive);

  while (cursor < end && iterations < MAX_SAFE_WORKDAYS * 2) {
    if (isWorkday(cursor, holidayKeys)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
    iterations += 1;
  }

  return count;
};
