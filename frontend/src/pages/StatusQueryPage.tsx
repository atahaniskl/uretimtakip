/**
 * Status Query page — spreadsheet-style serial number stage tracking.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { getApiErrorMessage } from '../lib/errorMessage';

type CellValue = string | number | null | undefined;

interface StatusQueryRow {
  id: string;
  order_id: string;
  external_id: string;
  customer_name: string | null;
  product_model_no: string | null;
  product_name: string | null;
  serial_number: string;
  current_stage: string;
  created_at: string;
  updated_at: string;
}

interface OrderSummaryRow {
  groupId: string;
  external_id: string;
  customer_name: string;
  product_name: string;
  total: number;
  stageCounts: Record<string, number>;
  updated_at: string;
}

interface StatusQueryResponse {
  rows: StatusQueryRow[];
  total: number;
}

interface Column {
  key: string;
  label: string;
  placeholder: string;
  getValue: (row: OrderSummaryRow) => CellValue;
  sticky?: boolean;
}

// DİKKAT: Bu sabit lib/stageLabels.ts'teki STAGE_LABELS ile AYNI DEĞİLDİR ve
// onunla BİRLEŞTİRİLMEMELİDİR. Oradaki 5 üretim BLOĞUNU (Tedarik/Dizgi/Üretim/
// Test/Teslimat) adlandırır; buradaki ise SERİ NUMARASI aşamalarını (backend
// SerialNumberStage enum'u — epoxy/conformal/montaj/test1... dahil 12 adım)
// adlandırır. İki kavram farklı granülerliktedir.
const STAGE_LABELS: Record<string, string> = {
  supply: 'Tedarik',
  assembly: 'Dizgi',
  epoxy: 'Epoxy',
  conformal: 'Conformal',
  montaj: 'Montaj',
  kalite: 'Kalite',
  montaj_kalite: 'M.Kalite',
  test1: 'Test1',
  test2: 'Test2',
  final_test: 'F.Test',
  delivery: 'Teslimat',
  completed: 'Tamamlandı',
};

const COLUMNS: Column[] = [
  { key: 'external_id', label: 'Sipariş No', placeholder: 'Sipariş filtrele', getValue: (row) => row.external_id, sticky: true },
  { key: 'customer_name', label: 'Müşteri', placeholder: 'Müşteri filtrele', getValue: (row) => row.customer_name },
  { key: 'product_name', label: 'Ürün Adı', placeholder: 'Ürün filtrele', getValue: (row) => row.product_name },
  ...Object.entries(STAGE_LABELS).map(([stageKey, stageLabel]) => ({
    key: `stage_${stageKey}`,
    label: stageLabel,
    placeholder: '',
    getValue: (row: OrderSummaryRow) => `${row.stageCounts[stageKey] || 0}/${row.total}`
  })),
  { key: 'updated_at', label: 'Son Sorgu/Güncelleme', placeholder: 'Tarih filtrele', getValue: (row) => row.updated_at },
];

const formatCell = (value: CellValue) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
  return value;
};

export default function StatusQueryPage() {
  const [rows, setRows] = useState<StatusQueryRow[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchStatuses = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get<StatusQueryResponse>('/serial-numbers/status-query', {
        params: { include_deleted: includeDeleted },
      });
      setRows(data.rows);
      setError('');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Durum kayıtları yüklenemedi.'));
    } finally {
      setIsLoading(false);
    }
  }, [includeDeleted]);

  useEffect(() => {
    fetchStatuses();
  }, [fetchStatuses]);

  const summaryRows = useMemo(() => {
    const groups = new Map<string, OrderSummaryRow>();
    
    rows.forEach(row => {
      const groupId = `${row.order_id}-${row.product_name || ''}`;
      if (!groups.has(groupId)) {
        const customer = row.customer_name || '';
        groups.set(groupId, {
          groupId,
          external_id: row.external_id,
          customer_name: customer,
          product_name: row.product_name || '',
          total: 0,
          stageCounts: {},
          updated_at: row.updated_at,
        });
      }
      
      const group = groups.get(groupId)!;
      group.total += 1;
      group.stageCounts[row.current_stage] = (group.stageCounts[row.current_stage] || 0) + 1;
      
      if (new Date(row.updated_at) > new Date(group.updated_at)) {
        group.updated_at = row.updated_at;
      }
    });
    
    return Array.from(groups.values());
  }, [rows]);

  const filteredSummaryRows = useMemo(() => {
    const normalizedFilters = Object.entries(filters)
      .map(([key, value]) => [key, value.trim().toLocaleLowerCase('tr-TR')] as const)
      .filter(([, value]) => value);

    if (normalizedFilters.length === 0) return summaryRows;

    return summaryRows.filter((row) =>
      normalizedFilters.every(([key, value]) => {
        const column = COLUMNS.find((item) => item.key === key);
        if (!column) return true;
        return String(formatCell(column.getValue(row))).toLocaleLowerCase('tr-TR').includes(value);
      }),
    );
  }, [filters, summaryRows]);

  const setFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="h-full min-h-0 flex flex-col animate-fade-in">
      <div className="px-6 py-5 border-b border-surface-700/50 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Durum Sorgulama</h1>
          <p className="text-surface-400 text-sm mt-1">
            {filteredSummaryRows.length} sipariş grubu ({rows.length} seri numarası)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-surface-300 select-none">
            <input
              type="checkbox"
              checked={includeDeleted}
              onChange={(event) => setIncludeDeleted(event.target.checked)}
              className="h-4 w-4 rounded border-surface-600 bg-surface-800 text-primary-500"
            />
            Silinen siparişleri göster
          </label>
          <button type="button" onClick={fetchStatuses} className="btn-ghost text-sm flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Yenile
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <svg className="animate-spin h-8 w-8 text-primary-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-6 py-6">
          <div className="h-full overflow-auto border border-surface-700/60 rounded-lg bg-surface-950/60">
            <table className="min-w-max border-collapse text-xs">
              <thead className="sticky top-0 z-20 bg-surface-900">
                <tr>
                  {COLUMNS.map((column, index) => (
                    <th
                      key={column.key}
                      className={`border-b border-r border-surface-700/70 px-3 py-2 text-left font-semibold text-surface-300 whitespace-nowrap ${
                        column.sticky ? 'sticky left-0 z-30 bg-surface-900 min-w-44' : 'min-w-28'
                      }`}
                      style={column.sticky ? { left: 0 } : undefined}
                    >
                      <span className="text-surface-500 mr-2">{index + 1}</span>
                      {column.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={`${column.key}-filter`}
                      className={`border-b border-r border-surface-700/70 px-2 py-2 ${
                        column.sticky ? 'sticky left-0 z-30 bg-surface-900' : 'bg-surface-900'
                      }`}
                      style={column.sticky ? { left: 0 } : undefined}
                    >
                      {column.placeholder ? (
                        <input
                          value={filters[column.key] || ''}
                          onChange={(event) => setFilter(column.key, event.target.value)}
                          className="input-field h-8 rounded-lg px-2 py-1 text-xs w-full"
                          placeholder={column.placeholder}
                        />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSummaryRows.map((row) => (
                  <tr key={row.groupId} className="hover:bg-primary-500/10">
                    {COLUMNS.map((column) => {
                      const value = formatCell(column.getValue(row));
                      const isStageCol = column.key.startsWith('stage_');
                      const stageKey = isStageCol ? column.key.replace('stage_', '') : null;
                      const hasItemsInStage = stageKey ? (row.stageCounts[stageKey] || 0) > 0 : false;
                      const isCompletedStage = stageKey === 'completed';

                      let extraClasses = '';
                      if (hasItemsInStage) {
                        extraClasses = isCompletedStage ? 'text-green-400 font-medium' : 'text-primary-400 font-medium';
                      }

                      return (
                        <td
                          key={column.key}
                          className={`border-b border-r border-surface-800/80 px-3 py-2 text-surface-300 max-w-72 truncate whitespace-nowrap ${
                            column.sticky ? 'sticky left-0 z-10 bg-surface-950 font-medium text-surface-100' : ''
                          } ${extraClasses}`}
                          title={String(value)}
                          style={column.sticky ? { left: 0 } : undefined}
                        >
                          {value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {filteredSummaryRows.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS.length} className="py-16 text-center text-surface-500">
                      Gösterilecek kayıt bulunamadı
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
