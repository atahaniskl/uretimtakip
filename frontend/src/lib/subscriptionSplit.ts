import { dateKey as toDateInputLocal } from './dateUtils';
// "Abonelik / Aylık Otomatik Böl" — bir toplam adedi N aya bölüp her ay için
// bir teslimat parçası (quantity + endDate) üreten paylaşılan mantık.
// OrderDetailModal.tsx (var olan bir siparişi bölme) ve CreateDeliveryModal.tsx
// (yeni sipariş oluştururken baştan bölme) AYNI hesabı kullanır — iki ayrı
// kopya zamanla birbirinden sapmasın diye tek kaynakta tutulur.

export interface GeneratedSegment {
  quantity: string;
  endDate: string;
  is_outsourced: boolean;
  outsource_days: string;
}



// "31" gibi her ayda olmayan bir gün seçilirse (Şubat, Nisan, vb.) o ayın son
// gününe kırpar — takvimde olmayan bir tarih üretmemek için.
export const addMonthsClamped = (yearMonth: string, offset: number, day: number): string => {
  const [y, m] = yearMonth.split('-').map(Number);
  const totalMonths = (m - 1) + offset;
  const targetYear = y + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const lastDayOfMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  return toDateInputLocal(new Date(targetYear, targetMonth, Math.min(Math.max(1, day), lastDayOfMonth)));
};

export const computeMonthsFromMonthly = (total: number, monthly: number): number | null => {
  if (!(total > 0) || !(monthly > 0)) return null;
  return Math.max(1, Math.ceil(total / monthly));
};

export const computeMonthlyFromMonths = (total: number, months: number): number | null => {
  if (!(total > 0) || !(months > 0)) return null;
  return Math.round(total / months);
};

// Toplamı `months` parçaya böler — ilk (months-1) parça eşit (taban), SON
// parça kalanı alır (tam toplam garantisi, "basit" olması için karmaşık bir
// dağıtım algoritması yerine).
export const generateSubscriptionSegments = (
  total: number,
  months: number,
  startMonth: string,
  day: number,
): GeneratedSegment[] => {
  const perMonth = Math.floor(total / months);
  return Array.from({ length: months }, (_, i) => {
    const isLast = i === months - 1;
    const quantity = isLast ? total - perMonth * (months - 1) : perMonth;
    return {
      quantity: String(quantity),
      endDate: addMonthsClamped(startMonth, i, day),
      is_outsourced: false,
      outsource_days: '',
    };
  });
};
