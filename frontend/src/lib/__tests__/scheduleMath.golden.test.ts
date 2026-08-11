/**
 * BACKEND PARİTE TESTİ — scheduleMath.ts, date_utils.py ile aynı sonucu veriyor mu?
 *
 * NEDEN BU TEST VAR
 * -----------------
 * `scheduleMath.ts`, backend `app/core/date_utils.py`'nin elle yazılmış bir
 * TypeScript port'udur. Bu duplikasyon KALDIRILAMAZ: kullanıcı formda tarih/adet
 * değiştirirken anlık önizleme görmeli, her tuş vuruşunda backend'e gidilemez.
 *
 * Kaldırılamayan bir duplikasyonun tek savunması, iki tarafın SESSİZCE
 * sapmamasıdır. scheduleMath.ts içindeki 12 ayrı "backend ile birebir aynı
 * olmalı" yorumu ve `pythonRound` yardımcısı (Python'un bankacı yuvarlamasını
 * taklit eder), bu sapmanın geçmişte defalarca yaşandığını gösteriyor —
 * deliveryPlanMath.ts:4-8'de anlatılan "BOM'lu ürünlerde haftalarca boşluk"
 * bug'ı bunlardan biri.
 *
 * NASIL ÇALIŞIR
 * -------------
 * `blockDays.golden.json` backend tarafından üretilir
 * (backend/tests/generate_frontend_golden.py). Bu test aynı girdiler için
 * frontend `blockDays()` sonucunu üretip karşılaştırır.
 *
 * KIRMIZIYA DÖNERSE
 * -----------------
 * - JSON dosyası DEĞİŞMEDİYSE: scheduleMath.ts backend'den sapmış -> gerçek bug.
 * - JSON yeni üretildiyse: backend kuralı bilinçli değişmiş, scheduleMath.ts de
 *   aynı şekilde güncellenmeli. Kırmızı test tam olarak bunu hatırlatmak için var.
 */

import { describe, expect, it } from 'vitest';
import { blockDays, type BlockKey, type EmployeeCounts, type ScheduleParams } from '../scheduleMath';
import golden from './blockDays.golden.json';

interface GoldenCase {
  params: Record<string, unknown>;
  qty: number;
  emp: EmployeeCounts;
  workMinutes: number;
  isOutsourced: boolean;
  expected: Record<string, number | null>;
}

const cases = golden.cases as GoldenCase[];
const BLOCKS: BlockKey[] = ['supply', 'assembly', 'production', 'test', 'delivery'];

/** Girdiyi test adında okunur kılar (hangi senaryonun kırıldığını görebilmek için). */
const describeCase = (c: GoldenCase, i: number) => {
  const keys = Object.keys(c.params);
  const paramLabel = keys.length ? keys.join('+') : 'bos';
  const empLabel = `${c.emp.assembly}/${c.emp.production}/${c.emp.test}`;
  return `#${i} ${paramLabel} | qty=${c.qty} | isci=${empLabel} | ${c.isOutsourced ? 'fason' : 'ic'}`;
};

describe('scheduleMath.blockDays — backend date_utils._block_days paritesi', () => {
  it('altin deger dosyasi bos degil', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  cases.forEach((c, i) => {
    it(describeCase(c, i), () => {
      const actual: Record<string, number | null> = {};
      BLOCKS.forEach((key) => {
        actual[key] = blockDays(
          key,
          c.params as ScheduleParams,
          c.qty,
          c.emp,
          c.workMinutes,
          c.isOutsourced,
        );
      });
      expect(actual).toEqual(c.expected);
    });
  });
});
