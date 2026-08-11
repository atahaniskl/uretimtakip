import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

interface OrderHistoryChange {
  field: string;
  old_value: string;
  new_value: string;
}

interface OrderHistoryEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  performed_by: string;
  performer_username: string | null;
  timestamp: string;
  order_external_id: string | null;
  order_customer_name: string | null;
  description: string;
  changes: OrderHistoryChange[];
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  note_count: number;
}

interface PageData {
  logs: OrderHistoryEntry[];
  total: number;
  page: number;
  page_size: number;
}

interface Note {
  id: string;
  audit_log_id: string;
  content: string;
  created_by: string;
  creator_username: string | null;
  created_at: string;
  updated_at: string | null;
}

const ACTION_META: Record<string, { label: string; icon: string; color: string }> = {
  CREATE: { label: 'Oluşturma', icon: '➕', color: 'emerald' },
  UPDATE: { label: 'Güncelleme', icon: '✏️', color: 'amber' },
  DELETE: { label: 'Silme', icon: '🗑️', color: 'red' },
  DRAG: { label: 'Sürükleme', icon: '📅', color: 'blue' },
  SPLIT: { label: 'Bölme', icon: '✂️', color: 'purple' },
};

const colorMap: Record<string, { dot: string; badge: string; border: string }> = {
  emerald: { dot: 'bg-emerald-500 ring-emerald-500/30', badge: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30', border: 'border-emerald-500/20' },
  amber: { dot: 'bg-amber-500 ring-amber-500/30', badge: 'text-amber-400 bg-amber-500/15 border-amber-500/30', border: 'border-amber-500/20' },
  red: { dot: 'bg-red-500 ring-red-500/30', badge: 'text-red-400 bg-red-500/15 border-red-500/30', border: 'border-red-500/20' },
  blue: { dot: 'bg-blue-500 ring-blue-500/30', badge: 'text-blue-400 bg-blue-500/15 border-blue-500/30', border: 'border-blue-500/20' },
  purple: { dot: 'bg-purple-500 ring-purple-500/30', badge: 'text-purple-400 bg-purple-500/15 border-purple-500/30', border: 'border-purple-500/20' },
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatShortDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getDateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (dateOnly.getTime() === today.getTime()) return 'Bugün';
  if (dateOnly.getTime() === yesterday.getTime()) return 'Dün';
  const diffDays = Math.floor((today.getTime() - dateOnly.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) return 'Bu Hafta';
  if (diffDays <= 14) return 'Geçen Hafta';
  return formatDate(iso);
}

function DiffBadge({ change }: { change: OrderHistoryChange }) {
  if (change.field.includes('Dilim') || change.field === 'Bölünme Oranı') {
    return <span className="text-surface-300">{change.new_value}</span>;
  }
  // Backend, "önceki değeri yok" durumunu (oluşturma özeti ya da boş bir alanın
  // ilk kez doldurulması) old_value = "—" ile bildirir. Bunu normal diff gibi
  // çizmek "—" üstü çizili + ok + değer gibi anlamsız bir satır üretiyordu.
  if (change.old_value === '—' || change.old_value === '-') {
    return <span className="text-surface-200 font-medium">{change.new_value}</span>;
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-surface-500 line-through text-xs">{change.old_value}</span>
      <svg className="w-3.5 h-3.5 text-primary-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>
      <span className="text-surface-200 font-medium">{change.new_value}</span>
    </div>
  );
}

function ChangeRow({ change }: { change: OrderHistoryChange }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs font-medium text-surface-400 min-w-[100px] pt-0.5">{change.field}</span>
      <div className="flex-1 min-w-0">
        <DiffBadge change={change} />
      </div>
    </div>
  );
}

export default function OrderHistoryPage() {
  const { user } = useAuth();
  const [data, setData] = useState<PageData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [hiddenNotes, setHiddenNotes] = useState<Set<string>>(new Set());
  const [notesCache, setNotesCache] = useState<Record<string, Note[]>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');

  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const fetchingRef = useRef<Set<string>>(new Set());
  const pageSize = 30;

  const fetchLogs = useCallback(async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('page_size', String(pageSize));
      if (filterAction) params.set('action', filterAction);
      if (filterSearch) params.set('search', filterSearch);
      if (filterDateFrom) params.set('date_from', filterDateFrom);
      if (filterDateTo) params.set('date_to', filterDateTo);
      const { data: res } = await api.get(`/audit-logs/order-history?${params.toString()}`);
      setData(res);
      setError('');
    } catch {
      setError('Sipariş geçmişi yüklenemedi.');
    } finally {
      setIsLoading(false);
    }
  }, [page, filterAction, filterSearch, filterDateFrom, filterDateTo]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { setPage(1); }, [filterAction, filterSearch, filterDateFrom, filterDateTo]);

  // Fetch notes for all visible logs when data loads
  useEffect(() => {
    if (!data?.logs) return;
    data.logs.forEach((log) => {
      if (notesCache[log.id] || fetchingRef.current.has(log.id)) return;
      fetchingRef.current.add(log.id);
      api.get(`/audit-logs/${log.id}/notes`)
        .then(({ data: notes }) => setNotesCache((prev) => ({ ...prev, [log.id]: notes })))
        .catch(() => setNotesCache((prev) => ({ ...prev, [log.id]: [] })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const toggleHideNotes = (logId: string) => {
    setHiddenNotes((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) next.delete(logId); else next.add(logId);
      return next;
    });
  };

  const handleSearchChange = (val: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setFilterSearch(val); }, 400);
  };

  const handleAddNote = async (logId: string) => {
    const content = noteDrafts[logId]?.trim();
    if (!content) return;
    try {
      const { data: note } = await api.post(`/audit-logs/${logId}/notes`, { content });
      setNotesCache((prev) => ({ ...prev, [logId]: [...(prev[logId] || []), note] }));
      setNoteDrafts((prev) => ({ ...prev, [logId]: '' }));
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          logs: prev.logs.map((l) => l.id === logId ? { ...l, note_count: l.note_count + 1 } : l),
        };
      });
    } catch { /* ignore */ }
  };

  const handleDeleteNote = async (logId: string, noteId: string) => {
    if (!window.confirm('Notu silmek istediğinize emin misiniz?')) return;
    try {
      await api.delete(`/audit-logs/notes/${noteId}`);
      setNotesCache((prev) => ({ ...prev, [logId]: (prev[logId] || []).filter((n) => n.id !== noteId) }));
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          logs: prev.logs.map((l) => l.id === logId ? { ...l, note_count: Math.max(0, l.note_count - 1) } : l),
        };
      });
    } catch { /* ignore */ }
  };

  const handleEditStart = (note: Note) => {
    setEditingNoteId(note.id);
    setEditingNoteContent(note.content);
  };

  const handleEditSave = async (logId: string, noteId: string) => {
    const content = editingNoteContent.trim();
    if (!content) return;
    try {
      const { data: note } = await api.put(`/audit-logs/notes/${noteId}`, { content });
      setNotesCache((prev) => ({
        ...prev,
        [logId]: (prev[logId] || []).map((n) => n.id === noteId ? note : n),
      }));
      setEditingNoteId(null);
      setEditingNoteContent('');
    } catch { /* ignore */ }
  };

  const handleEditCancel = () => {
    setEditingNoteId(null);
    setEditingNoteContent('');
  };

  const canManageNote = (note: Note) => {
    return user?.role === 'ADMIN' || user?.role === 'PLANNER' || note.created_by === user?.id;
  };

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  const groupedLogs: { label: string; entries: OrderHistoryEntry[] }[] = [];
  if (data?.logs) {
    let currentGroup: { label: string; entries: OrderHistoryEntry[] } | null = null;
    for (const log of data.logs) {
      const label = getDateLabel(log.timestamp);
      if (!currentGroup || currentGroup.label !== label) {
        currentGroup = { label, entries: [] };
        groupedLogs.push(currentGroup);
      }
      currentGroup.entries.push(log);
    }
  }

  return (
    <div className="p-6 animate-fade-in max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Sipariş Geçmişi</h1>
          <p className="text-surface-400 text-sm mt-1">
            Siparişler üzerinde yapılan tüm değişikliklerin kronolojik görünümü
            {data && <span className="ml-1">— {data.total} kayıt</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowFilters(!showFilters)} className={`btn-ghost text-sm flex items-center gap-2 ${showFilters ? 'text-primary-400' : ''}`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filtreler
          </button>
          <button onClick={fetchLogs} className="btn-ghost text-sm flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Yenile
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="glass-card p-4 mb-6 animate-slide-up">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-surface-400 mb-1.5">Aksiyon</label>
              <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)} className="input-field w-full">
                <option value="">Tüm Aksiyonlar</option>
                <option value="CREATE">Oluşturma</option>
                <option value="UPDATE">Güncelleme</option>
                <option value="DELETE">Silme</option>
                <option value="DRAG">Sürükleme</option>
                <option value="SPLIT">Bölme</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-surface-400 mb-1.5">Sipariş Ara</label>
              <input type="text" placeholder="Sipariş adı veya müşteri..." defaultValue={filterSearch} onChange={(e) => handleSearchChange(e.target.value)} className="input-field w-full" />
            </div>
            <div>
              <label className="block text-xs text-surface-400 mb-1.5">Başlangıç Tarihi</label>
              <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="input-field w-full" />
            </div>
            <div>
              <label className="block text-xs text-surface-400 mb-1.5">Bitiş Tarihi</label>
              <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="input-field w-full" />
            </div>
          </div>
          {(filterAction || filterSearch || filterDateFrom || filterDateTo) && (
            <button onClick={() => { setFilterAction(''); setFilterSearch(''); setFilterDateFrom(''); setFilterDateTo(''); }} className="btn-ghost text-xs mt-3 text-surface-400 hover:text-surface-200">
              Filtreleri Temizle
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-6">{error}</div>
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
          {groupedLogs.length === 0 ? (
            <div className="text-center py-20 text-surface-500">
              <svg className="w-16 h-16 mx-auto mb-4 text-surface-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-lg font-medium text-surface-400">Henüz kayıt bulunmuyor</p>
              <p className="text-sm mt-1">Siparişler üzerinde yapılan değişiklikler burada görünecek.</p>
            </div>
          ) : (
            <div className="space-y-8">
              {groupedLogs.map((group) => (
                <div key={group.label}>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-surface-700/50 to-transparent" />
                    <span className="text-sm font-semibold text-surface-400 px-3 py-1 bg-surface-800/50 rounded-full border border-surface-700/30">{group.label}</span>
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-surface-700/50 to-transparent" />
                  </div>

                  <div className="relative pl-8 space-y-4">
                    <div className="absolute left-[15px] top-2 bottom-2 w-px bg-surface-700/50" />

                    {group.entries.map((entry) => {
                      const meta = ACTION_META[entry.action] || { label: entry.action, icon: '•', color: 'surface' };
                      const c = colorMap[meta.color] || colorMap.amber;
                      const hidden = hiddenNotes.has(entry.id);
                      const notes = notesCache[entry.id];

                      return (
                        <div key={entry.id} className="relative group">
                          <div className={`absolute -left-8 top-5 w-[30px] h-[30px] rounded-full ${c.dot} ring-4 ring-surface-900 flex items-center justify-center text-xs z-10 shadow-lg transition-transform hover:scale-110`}>
                            <span className="text-white text-xs leading-none">{meta.icon}</span>
                          </div>

                          <div className={`glass-card overflow-hidden border-l-2 ${c.border}`}>
                            <div className="px-5 py-4 flex items-start justify-between gap-4">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`badge ${c.badge} border text-xs`}>{meta.icon} {meta.label}</span>
                                  {entry.order_customer_name && <span className="text-xs text-surface-500">{entry.order_customer_name}</span>}
                                </div>
                                <p className="text-sm text-surface-200 mt-1.5 font-medium">{entry.description}</p>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="text-xs text-surface-400 font-mono">{formatTime(entry.timestamp)}</p>
                                {entry.performer_username && <p className="text-xs text-surface-500 mt-0.5">{entry.performer_username}</p>}
                              </div>
                            </div>

                            {entry.changes.length > 0 && (
                              <div className="px-5 pb-3">
                                <div className="bg-surface-800/40 rounded-lg p-3 border border-surface-700/30">
                                  {entry.changes.map((change, idx) => <ChangeRow key={idx} change={change} />)}
                                </div>
                              </div>
                            )}

                            {/* Notes section */}
                            <div className="border-t border-surface-700/30">
                              {/* Notes header */}
                              <button
                                onClick={() => toggleHideNotes(entry.id)}
                                className="w-full flex items-center justify-between px-5 py-2.5 text-xs text-surface-500 hover:text-surface-300 hover:bg-surface-800/20 transition-colors"
                              >
                                <div className="flex items-center gap-1.5">
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                                  </svg>
                                  <span>Notlar</span>
                                  {entry.note_count > 0 && <span className="text-surface-500">({entry.note_count})</span>}
                                </div>
                                <svg className={`w-3 h-3 transition-transform ${hidden ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>

                              {!hidden && (
                                <div className="px-5 pb-4 animate-slide-up pt-2">
                                  {!notes ? (
                                    <div className="flex items-center justify-center py-4">
                                      <svg className="animate-spin h-5 w-5 text-primary-500" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                                      </svg>
                                    </div>
                                  ) : (
                                    <>
                                      {notes.length > 0 && (
                                        <div className="space-y-2 mb-3">
                                          {notes.map((note) => (
                                            <div key={note.id} className="bg-surface-800/40 rounded-lg p-3 border border-surface-700/30">
                                              <div className="flex items-start justify-between gap-2">
                                                <div className="flex items-center gap-2 text-xs text-surface-500 mb-1.5">
                                                  <span className="font-medium text-surface-400">{note.creator_username || 'Bilinmeyen'}</span>
                                                  <span>{formatShortDate(note.created_at)}</span>
                                                  {note.updated_at && <span className="text-surface-600">· düzenlendi {formatShortDate(note.updated_at)}</span>}
                                                </div>
                                                {canManageNote(note) && editingNoteId !== note.id && (
                                                  <div className="flex gap-1 flex-shrink-0">
                                                    <button onClick={() => handleEditStart(note)} className="text-surface-500 hover:text-primary-400 transition-colors p-0.5" title="Düzenle">
                                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                                      </svg>
                                                    </button>
                                                    <button onClick={() => handleDeleteNote(entry.id, note.id)} className="text-surface-500 hover:text-red-400 transition-colors p-0.5" title="Sil">
                                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                      </svg>
                                                    </button>
                                                  </div>
                                                )}
                                              </div>
                                              {editingNoteId === note.id ? (
                                                <div className="space-y-2">
                                                  <textarea
                                                    value={editingNoteContent}
                                                    onChange={(e) => setEditingNoteContent(e.target.value)}
                                                    className="input-field w-full text-sm resize-none"
                                                    rows={2}
                                                    autoFocus
                                                  />
                                                  <div className="flex gap-2">
                                                    <button onClick={() => handleEditSave(entry.id, note.id)} className="btn-primary text-xs px-3 py-1.5 rounded-lg">Kaydet</button>
                                                    <button onClick={handleEditCancel} className="btn-ghost text-xs px-3 py-1.5 rounded-lg">Vazgeç</button>
                                                  </div>
                                                </div>
                                              ) : (
                                                <p className="text-sm text-surface-200 whitespace-pre-wrap">{note.content}</p>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {/* Add note */}
                                      <div className="flex gap-2">
                                        <textarea
                                          value={noteDrafts[entry.id] || ''}
                                          onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                                          placeholder="Not ekle..."
                                          className="input-field flex-1 text-sm resize-none"
                                          rows={1}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                              e.preventDefault();
                                              handleAddNote(entry.id);
                                            }
                                          }}
                                        />
                                        <button
                                          onClick={() => handleAddNote(entry.id)}
                                          disabled={!noteDrafts[entry.id]?.trim()}
                                          className="btn-primary text-sm px-3 py-1.5 rounded-lg disabled:opacity-30 self-end"
                                        >
                                          Gönder
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-8 pt-6 border-t border-surface-700/30">
              <p className="text-sm text-surface-500">Sayfa {page} / {totalPages} (toplam {data?.total || 0} kayıt)</p>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-ghost text-sm disabled:opacity-30 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  Önceki
                </button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn-ghost text-sm disabled:opacity-30 flex items-center gap-1">
                  Sonraki
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
