/**
 * lib/stageLabels.ts birim testleri.
 *
 * Faz 2.3'te 4 kopya STAGE_LABELS ve 2 farklı getTaskStageLabel birleştirildi.
 * Kritik nokta: iki kopyanın DAVRANIŞI FARKLIYDI —
 *   • StageView fason parçaların Dizgi'sini "Fason (Dış Dizgi)" gösteriyordu,
 *     DeliveryCalendarPage düz "Dizgi" gösteriyordu (backend ayrımı yapmasına rağmen).
 *   • Fallback farklıydı: StageView '' döner, DeliveryCalendarPage 'Teslimat'.
 * İlki bir hataydı ve düzeltildi; ikincisi bilinçli bir farktı ve parametreyle korundu.
 */

import { describe, expect, it } from 'vitest';
import {
  OUTSOURCED_ASSEMBLY_LABEL,
  STAGE_LABELS,
  STAGE_ORDER,
  getStageLabel,
  getTaskStageLabel,
} from '../stageLabels';

describe('STAGE_LABELS / STAGE_ORDER', () => {
  it('backend BLOCK_KEYS ile aynı beş aşama', () => {
    expect(Object.keys(STAGE_LABELS)).toEqual(['supply', 'assembly', 'production', 'test', 'delivery']);
  });

  it('kanonik sıra backend date_utils.BLOCK_KEYS ile birebir', () => {
    expect([...STAGE_ORDER]).toEqual(['supply', 'assembly', 'production', 'test', 'delivery']);
  });

  it('etiketler Türkçe', () => {
    expect(STAGE_LABELS.supply).toBe('Tedarik');
    expect(STAGE_LABELS.assembly).toBe('Dizgi');
    expect(STAGE_LABELS.delivery).toBe('Teslimat');
  });
});

describe('getStageLabel', () => {
  it('bilinen anahtarı etikete çevirir', () => {
    expect(getStageLabel('production')).toBe('Üretim');
  });

  it('büyük/küçük harf ve boşluğa toleranslı', () => {
    expect(getStageLabel('  TEST  ')).toBe('Test');
  });

  it('bilinmeyen anahtarı olduğu gibi döndürür (veri kaybolmaz)', () => {
    expect(getStageLabel('bilinmeyen_asama')).toBe('bilinmeyen_asama');
  });

  it('boş anahtar boş string', () => {
    expect(getStageLabel('')).toBe('');
  });

  it('DÜZELTİLEN BUG: fason parçada Dizgi ayrı etiketlenir', () => {
    expect(getStageLabel('assembly', true)).toBe(OUTSOURCED_ASSEMBLY_LABEL);
    expect(getStageLabel('assembly', false)).toBe('Dizgi');
  });

  it('fason bayrağı yalnızca Dizgi adımını etkiler', () => {
    expect(getStageLabel('production', true)).toBe('Üretim');
    expect(getStageLabel('test', true)).toBe('Test');
    expect(getStageLabel('supply', true)).toBe('Tedarik');
  });
});

describe('getTaskStageLabel', () => {
  it('stage alanı varsa ondan türetir', () => {
    expect(getTaskStageLabel({ stage: 'supply' })).toBe('Tedarik');
  });

  it('her iki fason alan adını da tanır (isOutsourced / is_outsourced)', () => {
    // Ekranlar arasında alan adı tutarsızlığı vardı; ikisi de desteklenir.
    expect(getTaskStageLabel({ stage: 'assembly', isOutsourced: true })).toBe(OUTSOURCED_ASSEMBLY_LABEL);
    expect(getTaskStageLabel({ stage: 'assembly', is_outsourced: true })).toBe(OUTSOURCED_ASSEMBLY_LABEL);
  });

  it('fason alanı null ise fason DEĞİL sayılır', () => {
    // Backend "bilgi yok" anlamında null gönderebiliyor.
    expect(getTaskStageLabel({ stage: 'assembly', isOutsourced: null })).toBe('Dizgi');
  });

  it('stage yoksa görev metninin başındaki aşama adından çıkarır', () => {
    expect(getTaskStageLabel({ text: 'Tedarik — 5 adet' })).toBe('Tedarik');
    expect(getTaskStageLabel({ text: 'Üretim — 12 adet' })).toBe('Üretim');
  });

  it('"Otomatik Teslimat" metnini "Teslimat"a indirger', () => {
    expect(getTaskStageLabel({ text: 'Otomatik Teslimat' })).toBe('Teslimat');
  });

  it('KORUNAN FARK: fallbackForTask kapalıyken boş döner (StageView davranışı)', () => {
    expect(getTaskStageLabel({ text: 'Rastgele bir metin', type: 'task' })).toBe('');
  });

  it('KORUNAN FARK: fallbackForTask açıkken görevler "Teslimat" sayılır (Takvim davranışı)', () => {
    expect(getTaskStageLabel({ text: 'Rastgele bir metin', type: 'task' }, true)).toBe('Teslimat');
  });

  it('fallbackForTask açık olsa bile "task" olmayanlar boş kalır', () => {
    expect(getTaskStageLabel({ text: 'Rastgele', type: 'summary' }, true)).toBe('');
  });

  it('boş görevde patlamaz', () => {
    expect(getTaskStageLabel({})).toBe('');
    expect(getTaskStageLabel({ stage: null, text: null, type: null })).toBe('');
  });

  it('stage alanı metinden ÖNCELİKLİDİR', () => {
    expect(getTaskStageLabel({ stage: 'test', text: 'Tedarik — 5 adet' })).toBe('Test');
  });
});
