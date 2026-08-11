/**
 * lib/durationMode.ts birim testleri.
 *
 * Bu modül Faz 2.7'de, "duration_mode NULL ise İş Günü" kuralının 7 ayrı yere
 * elle yazılmış olmasını gidermek için oluşturuldu. Testlerin işi, kuralın
 * motorla (scheduleMath.ts blockDays / date_utils.py _block_days) aynı kalmasını
 * ve ANT-826C sınıfı bir sapmanın sessizce geri gelmemesini garanti etmek.
 */

import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_MINUTE_FIELDS,
  PRODUCTION_MINUTE_KEYS,
  TEST_MINUTE_FIELDS,
  TEST_MINUTE_KEYS,
  computePerUnitGaps,
  isFilledDuration,
  isFlatMode,
  resolveDurationMode,
} from '../durationMode';
import { blockDays } from '../scheduleMath';

describe('resolveDurationMode', () => {
  it('açıkça per_unit yazılmışsa Adet Başına', () => {
    expect(resolveDurationMode('per_unit')).toBe('per_unit');
  });

  it.each([null, undefined, '', 'flat', 'FLAT', 'bilinmeyen'])(
    'diğer her değer İş Günü (flat) kabul edilir: %s',
    (girdi) => {
      expect(resolveDurationMode(girdi as string | null | undefined)).toBe('flat');
    },
  );

  it('ANT-826C: NULL mod "per_unit" DEĞİLDİR', () => {
    // Ürün Bilgisi ekranı NULL'ı per_unit varsayıyordu; motor flat işliyordu.
    // 13 adetlik siparişte Dizgi 26 gün yerine 2 gün hesaplandı.
    expect(resolveDurationMode(null)).not.toBe('per_unit');
  });
});

describe('isFlatMode — motorla aynı kural', () => {
  it.each([null, undefined, '', 'flat'])('%s -> flat', (girdi) => {
    expect(isFlatMode(girdi as string | null | undefined)).toBe(true);
  });

  it('per_unit -> flat değil', () => {
    expect(isFlatMode('per_unit')).toBe(false);
  });

  it('blockDays ARTIK moda bakmaz: her modda adet basina hesaplanir', () => {
    // Sure modu kaldirildi (bkz. date_utils._block_days). isFlatMode helper'i hala
    // ProductInfo formunun eski alanlarini okurken kullaniliyor, ama ZAMANLAMAYA
    // etkisi yok — bu test tam olarak o kopusu sabitler.
    const emp = { assembly: 1, production: 1, test: 1 };
    const params = { assembly_days: 2, assembly_flat_days: 5 };

    for (const mod of [null, undefined, '', 'flat', 'per_unit'] as const) {
      // 2 gun/adet x 10 adet = 20 — mod ne olursa olsun
      expect(blockDays('assembly', { ...params, duration_mode: mod as never }, 10, emp, 480, false)).toBe(20);
    }
  });
});

describe('isFilledDuration', () => {
  it.each([1, '1', '2.5', '2,5', 0.5, '  3  '])('dolu sayar: %s', (deger) => {
    expect(isFilledDuration(deger)).toBe(true);
  });

  it.each([null, undefined, '', '0', 0, '-1', -5, 'abc', '  '])('boş sayar: %s', (deger) => {
    expect(isFilledDuration(deger)).toBe(false);
  });

  it('virgüllü ondalığı kabul eder (TR klavye girdisi)', () => {
    expect(isFilledDuration('1,5')).toBe(true);
  });

  it('parseFloat DEĞİL Number kullanır — motorla tutarlı', () => {
    // parseFloat("12abc") === 12 olurdu ve alan "dolu" sayılırdı; oysa motor
    // (scheduleMath num/toNum) aynı değeri NaN görüp aşamayı hiç hesaplamaz.
    // Kullanıcıya "veri var" deyip öneri üretememek tam bu farktan doğuyordu.
    expect(isFilledDuration('12abc')).toBe(false);
  });
});

