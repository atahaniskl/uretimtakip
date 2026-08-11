/**
 * lib/dateUtils.ts birim testleri.
 *
 * Bu modül Faz 2.2'de 5 ayrı dosyadaki kopyaları birleştirmek için oluşturuldu.
 * Testlerin asıl işi, birleştirmenin davranışı DEĞİŞTİRMEDİĞİNİ ve düzeltilen
 * bug'ın (MAX_SAFE_WORKDAYS) artık her çağıran için geçerli olduğunu kilitlemek.
 *
 * Tarih referansları (tatil kümesi boş — sadece hafta sonu mantığı devrede):
 *   2026-07-24 Cum | 07-25 Cmt | 07-26 Paz | 07-27 Pzt
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SAFE_WORKDAYS,
  addBusinessDays,
  buildHolidayKeySet,
  countWorkdaysInRange,
  dateKey,
  isWeekend,
  isWorkday,
  startOfDay,
  toDateInput,
} from '../dateUtils';

const NO_HOLIDAYS = new Set<string>();
const d = (iso: string) => new Date(`${iso}T00:00:00`);

describe('dateKey', () => {
  it('YYYY-MM-DD biçiminde döndürür', () => {
    expect(dateKey(d('2026-07-24'))).toBe('2026-07-24');
  });

  it('tek haneli ay ve günü sıfırla doldurur', () => {
    expect(dateKey(d('2026-01-05'))).toBe('2026-01-05');
  });

  it('YEREL saat dilimini kullanır — gece yarısına yakın saatlerde gün kaymaz', () => {
    // toISOString() kullanılsaydı TR (UTC+3) saatinde 00:30 -> bir önceki güne
    // kayardı. Bu, takvim hücrelerinin yanlış güne düşmesi demekti.
    const geceYarisiSonrasi = new Date(2026, 6, 24, 0, 30, 0);
    expect(dateKey(geceYarisiSonrasi)).toBe('2026-07-24');
  });

  it('toDateInput ile aynı sonucu verir (aynı fonksiyon)', () => {
    const ornek = d('2026-03-09');
    expect(toDateInput(ornek)).toBe(dateKey(ornek));
  });
});

describe('startOfDay', () => {
  it('saat/dakika/saniyeyi sıfırlar', () => {
    const sonuc = startOfDay(new Date(2026, 6, 24, 15, 42, 30, 500));
    expect(sonuc.getHours()).toBe(0);
    expect(sonuc.getMinutes()).toBe(0);
    expect(sonuc.getSeconds()).toBe(0);
    expect(sonuc.getMilliseconds()).toBe(0);
  });

  it('GİRDİYİ DEĞİŞTİRMEZ — kopya döndürür', () => {
    // Çağıranların çoğu bu sonucu döngü imleci olarak kullanıp setDate ile
    // ilerletiyor; girdi mutasyona uğrasaydı çağıranın kendi tarihi bozulurdu.
    const girdi = new Date(2026, 6, 24, 15, 42);
    const sonuc = startOfDay(girdi);
    sonuc.setDate(sonuc.getDate() + 10);
    expect(girdi.getDate()).toBe(24);
    expect(girdi.getHours()).toBe(15);
  });
});

describe('isWeekend / isWorkday', () => {
  it('cumartesi ve pazar hafta sonudur', () => {
    expect(isWeekend(d('2026-07-25'))).toBe(true);
    expect(isWeekend(d('2026-07-26'))).toBe(true);
  });

  it('hafta içi hafta sonu değildir', () => {
    expect(isWeekend(d('2026-07-24'))).toBe(false);
    expect(isWeekend(d('2026-07-27'))).toBe(false);
  });

  it('hafta sonu iş günü değildir', () => {
    expect(isWorkday(d('2026-07-25'), NO_HOLIDAYS)).toBe(false);
  });

  it('resmi tatil iş günü değildir', () => {
    expect(isWorkday(d('2026-07-27'), new Set(['2026-07-27']))).toBe(false);
  });

  it('hafta içi + tatil değilse iş günüdür', () => {
    expect(isWorkday(d('2026-07-27'), NO_HOLIDAYS)).toBe(true);
  });
});

describe('buildHolidayKeySet', () => {
  it('yalnızca aktif tatilleri alır', () => {
    const kume = buildHolidayKeySet([
      { holiday_date: '2026-07-27', is_active: true },
      { holiday_date: '2026-07-28', is_active: false },
    ]);
    expect(kume.has('2026-07-27')).toBe(true);
    expect(kume.has('2026-07-28')).toBe(false);
  });

  it('ISO datetime değerlerini gün anahtarına kırpar', () => {
    const kume = buildHolidayKeySet([{ holiday_date: '2026-07-27T00:00:00Z', is_active: true }]);
    expect(kume.has('2026-07-27')).toBe(true);
  });
});

describe('addBusinessDays', () => {
  it('hafta sonunu atlar', () => {
    // Cuma'dan 2 iş günü: Cuma + Pazartesi -> Salı
    expect(dateKey(addBusinessDays(d('2026-07-24'), 2, NO_HOLIDAYS))).toBe('2026-07-28');
  });

  it('tatili atlar', () => {
    const tatil = new Set(['2026-07-27']); // Pazartesi
    expect(dateKey(addBusinessDays(d('2026-07-24'), 2, tatil))).toBe('2026-07-29');
  });

  it('en az 1 iş günü işler (0 veya negatif verilse bile)', () => {
    expect(dateKey(addBusinessDays(d('2026-07-24'), 0, NO_HOLIDAYS))).toBe('2026-07-25');
    expect(dateKey(addBusinessDays(d('2026-07-24'), -5, NO_HOLIDAYS))).toBe('2026-07-25');
  });

  it('DÜZELTİLEN BUG: devasa girdide donmaz, MAX_SAFE_WORKDAYS ile sınırlanır', () => {
    // Sipariş adedine 100000 yazıldığında Dizgi süresi 250.000+ iş günü çıkıyor
    // ve sınırsız döngü sekmeyi kilitliyordu. Bu koruma önce yalnızca
    // deliveryPlanMath.ts'e uygulanmış, StageView/DeliveryCalendarPage
    // kopyalarına yayılmamıştı — birleştirmenin asıl kazancı bu.
    const basla = Date.now();
    const sonuc = addBusinessDays(d('2026-07-24'), 10_000_000, NO_HOLIDAYS);
    const sure = Date.now() - basla;

    expect(sonuc).toBeInstanceOf(Date);
    expect(sure).toBeLessThan(5000); // sınır olmasaydı pratikte hiç bitmezdi
    // Sonuç, MAX_SAFE_WORKDAYS iş gününü aşmayan bir tarihte olmalı
    const gecenGun = (sonuc.getTime() - d('2026-07-24').getTime()) / 86400000;
    expect(gecenGun).toBeLessThanOrEqual(MAX_SAFE_WORKDAYS * 2);
  });
});

describe('countWorkdaysInRange', () => {
  it('[start, end) aralığını sayar — bitiş HARİÇ', () => {
    // Pzt-Cum arası 5 iş günü; 2026-08-03 Pzt, 2026-08-08 Cmt
    expect(countWorkdaysInRange(d('2026-08-03'), d('2026-08-08'), NO_HOLIDAYS)).toBe(5);
  });

  it('hafta sonlarını saymaz', () => {
    // Cuma -> Salı: Cuma + Pazartesi = 2 (Cmt/Paz hariç)
    expect(countWorkdaysInRange(d('2026-07-24'), d('2026-07-28'), NO_HOLIDAYS)).toBe(2);
  });

  it('tatilleri saymaz', () => {
    const tatil = new Set(['2026-08-04']);
    expect(countWorkdaysInRange(d('2026-08-03'), d('2026-08-08'), tatil)).toBe(4);
  });

  it('start >= end ise 0 döndürür', () => {
    expect(countWorkdaysInRange(d('2026-08-05'), d('2026-08-05'), NO_HOLIDAYS)).toBe(0);
    expect(countWorkdaysInRange(d('2026-08-06'), d('2026-08-05'), NO_HOLIDAYS)).toBe(0);
  });

  it('çok uzak bir bitiş tarihinde donmaz (iterasyon sınırı)', () => {
    const basla = Date.now();
    countWorkdaysInRange(d('2026-01-01'), d('2999-01-01'), NO_HOLIDAYS);
    expect(Date.now() - basla).toBeLessThan(5000);
  });
});
