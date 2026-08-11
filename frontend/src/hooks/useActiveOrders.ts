import { useMemo } from 'react';

import { startOfDay } from '../lib/dateUtils';

export interface ActiveOrderItem {
  id: string;
  orderNo: string;
  productType: string;
  customerName: string;
  quantity: number | null;
  start: Date;
  end: Date;
  deliveryDate: Date;
  chipLabel: string;
  calendarLabel: string;
  text: string;
  depth: number;
  isSplitChild: boolean;
  isOrderGroupChild?: boolean;
  isOrderGroupHead?: boolean;
  orderGroupSize?: number;
}

const findSummary = (summariesById: Map<string, any>, parentKey: string) => {
  let s = summariesById.get(parentKey);
  if (!s && parentKey.startsWith('order_')) {
    s = summariesById.get(parentKey.slice('order_'.length));
  }
  return s;
};

export function useActiveOrders(tasks: any[]): ActiveOrderItem[] {
  return useMemo(() => {
    const today = startOfDay(new Date()).getTime();

    const summariesById = new Map<string, any>();
    tasks
      .filter((t: any) => t.type === 'summary')
      .forEach((s: any) => summariesById.set(String(s.id), s));

    const groups = new Map<string, any[]>();
    tasks
      .filter((task: any) => task.type !== 'summary')
      .filter((task: any) => task.end instanceof Date && task.end.getTime() >= today)
      .forEach((task: any) => {
        const key = String(task.parent ?? task.id);
        const list = groups.get(key) || [];
        list.push(task);
        groups.set(key, list);
      });

    const result: ActiveOrderItem[] = [];

    for (const [parentKey, children] of groups) {
      const parentSummary = findSummary(summariesById, parentKey);

      // BOM bileşen siparişlerinin kendi "proje" satırı (örn. "Bileşen: X") ana
      // siparişin altına nested olarak `parent` alanı dolu şekilde gelir — bu,
      // bileşenin kendisinin bir üst-seviye sipariş OLMADIĞI anlamına gelir.
      // Bunları burada ayrı bir "aktif sipariş" satırı olarak göstermeyelim;
      // sadece Gantt'ta ana siparişin altında nested görünmeliler.
      if (parentSummary && parentSummary.parent) continue;

      // Group split tasks by their root split UUID. A task is considered part of a split
      // if its id starts with 'split_' (and not 'split_fake_'). We also respect the
      // is_explicit_split flag on the parent summary task so orders that were previously
      // split but only have 1 remaining part still show as partial.
      const splitRootGroups = new Map<string, any[]>();
      const parentIsExplicitSplit = parentSummary?.is_explicit_split === true;

      children
        .forEach((t: any) => {
          const tid = String(t.id);
          if (!tid.startsWith('split_') || tid.startsWith('split_fake_')) return;
          const rootId = tid.slice('split_'.length).split('_')[0] || tid;
          const list = splitRootGroups.get(rootId) || [];
          list.push(t);
          splitRootGroups.set(rootId, list);
        });

      const treatAsSplit = splitRootGroups.size > 1 || (splitRootGroups.size === 1 && parentIsExplicitSplit);

      if (treatAsSplit) {
        const reps: any[] = [];
        splitRootGroups.forEach((group) => {
          const earliestStart = Math.min(...group.map((t: any) => t.start instanceof Date ? t.start.getTime() : Infinity));
          const latestEnd = Math.max(...group.map((t: any) => t.end instanceof Date ? t.end.getTime() : -Infinity));

          const delivery = group.find((t: any) => String(t.stage || '').toLowerCase() === 'delivery');
          let repTask: any;
          if (delivery) { 
            repTask = delivery; 
          } else {
            const sorted = [...group].sort((a: any, b: any) => {
              const aTime = (a.deliveryDate || a.end || a.start) instanceof Date ? (a.deliveryDate || a.end || a.start).getTime() : 0;
              const bTime = (b.deliveryDate || b.end || b.start) instanceof Date ? (b.deliveryDate || b.end || b.start).getTime() : 0;
              return aTime - bTime;
            });
            repTask = sorted[sorted.length - 1];
          }

          reps.push({
            ...repTask,
            computedStart: earliestStart !== Infinity ? new Date(earliestStart) : repTask.start,
            computedEnd: latestEnd !== -Infinity ? new Date(latestEnd) : repTask.end,
          });
        });

        if (parentSummary) {
          const earliestStart = Math.min(...children.map((t: any) => t.start instanceof Date ? t.start.getTime() : Infinity));
          const latestEnd = Math.max(...children.map((t: any) => t.end instanceof Date ? t.end.getTime() : -Infinity));

          result.push({
            id: String(parentSummary.id),
            orderNo: String(parentSummary.externalId || ''),
            productType: parentSummary.text || '',
            customerName: parentSummary.customerName || '',
            // Use the order's original total quantity from base_data; fall back to summing parts.
            quantity: parentSummary.quantity != null
              ? Number(parentSummary.quantity)
              : reps.reduce((sum: number, t: any) => sum + (Number(t.quantity) || 0), 0),
            start: new Date(earliestStart),
            end: new Date(latestEnd),
            deliveryDate: new Date(latestEnd),
            chipLabel: parentSummary.text || '',
            calendarLabel: parentSummary.text || '',
            text: parentSummary.text || '',
            depth: 0,
            isSplitChild: false,
          });

          reps.forEach((child: any) => {
            result.push({
              id: String(child.id),
              orderNo: String(parentSummary.externalId || ''),
              productType: child.productType || child.text || '',
              customerName: child.customerName || parentSummary.customerName || '',
              quantity: child.quantity ?? null,
              start: child.computedStart || (child.start instanceof Date ? child.start : new Date()),
              end: child.computedEnd || (child.end instanceof Date ? child.end : new Date()),
              deliveryDate: child.computedEnd || (child.deliveryDate instanceof Date ? child.deliveryDate : (child.end instanceof Date ? child.end : new Date())),
              chipLabel: child.chipLabel || child.text || '',
              calendarLabel: child.calendarLabel || child.text || '',
              text: child.text || '',
              depth: 1,
              isSplitChild: true,
            });
          });
        } else {
          reps.forEach((child: any) => {
            result.push({
              id: String(child.id),
              orderNo: child.orderNo || '',
              productType: child.productType || child.text || '',
              customerName: child.customerName || '',
              quantity: child.quantity ?? null,
              start: child.computedStart || (child.start instanceof Date ? child.start : new Date()),
              end: child.computedEnd || (child.end instanceof Date ? child.end : new Date()),
              deliveryDate: child.computedEnd || (child.deliveryDate instanceof Date ? child.deliveryDate : (child.end instanceof Date ? child.end : new Date())),
              chipLabel: child.chipLabel || child.text || '',
              calendarLabel: child.calendarLabel || child.text || '',
              text: child.text || '',
              depth: 0,
              isSplitChild: false,
            });
          });
        }
      } else {
        const earliestStart = Math.min(...children.map((t: any) => t.start instanceof Date ? t.start.getTime() : Infinity));
        const latestEnd = Math.max(...children.map((t: any) => t.end instanceof Date ? t.end.getTime() : -Infinity));
        const first = children[0];

        result.push({
          id: String(first.id),
          orderNo: first.orderNo || '',
          productType: first.productType || first.chipLabel || '',
          customerName: first.customerName || '',
          quantity: first.quantity ?? null,
          start: new Date(earliestStart),
          end: new Date(latestEnd),
          deliveryDate: new Date(latestEnd),
          chipLabel: first.chipLabel || '',
          calendarLabel: first.calendarLabel || first.text || '',
          text: first.text || '',
          depth: 0,
          isSplitChild: false,
        });
      }
    }

    const sortedByStart = result.slice().sort((a, b) => a.start.getTime() - b.start.getTime());

    // Aynı sipariş no'ya sahip ama farklı ürünlerden oluşan siparişleri
    // (tek bir "sepet") listede yan yana ve dallanma göstergesiyle gruplamak
    // için sipariş no bazında grupla. Gerçek üretim parçalarını (isSplitChild)
    // bu gruplamanın dışında tutuyoruz, o zaten kendi dallanma gösterimine sahip.
    const orderNoGroups = new Map<string, ActiveOrderItem[]>();
    sortedByStart.forEach((item) => {
      if (item.isSplitChild || !item.orderNo) return;
      const list = orderNoGroups.get(item.orderNo) || [];
      list.push(item);
      orderNoGroups.set(item.orderNo, list);
    });

    const consumed = new Set<string>();
    const finalList: ActiveOrderItem[] = [];

    sortedByStart.forEach((item) => {
      if (consumed.has(item.id)) return;

      const group = !item.isSplitChild && item.orderNo ? orderNoGroups.get(item.orderNo) : undefined;
      if (group && group.length > 1) {
        const quantities = group.map((m) => m.quantity).filter((q): q is number => q != null);
        const totalQuantity = quantities.length > 0 ? quantities.reduce((sum, q) => sum + q, 0) : null;
        const earliestStart = Math.min(...group.map((m) => m.start.getTime()));
        const latestEnd = Math.max(...group.map((m) => m.end.getTime()));
        const latestDelivery = Math.max(...group.map((m) => m.deliveryDate.getTime()));
        const headCustomer = group.find((m) => m.customerName)?.customerName || '';

        // Sepet başlığı: tek bir ürünü temsil etmez, sadece sipariş no ve
        // içindeki ürün sayısını gösterir. Gerçek ürünler dal satırları olarak listelenir.
        finalList.push({
          ...group[0],
          id: `group_${item.orderNo}`,
          productType: '',
          customerName: headCustomer,
          quantity: totalQuantity,
          start: new Date(earliestStart),
          end: new Date(latestEnd),
          deliveryDate: new Date(latestDelivery),
          isOrderGroupChild: false,
          isOrderGroupHead: true,
          orderGroupSize: group.length,
        });

        group.forEach((member) => {
          consumed.add(member.id);
          finalList.push({ ...member, isOrderGroupChild: true, isOrderGroupHead: false, orderGroupSize: group.length });
        });
      } else {
        consumed.add(item.id);
        finalList.push({ ...item, isOrderGroupChild: false });
      }
    });

    return finalList;
  }, [tasks]);
}
