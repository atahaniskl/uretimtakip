/**
 * AuditLog page — Admin-only audit trail viewer.
 * Shows who changed what, when, with old/new values.
 */

import { useState, useEffect, useCallback } from 'react';
import api from '../lib/api';

interface AuditLogEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  performed_by: string;
  performer_username: string | null;
  timestamp: string;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  CREATE: { label: 'Oluşturma', color: 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30' },
  UPDATE: { label: 'Güncelleme', color: 'text-amber-400 bg-amber-500/20 border-amber-500/30' },
  DELETE: { label: 'Silme', color: 'text-red-400 bg-red-500/20 border-red-500/30' },
  DRAG: { label: 'Sürükleme', color: 'text-blue-400 bg-blue-500/20 border-blue-500/30' },
  SPLIT: { label: 'Bölme', color: 'text-purple-400 bg-purple-500/20 border-purple-500/30' },
  BACKUP: { label: 'Yedekleme', color: 'text-cyan-300 bg-cyan-500/20 border-cyan-500/30' },
  RESTORE: { label: 'Geri Yükleme', color: 'text-rose-300 bg-rose-500/20 border-rose-500/30' },
  BACKUP_POLICY_UPDATE: { label: 'Backup Politika', color: 'text-orange-300 bg-orange-500/20 border-orange-500/30' },
};

const ENTITY_LABELS: Record<string, string> = {
  order: 'Sipariş',
  delivery_split: 'Teslimat',
  mapping_template: 'Şablon',
  system_backup: 'Sistem Yedeği',
};

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [filterAction, setFilterAction] = useState('');
  const [filterEntity, setFilterEntity] = useState('');

  const pageSize = 30;

  const fetchLogs = useCallback(async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('page_size', String(pageSize));
      if (filterAction) params.set('action', filterAction);
      if (filterEntity) params.set('entity_type', filterEntity);

      const { data } = await api.get(`/audit-logs/?${params.toString()}`);
      setLogs(data.logs);
      setTotal(data.total);
      setError('');
    } catch {
      setError('Denetim kayıtları yüklenemedi. Yönetici yetkisi gereklidir.');
    } finally {
      setIsLoading(false);
    }
  }, [page, filterAction, filterEntity]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / pageSize);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="p-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Denetim İzleri</h1>
          <p className="text-surface-400 text-sm mt-1">
            Tüm değişikliklerin kaydı — {total} kayıt
          </p>
        </div>
        <button onClick={fetchLogs} className="btn-ghost text-sm flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Yenile
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <select
          value={filterAction}
          onChange={(e) => { setFilterAction(e.target.value); setPage(1); }}
          className="input-field w-48"
        >
          <option value="">Tüm Aksiyonlar</option>
          <option value="CREATE">Oluşturma</option>
          <option value="UPDATE">Güncelleme</option>
          <option value="DELETE">Silme</option>
          <option value="DRAG">Sürükleme</option>
          <option value="SPLIT">Bölme</option>
          <option value="BACKUP">Yedekleme</option>
          <option value="RESTORE">Geri Yükleme</option>
        </select>
        <select
          value={filterEntity}
          onChange={(e) => { setFilterEntity(e.target.value); setPage(1); }}
          className="input-field w-48"
        >
          <option value="">Tüm Varlıklar</option>
          <option value="order">Sipariş</option>
          <option value="delivery_split">Teslimat</option>
          <option value="mapping_template">Şablon</option>
          <option value="system_backup">Sistem Yedeği</option>
        </select>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-6">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <svg className="animate-spin h-8 w-8 text-primary-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </div>
      ) : (
        <>
          {/* Table */}
          <div className="glass-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-700/50 text-surface-400">
                  <th className="text-left py-3 px-4 font-medium">Zaman</th>
                  <th className="text-left py-3 px-4 font-medium">Kullanıcı</th>
                  <th className="text-left py-3 px-4 font-medium">Aksiyon</th>
                  <th className="text-left py-3 px-4 font-medium">Varlık</th>
                  <th className="text-left py-3 px-4 font-medium">Varlık ID</th>
                  <th className="text-left py-3 px-4 font-medium">Detay</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const actionInfo = ACTION_LABELS[log.action] || { label: log.action, color: 'text-surface-400 bg-surface-700/20 border-surface-600/30' };
                  const isExpanded = expandedId === log.id;

                  return (
                    <tr
                      key={log.id}
                      className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors cursor-pointer"
                      onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    >
                      <td className="py-3 px-4 text-surface-300 whitespace-nowrap">
                        {formatDate(log.timestamp)}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-surface-200 font-medium">
                          {log.performer_username || log.performed_by.slice(0, 8)}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`badge ${actionInfo.color} border`}>
                          {actionInfo.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-surface-300">
                        {ENTITY_LABELS[log.entity_type] || log.entity_type}
                      </td>
                      <td className="py-3 px-4">
                        <code className="text-xs text-surface-500 bg-surface-800 px-2 py-0.5 rounded">
                          {log.entity_id.slice(0, 8)}...
                        </code>
                      </td>
                      <td className="py-3 px-4">
                        <button className="text-primary-400 hover:text-primary-300 text-xs">
                          {isExpanded ? 'Gizle ▲' : 'Göster ▼'}
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {logs.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-surface-500">
                      Henüz denetim kaydı bulunmuyor
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* Expanded detail rows */}
            {logs.map((log) => {
              if (expandedId !== log.id) return null;
              return (
                <div key={`detail-${log.id}`} className="px-4 py-4 bg-surface-900/50 border-t border-surface-700/30 animate-slide-up">
                  <div className="grid grid-cols-2 gap-4">
                    {/* Old Value */}
                    <div>
                      <p className="text-xs font-medium text-surface-400 mb-2">Eski Değer</p>
                      <pre className="text-xs text-surface-300 bg-surface-800/50 p-3 rounded-lg overflow-auto max-h-40">
                        {log.old_value ? JSON.stringify(log.old_value, null, 2) : '—'}
                      </pre>
                    </div>
                    {/* New Value */}
                    <div>
                      <p className="text-xs font-medium text-surface-400 mb-2">Yeni Değer</p>
                      <pre className="text-xs text-surface-300 bg-surface-800/50 p-3 rounded-lg overflow-auto max-h-40">
                        {log.new_value ? JSON.stringify(log.new_value, null, 2) : '—'}
                      </pre>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-surface-500">
                Sayfa {page} / {totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="btn-ghost text-sm disabled:opacity-30"
                >
                  ← Önceki
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="btn-ghost text-sm disabled:opacity-30"
                >
                  Sonraki →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
