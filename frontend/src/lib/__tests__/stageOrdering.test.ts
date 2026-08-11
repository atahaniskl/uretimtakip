/**
 * Adim SIRALAMASI regresyon testi.
 *
 * Bildirilen hata: duzenleme ekraninda adet 10 -> 20 yapilinca Dizgi uzuyor ama
 * Uretim/Test/Teslimat onun bitisini beklemeden basliyordu (adimlar ust uste
 * biniyordu). Sebep, sistem onerisi uygulandiktan SONRAKI degisikliklerin
 * "kismi ayarlama" yoluna dusmesiydi; o yol her blogun baslangicini sabit tutup
 * bitisini uzatiyor ve komsu bloklari yeniden zincirlemiyor.
 *
 * Asagidaki test, sistem onerisinin (computeSuggestedBlocks) adet ne olursa olsun
 * HER ZAMAN gecerli sirali bir plan urettigini sabitler — duzeltme bu yolun
 * kullanilmaya devam etmesini sagliyor.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSuggestedBlocks,
  findStageSequenceViolations,
  buildHolidayKeySet,
  type BlockKey,
} from '../scheduleMath';

const EMP = { assembly: 1, production: 1, test: 1 };
const H = buildHolidayKeySet([]);
const end = new Date('2026-12-15T00:00:00.000Z');
const start = new Date('2026-10-01T00:00:00.000Z');

// Dizgi'nin adetle ciddi sekilde uzadigi bir urun (per_unit).
const PARAMS = {
  supply_days: 2, assembly_days: 1.5, delivery_days: 1, duration_mode: 'per_unit' as const,
  quality_minutes: 15, epoxy_minutes: 14, conformal_minutes: 20, montaj_minutes: 12,
  montaj_kalite_minutes: 10, test1_minutes: 19, test2_minutes: 30, final_test_minutes: 10,
};

const toBlocks = (qty: number) => {
  const spans = computeSuggestedBlocks(end, qty, PARAMS, EMP, 480, H, false, null, start, true);
  return (['supply', 'assembly', 'production', 'test', 'delivery'] as BlockKey[])
    .filter((k) => spans[k])
    .map((k) => ({ key: k, label: k, start: spans[k]!.start.toISOString(), end: spans[k]!.end.toISOString() }));
};

describe('sistem onerisi adim siralamasi', () => {
  it.each([1, 5, 10, 20, 50, 200])('adet=%i icin sira ihlali uretmez', (qty) => {
    expect(findStageSequenceViolations(toBlocks(qty))).toEqual([]);
  });

  it('adet artinca Dizgi uzar ama Uretim yine de Dizgi bittikten SONRA baslar', () => {
    const b10 = toBlocks(10);
    const b20 = toBlocks(20);
    const asmDays = (bs: ReturnType<typeof toBlocks>) => {
      const a = bs.find((x) => x.key === 'assembly')!;
      return new Date(a.end).getTime() - new Date(a.start).getTime();
    };
    expect(asmDays(b20)).toBeGreaterThan(asmDays(b10));
    const asm = b20.find((x) => x.key === 'assembly')!;
    const prod = b20.find((x) => x.key === 'production')!;
    expect(new Date(prod.start).getTime()).toBeGreaterThanOrEqual(new Date(asm.end).getTime());
  });
});
