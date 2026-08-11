/**
 * MappingTemplates page — List and create mapping templates.
 */

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

interface MappingTemplate {
  id: string;
  name: string;
  column_map: Record<string, string>;
  unique_id_strategy: 'COLUMN' | 'HASH';
  unique_id_config: {
    column?: string;
    columns?: string[];
  } | null;
}

export default function MappingTemplatesPage() {
  const { user } = useAuth();
  // Backend (mapping_templates.py) DELETE için ADMIN/PLANNER rolü zorunlu kılıyor —
  // VIEWER kullanıcılara sil düğmesini gösterip 403 aldırmak yerine gizlenir
  // (bkz. purchasing.py/UploadPage.tsx'teki AYNI düzeltme).
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  const [templates, setTemplates] = useState<MappingTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Form state
  const [name, setName] = useState('');
  // Mapping columns format: Array of {excelCol, systemField}
  const [columns, setColumns] = useState<{ excelCol: string; systemField: string }[]>([
    { excelCol: '', systemField: '' }
  ]);
  const [idStrategyType, setIdStrategyType] = useState<'COLUMN' | 'HASH'>('COLUMN');
  const [idStrategyValue, setIdStrategyValue] = useState('');
  const [formError, setFormError] = useState('');

  const fetchTemplates = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get('/mapping-templates/');
      setTemplates(data);
      setError('');
    } catch {
      setError('Eşleme şablonları yüklenemedi.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Bu şablonu silmek istediğinize emin misiniz?')) return;
    try {
      await api.delete(`/mapping-templates/${id}`);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err: any) {
      const message = err?.response?.data?.detail || 'Şablon silinemedi. Lütfen tekrar deneyin.';
      alert(message);
    }
  };

  const closeModal = () => {
    setIsModalOpen(false);
  };

  const addColumnRow = () => {
    setColumns([...columns, { excelCol: '', systemField: '' }]);
  };

  const updateColumnRow = (index: number, field: 'excelCol' | 'systemField', value: string) => {
    const newCols = [...columns];
    newCols[index][field] = value;
    setColumns(newCols);
  };

  const removeColumnRow = (index: number) => {
    setColumns(columns.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    
    if (!name.trim()) {
      setFormError('Şablon adı zorunludur');
      return;
    }
    
    // Filter out empty rows
    const validColumns = columns.filter(c => c.excelCol.trim() && c.systemField.trim());
    if (validColumns.length === 0) {
      setFormError('En az bir geçerli sütun eşlemesi yapın');
      return;
    }

    const colMap: Record<string, string> = {};
    validColumns.forEach(c => {
      colMap[c.excelCol.trim()] = c.systemField.trim();
    });

    if (!idStrategyValue.trim()) {
      setFormError('Benzersiz ID stratejisi için değer girmelisiniz');
      return;
    }

    let unique_id_config: any = {};
    if (idStrategyType === 'COLUMN') {
      const val = idStrategyValue.trim();
      let systemField = colMap[val];
      if (!systemField && Object.values(colMap).includes(val)) {
        systemField = val;
      }
      
      if (!systemField) {
        setFormError(`Unique ID değeri eşleştirmelerde bulunamadı: ${val}`);
        return;
      }
      unique_id_config.column = systemField;
    } else {
      const vals = idStrategyValue.split(',').map(s => s.trim()).filter(s => s);
      const systemFields = [];
      for (const val of vals) {
        let sysField = colMap[val];
        if (!sysField && Object.values(colMap).includes(val)) {
          sysField = val;
        }
        if (!sysField) {
          setFormError(`Unique ID Hash değeri eşleştirmelerde bulunamadı: ${val}`);
          return;
        }
        systemFields.push(sysField);
      }
      unique_id_config.columns = systemFields;
    }

    try {
      setIsSaving(true);
      const payload = {
        name: name.trim(),
        column_map: colMap,
        unique_id_strategy: idStrategyType,
        unique_id_config: unique_id_config
      };
      
      await api.post('/mapping-templates/', payload);
      await fetchTemplates();
      closeModal();
    } catch (err: any) {
      setFormError(err.response?.data?.detail || 'Şablon kaydedilemedi');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto animate-fade-in relative h-full">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Eşleme Şablonları</h1>
          <p className="text-surface-400 text-sm mt-1">
            Excel dosyalarını dışa / içe aktarırken kullanılacak sütun şablonları
          </p>
        </div>
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {templates.length === 0 ? (
            <div className="col-span-full glass-card p-12 text-center text-surface-400">
              Henüz bir şablon oluşturulmamış. Excel Yükle ekranından yeni şablon oluşturabilirsiniz.
            </div>
          ) : (
            templates.map((template) => (
              <div key={template.id} className="glass-card p-6 flex flex-col items-start hover:border-surface-600 transition-all">
                <div className="w-full flex items-start justify-between mb-4">
                  <h3 className="text-lg font-semibold text-white">{template.name}</h3>
                  {canEdit && (
                    <button onClick={() => handleDelete(template.id)} className="text-surface-500 hover:text-red-400 transition-colors">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
                
                <div className="mb-4">
                  <span className="badge badge-info mb-2">
                    {template.unique_id_strategy === 'COLUMN' 
                      ? 'Tekil Kolon: ' + (Object.keys(template.column_map || {}).find(k => template.column_map[k] === template.unique_id_config?.column) || template.unique_id_config?.column) 
                      : 'Çoklu Hash: ' + template.unique_id_config?.columns?.map(c => Object.keys(template.column_map || {}).find(k => template.column_map[k] === c) || c).join(', ')}
                  </span>
                </div>
                
                <div className="w-full mt-auto">
                  <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-widest mb-2">Sütun Eşlemeleri ({Object.keys(template.column_map || {}).length})</h4>
                  <div className="bg-surface-800/50 rounded-lg p-3 text-sm max-h-32 overflow-auto">
                    {Object.entries(template.column_map || {}).map(([excel, sys]) => (
                      <div key={excel} className="flex justify-between py-1 border-b border-surface-700/50 last:border-0 text-surface-300">
                        <span className="truncate pr-2" title={excel}>{excel}</span>
                        <span className="text-primary-400 font-medium whitespace-nowrap">➔ {sys}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* CREATE MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface-950/80 backdrop-blur-sm animate-fade-in pr-6">
          <div className="glass-card w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col border border-surface-600 bg-surface-900 shadow-xl rounded-2xl relative">
            <div className="p-6 border-b border-surface-700/50 flex justify-between items-center">
              <h2 className="text-xl font-bold text-white">Yeni Şablon Ekle</h2>
              <button title="Kapat" onClick={closeModal} className="text-surface-500 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 overflow-auto" style={{ flex: 1 }}>
              {formError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-6">
                  {formError}
                </div>
              )}
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-surface-300 mb-1.5">Şablon Adı</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input-field"
                  placeholder="Örn: Müşteri A Şablonu"
                  required
                />
              </div>

              <div className="mb-6 bg-surface-800/30 p-4 rounded-xl border border-surface-700/50">
                <h3 className="text-sm font-bold text-surface-200 mb-3">Unique ID (Benzersiz Kimlik) Stratejisi</h3>
                <p className="text-xs text-surface-400 mb-4">Siparişleri birbirleri ile eşleştirebilmek için hangi sütunun benzersiz olduğunu seçin.</p>
                <div className="flex gap-4 mb-4">
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-surface-300 hover:text-white">
                    <input type="radio" className="accent-primary-500" checked={idStrategyType === 'COLUMN'} onChange={() => setIdStrategyType('COLUMN')} />
                    <span>Tekil Sütun Kullan (Örn: Sipariş No)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-surface-300 hover:text-white">
                    <input type="radio" className="accent-primary-500" checked={idStrategyType === 'HASH'} onChange={() => setIdStrategyType('HASH')} />
                    <span>Çoklu Sütun Hash Kullan</span>
                  </label>
                </div>
                <div>
                  <input
                    type="text"
                    value={idStrategyValue}
                    onChange={(e) => setIdStrategyValue(e.target.value)}
                    className="input-field max-w-md"
                    placeholder={idStrategyType === 'COLUMN' ? 'Excel\'deki Sütun Adı' : 'Sütun1, Sütun2, Sütun3'}
                    required
                  />
                  {idStrategyType === 'HASH' && <p className="text-xs text-surface-500 mt-1">Sütun adlarını virgül ile ayırarak yazın.</p>}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-surface-200">Sütun Eşleştirmeleri</h3>
                  <button type="button" onClick={addColumnRow} className="text-xs btn-ghost py-1 px-3">
                    + Satır Ekle
                  </button>
                </div>
                
                <div className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center mb-2 px-2 text-xs font-semibold text-surface-500 uppercase">
                  <div>Excel Sütunu</div>
                  <div></div>
                  <div>Sistemdeki Alan</div>
                  <div></div>
                </div>
                
                <div className="space-y-2">
                  {columns.map((col, idx) => (
                    <div key={idx} className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
                      <input
                        type="text"
                        value={col.excelCol}
                        onChange={(e) => updateColumnRow(idx, 'excelCol', e.target.value)}
                        className="input-field py-1.5 text-sm"
                        placeholder="Örn: Urun Adi"
                      />
                      <span className="text-surface-500">➔</span>
                      <input
                        type="text"
                        list="system-field-suggestions"
                        value={col.systemField}
                        onChange={(e) => updateColumnRow(idx, 'systemField', e.target.value)}
                        className="input-field py-1.5 text-sm"
                        placeholder="Örn: product_name"
                      />
                      <button
                        type="button"
                        onClick={() => removeColumnRow(idx)}
                        disabled={columns.length === 1}
                        className="p-1.5 text-surface-500 hover:text-red-400 disabled:opacity-30 transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
                {/* Datalist for system field suggestions */}
                <datalist id="system-field-suggestions">
                  <option value="product_name" />
                  <option value="product_code" />
                  <option value="quantity" />
                  <option value="date" />
                  <option value="start_date" />
                  <option value="customer_name" />
                  <option value="responsible_personnel" />
                  <option value="external_id" />
                  <option value="order_no" />
                  <option value="is_outsourced" />
                  <option value="production_mode" />
                  <option value="production_type" />
                  {/* Sipariş tarihleri (start_date/delivery_date'ten AYRI — üretim zamanlamasını değil, sipariş metadata'sını besler) */}
                  <option value="order_date" />
                  <option value="promised_date" />
                  <option value="requirement_date" />
                  <option value="penalty_date" />
                  {/* Yeni ürün parametreleri */}
                  <option value="supply_days" />
                  <option value="assembly_days" />
                  <option value="outsource_days" />
                  <option value="epoxy_minutes" />
                  <option value="conformal_minutes" />
                  <option value="montaj_minutes" />
                  <option value="quality_minutes" />
                  <option value="montaj_kalite_minutes" />
                  <option value="test1_minutes" />
                  <option value="test2_minutes" />
                  <option value="final_test_minutes" />
                  <option value="delivery_days" />
                  <option value="production_days" />
                  <option value="duration_mode" />
                  <option value="production_flat_days" />
                  <option value="test_flat_days" />
                  <option value="assembly_flat_days" />
                </datalist>
                <div className="mt-2 text-xs text-surface-500">
                  <p>Not: <code className="text-primary-400">quantity</code> ve <code className="text-primary-400">date</code> gibi önemli alanların mutlaka sistemde karşılığı olmalıdır.</p>
                  <p className="mt-1">Uretim tipi icin: <code className="text-orange-400">is_outsourced</code> (E/H, 1/0) veya <code className="text-orange-400">production_mode</code> / <code className="text-orange-400">production_type</code> (Ic/Fason) kullanabilirsiniz. Fason siparişlerde Dizgi süresi yerine <code className="text-orange-400">outsource_days</code> kullanılır.</p>
                  <p className="mt-1">Ürün planlaması: <code className="text-amber-400">supply_days</code> (tedarik/gün), <code className="text-amber-400">assembly_days</code> (dizgi/gün-adet), <code className="text-amber-400">epoxy_minutes/conformal_minutes/montaj_minutes/quality_minutes/montaj_kalite_minutes/test1_minutes/test2_minutes/final_test_minutes</code> (dk/adet), <code className="text-amber-400">delivery_days</code> (teslimat/gün), <code className="text-blue-400">production_days</code> (üretim). Excel'de boş bırakılan alanlar ürün master verilerinden otomatik doldurulur.</p>
                  <p className="mt-1">
                    <code className="text-rose-400">start_date</code>/<code className="text-rose-400">date</code> ile <code className="text-rose-400">delivery_date</code>/<code className="text-rose-400">end_date</code>, ÜRETİM ZAMANLAMASINI (Gantt'taki parça penceresini) besler.
                    Sipariş kartındaki "Sipariş Tarihi"/"Söz Verilen Tarih" alanları AYRI ve isteğe bağlıdır — bunlar için <code className="text-rose-400">order_date</code> / <code className="text-rose-400">promised_date</code> sütunlarını eşleyebilirsiniz.
                    Eşlemezseniz, yeni eklenen siparişlerde Sipariş Tarihi üretim başlangıç tarihinden, Söz Verilen Tarih ise teslimat tarihinden otomatik türetilir; mevcut bir siparişi güncellerken ise (eşleme yoksa) bu iki alana dokunulmaz.
                  </p>
                </div>
              </div>

            </form>
            
            <div className="p-4 border-t border-surface-700/50 bg-surface-900 flex justify-end gap-3 rounded-b-2xl">
              <button type="button" onClick={closeModal} className="btn-ghost">
                İptal
              </button>
              <button onClick={handleSubmit} disabled={isSaving} className="btn-primary">
                {isSaving ? 'Kaydediliyor...' : 'Şablonu Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
