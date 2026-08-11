/**
 * BOM onizleme <-> backend PARITE testi.
 *
 * Duzenleme ekraninda adet degistirildiginde (henuz kaydedilmeden) gosterilen
 * zaman cizelgesi, kaydedince backend'in uretecegi planla AYNI olmali. Ikinci
 * test, ileri yonlu bilesen hesabinin backend calculate_component_end_date ile
 * ayni tarihleri verdigini sabitler — beklenen degerler gercek uc noktadan
 * (POST /gantt/tasks + order-details bulk update) alinmistir.
 */
import { describe, it, expect } from 'vitest';
import { computeComponentBlocksForward, computeSuggestedBlocks, buildHolidayKeySet } from '../scheduleMath';

const P = (o: any) => ({ ...o });
const P1 = P({ supply_days: 0, assembly_days: 2.5, assembly_flat_days: 2.5, delivery_days: 0,
  quality_minutes: 50, epoxy_minutes: 30, conformal_minutes: 30, montaj_minutes: 20, test1_minutes: 120, test2_minutes: 0 });
const P2 = P({ supply_days: 0, assembly_days: 1.5, assembly_flat_days: 1.5, delivery_days: 0,
  quality_minutes: 30, epoxy_minutes: 10, conformal_minutes: 30, montaj_minutes: 15, test1_minutes: 60, test2_minutes: 0 });
const MAIN = P({ supply_days: 1, assembly_days: 12, assembly_flat_days: 1, delivery_days: 1, duration_mode: 'per_unit',
  quality_minutes: 15, epoxy_minutes: 14, conformal_minutes: 20, montaj_minutes: 12, montaj_kalite_minutes: 10,
  test1_minutes: 19, test2_minutes: 30, final_test_minutes: 10 });
const EMP = { assembly: 1, production: 1, test: 1 };
const H = buildHolidayKeySet([]);
const d = (s: string) => new Date(s + 'T00:00:00.000Z');
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('BOM önizleme', () => {
  it('ana adet 20->4 degisince bilesen bitisleri ve ana plan ONIZLEMEDE guncellenir', () => {
    const start = d('2026-11-02'), end = d('2026-12-15');
    // --- Kaydedilmemis adet degisikligi: 20 -> 4  (oran 0.2)
    const before = [P1, P2].map(p => computeComponentBlocksForward(start, 20, p, EMP, 480, H));
    const after  = [P1, P2].map(p => computeComponentBlocksForward(start, 4,  p, EMP, 480, H));
    const readyBefore = new Date(Math.max(...before.map(b => b.test!.end.getTime())));
    const readyAfter  = new Date(Math.max(...after.map(b => b.test!.end.getTime())));
    // Bilesen bitisleri GERCEKTEN degismeli (eskiden degismiyordu)
    expect(iso(readyAfter)).not.toBe(iso(readyBefore));
    expect(readyAfter.getTime()).toBeLessThan(readyBefore.getTime());

    // --- Ana urunun onizlemesi yeni ready'ye gore konumlanmali
    const mainBefore = computeSuggestedBlocks(end, 20, MAIN, EMP, 480, H, false, readyBefore, start, true);
    const mainAfter  = computeSuggestedBlocks(end, 4,  MAIN, EMP, 480, H, false, readyAfter,  start, true);
    expect(iso(mainBefore.supply!.end)).toBe(iso(readyBefore));
    expect(iso(mainAfter.supply!.end)).toBe(iso(readyAfter));
    // Adet 4'e dusunce bilesenler istenen teslim tarihine SIGAR -> bitis sabit kalir.
    // Adet 20'de bilesenler 2027-01-27'ye kadar surer, yani istenen 2026-12-15'e
    // sigmaz -> plan ileri kayar. Beklenen degerler backend'den alindi
    // (calculate_split_stage_ranges, ayni girdilerle).
    expect(iso(mainAfter.delivery!.end)).toBe('2026-12-15');
    expect(iso(mainBefore.delivery!.end)).toBe('2027-02-05');
  });

  it('ileri yonlu bilesen hesabi backend calculate_component_end_date ile ayni sonucu verir', () => {
    // Backend ciktisi (calculate_component_end_date, adet=20, start=2026-11-02):
    // P1 -> 2027-01-27, P2 -> 2026-12-24. Sure modu kaldirilip her sey adet basina
    // hesaplanmaya baslayinca bu tarihler uzadi; degerler backend'den yeniden alindi.
    const b1 = computeComponentBlocksForward(d('2026-11-02'), 20, P1, EMP, 480, H);
    const b2 = computeComponentBlocksForward(d('2026-11-02'), 20, P2, EMP, 480, H);
    expect(iso(b1.test!.end)).toBe('2027-01-27');
    expect(iso(b2.test!.end)).toBe('2026-12-24');
  });
});
