/**
 * "Kullanicinin yazdigi is gunu kesindir" kuralinin sabitlenmesi.
 *
 * Kural (backend date_utils.py _resolve_flat ile BIREBIR ayni olmali):
 *   - Varsayilan HER ZAMAN adet basina hesaptir; "sure modu" diye bir kavram YOK.
 *   - Kullanici bu parcaya bir toplam-gun degeri yazdiysa (_explicit_flat_keys),
 *     o deger kesindir ve adet basina hesabin yerine gecer.
 *   - Adet basina verisi hic yoksa asama dusmez, en az 1 is gunu sayilir.
 *
 * Bu test ozellikle SU HATAYI bir daha olmasin diye var: Adet Basina bir uruniun
 * Dizgi kutusunda 2,5 yaziyorken cizelge 40 is gunu suruyordu (kutu ile cizelge
 * birbirini tutmuyordu).
 */
import { describe, it, expect } from 'vitest';
import { blockDays } from '../scheduleMath';

const EMP = { assembly: 1, production: 1, test: 1 };
const WORK_MINUTES = 480;

/** assembly_days = 2,5 gun/adet; siparis-geneli toplam gun = 2,5. */
const base = {
  assembly_days: 2.5,
  assembly_flat_days: 2.5,
  production_flat_days: 6,
  test_flat_days: 5,
  quality_minutes: 60,
  test1_minutes: 60,
};

const dizgi = (params: any, qty: number) =>
  blockDays('assembly', params, qty, EMP, WORK_MINUTES, false);

describe('toplam-gun alanlari: kullanicinin yazdigi deger kesindir', () => {
  it('Adet Basina + kullanici yazmamis -> adet basina hesaptan (16 x 2,5 = 40)', () => {
    expect(dizgi({ ...base, duration_mode: 'per_unit' }, 16)).toBe(40);
  });

  it('Adet Basina + kullanici 12 yazmis -> 12 (mod gozardi edilir)', () => {
    expect(
      dizgi({ ...base, duration_mode: 'per_unit', assembly_flat_days: 12, _explicit_flat_keys: ['assembly_flat_days'] }, 16),
    ).toBe(12);
  });

  it('Adet Basina + BASKA bir alan yazilmis -> Dizgi yine hesaptan', () => {
    expect(
      dizgi({ ...base, duration_mode: 'per_unit', _explicit_flat_keys: ['production_flat_days'] }, 16),
    ).toBe(40);
  });

  it('eski "Is Gunu" modu artik ETKISIZ -> yine adet basina hesap', () => {
    expect(dizgi({ ...base, duration_mode: 'flat' }, 16)).toBe(40);
  });

  it('Is Gunu modu + kullanici 12 yazmis -> 12', () => {
    expect(
      dizgi({ ...base, duration_mode: 'flat', assembly_flat_days: 12, _explicit_flat_keys: ['assembly_flat_days'] }, 16),
    ).toBe(12);
  });

  it('mod hic ayarlanmamis (null) -> yine adet basina hesap', () => {
    expect(dizgi({ ...base, duration_mode: null }, 16)).toBe(40);
  });

  it('adet basina verisi hic yoksa asama DUSMEZ, en az 1 is gunu', () => {
    expect(blockDays('assembly', {}, 5, EMP, WORK_MINUTES, false)).toBe(1);
    expect(blockDays('production', {}, 5, EMP, WORK_MINUTES, false)).toBe(1);
    expect(blockDays('test', {}, 5, EMP, WORK_MINUTES, false)).toBe(1);
  });

  it('Uretim ve Test icin de ayni kural gecerli', () => {
    const perUnit = { ...base, duration_mode: 'per_unit' as const };
    // yazilmamis: dakika verisinden hesaplanir
    const uretimHesap = blockDays('production', perUnit, 16, EMP, WORK_MINUTES, false);
    const testHesap = blockDays('test', perUnit, 16, EMP, WORK_MINUTES, false);
    expect(uretimHesap).toBe(2); // 60dk x 16 / 480 = 2
    expect(testHesap).toBe(2);
    // yazilmis: yazilan kazanir
    expect(
      blockDays('production', { ...perUnit, production_flat_days: 9, _explicit_flat_keys: ['production_flat_days'] }, 16, EMP, WORK_MINUTES, false),
    ).toBe(9);
    expect(
      blockDays('test', { ...perUnit, test_flat_days: 4, _explicit_flat_keys: ['test_flat_days'] }, 16, EMP, WORK_MINUTES, false),
    ).toBe(4);
  });

  it('bosaltilan alan (0) "yazilmis" sayilmaz -> hesaba geri duser', () => {
    expect(
      dizgi({ ...base, duration_mode: 'per_unit', assembly_flat_days: 0, _explicit_flat_keys: [] }, 16),
    ).toBe(40);
  });
});
