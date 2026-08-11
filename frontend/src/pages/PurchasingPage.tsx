import { useState, useRef, useEffect } from 'react';
import { type PurchasingData, COLUMNS, parseMsgToRows } from '../lib/purchasingParser';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

// crypto.randomUUID() yerine kullanacağın yeni ID üretici fonksiyon:
const generateId = () => {
  // Eğer HTTPS veya localhost ise orijinalini kullan
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Eğer HTTP (güvensiz) ortamdaysa, zamana ve rastgeleliğe bağlı benzersiz ID üret
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

// ── Pending group = tek bir .msg dosyasından çıkan satırlar ──────────────────
interface PendingGroup {
  id: string;
  sourceFile: string;
  rows: PurchasingData[];
}

export default function PurchasingPage() {
  const { user } = useAuth();
  // Backend artık POST/PUT/DELETE için ADMIN/PLANNER rolü zorunlu kılıyor (bkz.
  // purchasing.py — eskiden BU UÇ NOKTALARDA HİÇ kimlik doğrulama yoktu, herkes
  // tüm satın alım kayıtlarını (fiyat/tedarikçi/müşteri bilgisi dahil) token'sız
  // okuyup/silip/değiştirebiliyordu). VIEWER rolündeki kullanıcılar artık bu
  // işlemlerde 403 alır — arayüz de bu düğmeleri/alanları önceden gizleyip
  // kafa karıştırıcı bir hata yerine sade salt-okunur bir görünüm sunar.
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  const [approved, setApproved] = useState<PurchasingData[]>([]);
  const [pendingGroups, setPendingGroups] = useState<PendingGroup[]>([]);
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const addLog = (m: string) => setLogs(p => [...p, m]);

  useEffect(() => {
    const fetchRecords = async () => {
      try {
        const res = await api.get('/purchasing/');
        // Backend sourceFile olarak döner (alias ile)
        setApproved(res.data.map((r: any) => ({ ...r, _sourceFile: r.sourceFile })));
      } catch (e: any) {
        addLog(`❌ Kayıtlar yüklenemedi: ${e.message}`);
      }
    };
    fetchRecords();
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setIsProcessing(true);
    const newGroups: PendingGroup[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.name.toLowerCase().endsWith('.msg')) { addLog(`⚠ ${file.name} – atlandı`); continue; }
      addLog(`📨 ${file.name}`);
      try {
        const rawRows = await parseMsgToRows(file, addLog);
        if (!rawRows.length) { addLog(`   ⚠ Hiç satır bulunamadı.`); continue; }
        const rows: PurchasingData[] = rawRows.map(r => ({ ...r, id: generateId() }));
        newGroups.push({ id: generateId(), sourceFile: file.name, rows });
        addLog(`   → ${rows.length} satır inceleme bekleniyor`);
      } catch (err: any) {
        addLog(`❌ ${file.name} – ${err?.message ?? err}`);
      }
    }

    if (newGroups.length) {
      setPendingGroups(p => { const next = [...p, ...newGroups]; setActiveGroupIdx(p.length); return next; });
    }
    setIsProcessing(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const curGroup = pendingGroups[activeGroupIdx];

  const updateCell = (rowId: string, key: keyof PurchasingData, val: string) => {
    setPendingGroups(gs => gs.map((g, gi) => gi !== activeGroupIdx ? g : {
      ...g,
      rows: g.rows.map(r => r.id === rowId ? { ...r, [key]: val } : r),
    }));
  };

  const deleteRow = (rowId: string) => {
    setPendingGroups(gs => gs.map((g, gi) => gi !== activeGroupIdx ? g : {
      ...g,
      rows: g.rows.filter(r => r.id !== rowId),
    }));
  };

  const addEmptyRow = () => {
    const empty: PurchasingData = {
      id: generateId(),
      purchaseNo: '', purchasingAgent: '', approval: '', type: '',
      product: '', version: '', quantity: '', project: '', customer: '',
      proposalNo: '', listPrice: '', unitPriceEuro: '', unitPriceUsd: '',
      totalPriceUsd: '', company: '', supplier: '', orderDate: '',
      expectedDeliveryDate: '', deliveryDate: '',
      _sourceFile: curGroup?.sourceFile,
    };
    setPendingGroups(gs => gs.map((g, gi) => gi !== activeGroupIdx ? g : { ...g, rows: [...g.rows, empty] }));
  };

  const commitGroup = async () => {
    if (!curGroup) return;
    const rowsToAdd = curGroup.rows;

    // _sourceFile -> sourceFile alias'i ile gönder (Pydantic v2 uyumu)
    const payload = rowsToAdd.map(r => ({
      ...r,
      _sourceFile: r._sourceFile ?? undefined,
    }));

    try {
      addLog(`💾 ${rowsToAdd.length} satır kaydediliyor...`);
      await api.post('/purchasing/bulk-create', { rows: payload });
      // Kayit başarili -> UI'yi guncelle
      setApproved(p => [...p, ...rowsToAdd]);
      addLog(`✔ ${rowsToAdd.length} satır tabloya eklendi ve mail kuyruğuna alındı (${curGroup.sourceFile})`);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const errMsg = typeof detail === 'string' ? detail : JSON.stringify(detail);
      addLog(`❌ Kaydetme başarısız: ${errMsg || e.message}`);
      return; // Hata varsa pending group'u temizleme
    }

    setPendingGroups(p => {
      const next = p.filter((_, i) => i !== activeGroupIdx);
      setActiveGroupIdx(Math.max(0, activeGroupIdx - 1));
      return next;
    });
  };

  const discardGroup = () => {
    if (!curGroup) return;
    addLog(`✖ ${curGroup.sourceFile} iptal edildi`);
    setPendingGroups(p => {
      const next = p.filter((_, i) => i !== activeGroupIdx);
      setActiveGroupIdx(Math.max(0, activeGroupIdx - 1));
      return next;
    });
  };

  const updateApproved = (id: string, key: keyof PurchasingData, val: string) => {
    setApproved(p => p.map(r => r.id === id ? { ...r, [key]: val } : r));
  };

  const saveApprovedRow = async (row: PurchasingData) => {
    try {
      await api.put(`/purchasing/${row.id}`, row);
    } catch (e: any) {
      addLog(`❌ Satır güncellenemedi: ${e.message}`);
    }
  };

  const deleteApprovedRow = async (id: string) => {
    try {
      await api.delete(`/purchasing/${id}`);
      setApproved(p => p.filter(r => r.id !== id));
    } catch (e: any) {
      addLog(`❌ Satır silinemedi: ${e.message}`);
    }
  };

  const exportToExcel = async () => {
    const XLSX = await import('xlsx');
    const header = COLUMNS.map(c => c.label);
    const dataRows = approved.map(row =>
      COLUMNS.map(c => (row[c.key] as string) ?? '')
    );
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
    // Sütun genişliklerini ayarla
    ws['!cols'] = COLUMNS.map(() => ({ wch: 22 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Satın Alım');
    const date = new Date().toLocaleDateString('tr-TR').replace(/\//g, '-');
    XLSX.writeFile(wb, `satin-alim-${date}.xlsx`);
  };

  return (
    <div className="h-full min-h-0 flex flex-col animate-fade-in">
      {/* ── Header ── */}
      <div className="px-6 py-5 border-b border-surface-700/50 flex flex-wrap items-center justify-between gap-4 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Satın Alım</h1>
          <p className="text-surface-400 text-sm mt-1">.msg → Excel/PDF teklif çıkarımı, satın alım takibi</p>
        </div>
        <div className="flex items-center gap-3">
          {approved.length > 0 && <span className="text-surface-400 text-sm">{approved.length} kayıt</span>}
          {pendingGroups.length > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-400 text-xs font-semibold border border-amber-500/30">
              {pendingGroups.length} dosya bekliyor
            </span>
          )}
          <input type="file" accept=".msg" multiple ref={fileRef} onChange={handleUpload} className="hidden" />
          {approved.length > 0 && (
            <button type="button" onClick={exportToExcel}
              className="btn-ghost text-sm flex items-center gap-2 px-3 py-2 text-green-400 hover:text-green-300 hover:bg-green-500/10 border border-green-500/20 rounded-lg transition-all">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
              </svg>
              Excel İndir
            </button>
          )}
          {canEdit && (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={isProcessing}
              className="btn-primary text-sm flex items-center gap-2 px-4 py-2 disabled:opacity-50">
              {isProcessing
                ? <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>}
              {isProcessing ? 'İşleniyor…' : '.msg Dosyası Yükle'}
            </button>
          )}
        </div>
      </div>

      {/* ── PENDING REVIEW (tek .msg → tam tablo onayı) ── */}
      {canEdit && curGroup && (
        <div className="flex-shrink-0 mx-6 mt-4 border border-amber-500/30 rounded-xl overflow-hidden bg-amber-500/3">
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
            <div className="flex items-center gap-3 min-w-0">
              <svg className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              </svg>
              <span className="text-sm font-semibold text-amber-300 truncate">{curGroup.sourceFile}</span>
              <span className="text-xs text-amber-600">{curGroup.rows.length} satır</span>
            </div>
            {/* File tabs */}
            <div className="flex items-center gap-1 ml-4">
              {pendingGroups.map((g, i) => (
                <button key={g.id} type="button" onClick={() => setActiveGroupIdx(i)}
                  title={g.sourceFile}
                  className={`w-7 h-7 rounded text-xs font-bold transition-all ${i === activeGroupIdx ? 'bg-amber-500 text-black' : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}`}>
                  {i + 1}
                </button>
              ))}
            </div>
          </div>

          {/* Editable preview table */}
          <div className="overflow-auto max-h-72">
            <table className="min-w-max border-collapse text-xs w-full">
              <thead className="sticky top-0 z-10 bg-surface-900">
                <tr>
                  <th className="border-b border-r border-surface-700/60 px-2 py-1.5 text-surface-600 w-6">#</th>
                  {COLUMNS.map(c => (
                    <th key={c.key} className="border-b border-r border-surface-700/60 px-2 py-1.5 text-left text-[10px] font-semibold text-surface-400 whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                  <th className="border-b border-surface-700/60 w-6"/>
                </tr>
              </thead>
              <tbody>
                {curGroup.rows.map((row, idx) => (
                  <tr key={row.id} className="hover:bg-amber-500/5 group">
                    <td className="border-b border-r border-surface-800/60 px-2 py-0.5 text-surface-600 text-center">{idx + 1}</td>
                    {COLUMNS.map(c => (
                      <td key={c.key} className="border-b border-r border-surface-800/60 px-1 py-0.5 min-w-[6rem]">
                        <input
                          type="text"
                          value={(row[c.key] as string) ?? ''}
                          onChange={e => updateCell(row.id, c.key, e.target.value)}
                          className="w-full bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-amber-500/50 rounded px-1 py-0.5 text-xs text-surface-100 placeholder:text-surface-700"
                          placeholder="—"
                        />
                      </td>
                    ))}
                    <td className="border-b border-surface-800/60 px-1 py-0.5 text-center">
                      <button type="button" onClick={() => deleteRow(row.id)}
                        className="text-surface-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-amber-500/20 bg-surface-900/60">
            <button type="button" onClick={addEmptyRow}
              className="text-xs text-surface-500 hover:text-primary-400 flex items-center gap-1 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>
              Satır ekle
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={discardGroup}
                className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-xs font-semibold hover:bg-red-500/20 transition-all">
                İptal
              </button>
              <button type="button" onClick={commitGroup}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30 text-xs font-semibold hover:bg-green-500/30 transition-all">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/></svg>
                {curGroup.rows.length} satırı tabloya ekle
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Log ── */}
      {logs.length > 0 && (
        <div className="mx-6 mt-3 flex-shrink-0 bg-surface-900/60 border border-surface-700/40 rounded-lg p-2.5 max-h-24 overflow-y-auto">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] font-semibold text-surface-500 uppercase tracking-wider">Günlük</span>
            <button type="button" onClick={() => setLogs([])} className="text-[10px] text-surface-600 hover:text-red-400">Temizle</button>
          </div>
          {logs.map((l, i) => <p key={i} className="text-[11px] text-surface-400 font-mono leading-5">{l}</p>)}
        </div>
      )}

      {/* ── Approved table ── */}
      <div className="flex-1 min-h-0 px-6 py-3">
        <div className="h-full overflow-auto border border-surface-700/60 rounded-lg bg-surface-950/60">
          <table className="min-w-max border-collapse text-xs">
            <thead className="sticky top-0 z-20 bg-surface-900">
              <tr>
                <th className="border-b border-r border-surface-700/70 px-2 py-2 text-surface-600 w-8">#</th>
                {COLUMNS.map(c => (
                  <th key={c.key} className="border-b border-r border-surface-700/70 px-3 py-2 text-left font-semibold text-surface-300 whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
                <th className="border-b border-surface-700/70 w-8"/>
              </tr>
            </thead>
            <tbody>
              {approved.map((row, idx) => (
                <tr key={row.id} className="hover:bg-primary-500/10 group">
                  <td className="border-b border-r border-surface-800/80 px-2 py-1 text-surface-600 text-center">{idx + 1}</td>
                  {COLUMNS.map(c => (
                    <td key={c.key} className="border-b border-r border-surface-800/80 px-2 py-1 min-w-[6rem]">
                      <input type="text" value={(row[c.key] as string) ?? ''}
                        onChange={e => updateApproved(row.id, c.key, e.target.value)}
                        onBlur={() => saveApprovedRow(row)}
                        readOnly={!canEdit}
                        className="w-full bg-transparent border-none focus:outline-none focus:ring-1 focus:ring-primary-500 rounded px-1 py-0.5 text-xs text-surface-100 read-only:cursor-default"
                        placeholder="—"/>
                    </td>
                  ))}
                  <td className="border-b border-surface-800/80 px-1 py-1 text-center">
                    {canEdit && (
                      <button type="button" onClick={() => deleteApprovedRow(row.id)}
                        className="text-surface-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {approved.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 2} className="py-20 text-center text-surface-500">
                    {curGroup
                      ? 'Yukarıdan satırları inceleyip "Tabloya ekle" butonuna basın.'
                      : canEdit
                        ? <span>Henüz kayıt yok. <button type="button" onClick={() => fileRef.current?.click()} className="text-primary-400 hover:underline">.msg dosyası yükle</button></span>
                        : 'Henüz kayıt yok.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