describe('dakika alan listeleri', () => {
  it('üretim alanları motorun topladığı kümeyle aynı', () => {
    expect(PRODUCTION_MINUTE_KEYS).toEqual([
      'quality_minutes',
      'epoxy_minutes',
      'conformal_minutes',
      'montaj_minutes',
      'montaj_kalite_minutes',
    ]);
  });

  it('test alanları motorun topladığı kümeyle aynı', () => {
    expect(TEST_MINUTE_KEYS).toEqual(['test1_minutes', 'test2_minutes', 'final_test_minutes']);
  });

  it('iki küme kesişmez — bir alan iki aşamaya birden sayılmaz', () => {
    const kesisim = PRODUCTION_MINUTE_KEYS.filter((k) => (TEST_MINUTE_KEYS as readonly string[]).includes(k));
    expect(kesisim).toEqual([]);
  });

  it('her alanın bir ekran etiketi var', () => {
    [...PRODUCTION_MINUTE_FIELDS, ...TEST_MINUTE_FIELDS].forEach(([key, label]) => {
      expect(key).toBeTruthy();
      expect(label).toBeTruthy();
    });
  });

  it('blockDays üretim toplamı bu alanlardan beslenir', () => {
    const emp = { assembly: 1, production: 1, test: 1 };
    // Her üretim alanına 96 dk: 5 × 96 = 480 dk = 1 gün (1 adet, 1 işçi)
    const params = Object.fromEntries(PRODUCTION_MINUTE_KEYS.map((k) => [k, 96]));
    expect(blockDays('production', { ...params, duration_mode: 'per_unit' }, 1, emp, 480, false)).toBe(1);
  });
});

describe('computePerUnitGaps', () => {
  const TAM_VERI = {
    assembly_days: 2,
    quality_minutes: 30,
    test1_minutes: 45,
  };

  it('tüm aşamalarda veri varsa boş liste', () => {
    expect(computePerUnitGaps(TAM_VERI)).toEqual([]);
  });

  it('hiç veri yoksa üç aşamayı da bildirir', () => {
    expect(computePerUnitGaps({})).toEqual(['Dizgi', 'Üretim', 'Test']);
  });

  it('Dizgi için production_days da kabul edilir (motorun baktığı sıra)', () => {
    // blockDays: num(production_days) || num(assembly_days)
    expect(computePerUnitGaps({ ...TAM_VERI, assembly_days: undefined, production_days: 3 })).toEqual([]);
  });

  it('Üretim aşamasında TEK bir dakika alanı yeterli', () => {
    expect(computePerUnitGaps({ assembly_days: 1, montaj_minutes: 10, test1_minutes: 5 })).toEqual([]);
  });

  it('Test aşamasında TEK bir dakika alanı yeterli', () => {
    expect(computePerUnitGaps({ assembly_days: 1, quality_minutes: 10, final_test_minutes: 5 })).toEqual([]);
  });

  it('sıfır değerler "dolu" sayılmaz', () => {
    expect(computePerUnitGaps({ assembly_days: 0, quality_minutes: 0, test1_minutes: 0 })).toEqual([
      'Dizgi',
      'Üretim',
      'Test',
    ]);
  });

  it('form state (string değerler) ile de çalışır', () => {
    // ProductInfoPage/CreateDeliveryModal form state'i string tutar.
    expect(computePerUnitGaps({ assembly_days: '2', quality_minutes: '30', test1_minutes: '45' })).toEqual([]);
    expect(computePerUnitGaps({ assembly_days: '', quality_minutes: '', test1_minutes: '' })).toEqual([
      'Dizgi',
      'Üretim',
      'Test',
    ]);
  });

  it('eksik aşamaları kanonik sırayla bildirir', () => {
    expect(computePerUnitGaps({ quality_minutes: 30 })).toEqual(['Dizgi', 'Test']);
  });
});
