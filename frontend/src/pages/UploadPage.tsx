/**
 * Excel Upload page — drag-and-drop file upload with diff preview.
 */

import { useState, useCallback, useEffect, useMemo, type DragEvent, type ChangeEvent, type FormEvent } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

interface DiffResult {
  add: Array<{ external_id: string; data: Record<string, unknown>; base_data: Record<string, unknown>; row_index: number; warnings?: string[]; errors?: string[] }>;
  remove: Array<{ external_id: string; order_id: string; status: string; base_data: Record<string, unknown> }>;
  update: Array<{ external_id: string; order_id: string; changes: Array<{ field: string; old_value: unknown; new_value: unknown }>; warnings?: string[]; errors?: string[] }>;
  unchanged: number;
  summary: { total_add: number; total_remove: number; total_update: number; total_unchanged: number };
  import_warnings?: string[];
  import_errors?: string[];
}

type DiffActionType = 'add' | 'remove' | 'update';

interface DiffApprovalItem {
  externalId: string;
  type: DiffActionType;
  title: string;
  details: string[];
}

interface ExcelPreview {
  header_mode: 'ROW' | 'COLUMN';
  header_row_index: number;
  candidate_columns: string[];
  sample_rows: Array<Record<string, unknown>>;
}

interface MappingTemplateLite {
  id: string;
  name: string;
  column_map: Record<string, string>;
  unique_id_strategy: 'COLUMN' | 'HASH';
  unique_id_config?: Record<string, unknown> | null;
}

type UploadStep = 'upload' | 'template' | 'diff' | 'uretim_plan' | 'done';

interface UretimPlanState {
  isUretimPlan: boolean;
  productCount: number;
  orderCount: number;
  calismaSaati: number;
}

const SYSTEM_FIELD_OPTIONS = [
  { value: 'siparis_no', label: 'Sipariş No' },
  { value: 'product_name', label: 'Ürün Tipi / Adı' },
  { value: 'quantity', label: 'Adet' },
  { value: 'order_date', label: 'Sipariş Tarihi' },
  { value: 'promised_date', label: 'Söz Verilen Tarih' },
  { value: 'requirement_date', label: 'Gereksinim Tarihi' },
  { value: 'penalty_date', label: 'Cezaya Konu Tarihi' },
  { value: 'order_responsible', label: 'Sipariş Sorumlusu' },
  { value: 'product_code', label: 'Ürün Kodu' },
  { value: 'supply_days', label: 'Tedarik (Gün)' },
  { value: 'assembly_days', label: 'Dizgi (Gün/Adet)' },
  { value: 'outsource_days', label: 'Fason Süresi (Gün)' },
  { value: 'epoxy_minutes', label: 'Epoxy (Dk/Adet)' },
  { value: 'conformal_minutes', label: 'Conformal (Dk/Adet)' },
  { value: 'montaj_minutes', label: 'Montaj (Dk/Adet)' },
  { value: 'quality_minutes', label: 'Kalite (Dk/Adet)' },
  { value: 'montaj_kalite_minutes', label: 'M.Kalite (Dk/Adet)' },
  { value: 'test1_minutes', label: 'Test1 (Dk/Adet)' },
  { value: 'test2_minutes', label: 'Test2 (Dk/Adet)' },
  { value: 'final_test_minutes', label: 'F.Test (Dk/Adet)' },
  { value: 'delivery_days', label: 'Teslimat (Gün)' },
  { value: 'production_days', label: 'Üretim (Gün)' },
  { value: 'duration_mode', label: 'Süre Modu (Adet Başına/Gün)' },
  { value: 'production_flat_days', label: 'Üretim Toplam Gün (Gün modu)' },
  { value: 'test_flat_days', label: 'Test Toplam Gün (Gün modu)' },
  { value: 'assembly_flat_days', label: 'Dizgi Toplam Gün (Gün modu)' },
  { value: 'start_date', label: 'Başlangıç Tarihi' },
  { value: 'end_date', label: 'Bitiş Tarihi' },
  { value: 'description', label: 'Açıklama' },
  { value: 'customer', label: 'Müşteri' },
  { value: 'is_outsourced', label: 'Fason Mu? (E/H, 1/0)' },
  { value: 'note', label: 'Not' },
];

const FIELD_LABEL_MAP: Record<string, string> = {
  quantity: 'adet',
  product_code: 'ürün kodu',
  supply_days: 'tedarik süresi',
  assembly_days: 'dizgi süresi',
  outsource_days: 'fason süresi',
  duration_mode: 'süre modu',
  production_flat_days: 'üretim toplam gün',
  test_flat_days: 'test toplam gün',
  assembly_flat_days: 'dizgi toplam gün',
  epoxy_minutes: 'epoxy süresi (dk)',
  conformal_minutes: 'conformal süresi (dk)',
  montaj_minutes: 'montaj süresi (dk)',
  quality_minutes: 'kalite süresi (dk)',
  montaj_kalite_minutes: 'm.kalite süresi (dk)',
  test1_minutes: 'test1 süresi (dk)',
  test2_minutes: 'test2 süresi (dk)',
  final_test_minutes: 'final test süresi (dk)',
  delivery_days: 'teslimat süresi',
  production_days: 'üretim süresi',
  start_date: 'başlangıç tarihi',
  end_date: 'bitiş tarihi',
  delivery_date: 'teslimat tarihi',
  product_name: 'ürün adı',
  siparis_no: 'sipariş no',
  order_date: 'sipariş tarihi',
  promised_date: 'söz verilen tarih',
  requirement_date: 'gereksinim tarihi',
  penalty_date: 'cezaya konu tarihi',
  order_responsible: 'sipariş sorumlusu',
  customer: 'müşteri',
  description: 'açıklama',
  is_outsourced: 'fason durumu',
};

const toReadableValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
};

const toActionText = (field: string) => {
  const normalized = String(field || '').toLowerCase();
  return FIELD_LABEL_MAP[normalized] || field;
};

export default function UploadPage() {
  const { user } = useAuth();
  // Backend (excel.py) upload/diff/apply/template-create için ADMIN/PLANNER rolü
  // zorunlu kılıyor — bu sayfanın nav'da VIEWER'a da açık olması (bkz. Layout.tsx,
  // /upload için roles kısıtlaması yok) VIEWER kullanıcıların tüm sihirbazı görüp
  // her adımda "yetkiniz yok" hatası almasına yol açıyordu (purchasing.py'deki
  // AYNI sınıf sorun — bkz. ilgili düzeltme). Sihirbazın tamamı yerine tek, net
  // bir "düzenleme yetkiniz yok" mesajı gösterilir.
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  const [step, setStep] = useState<UploadStep>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<MappingTemplateLite[]>([]);
  const [matchedTemplateId, setMatchedTemplateId] = useState('');
  const [createdTemplateId, setCreatedTemplateId] = useState('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [selectedExternalIds, setSelectedExternalIds] = useState<Set<string>>(new Set());
  const [uretimPlanState, setUretimPlanState] = useState<UretimPlanState | null>(null);
  const [excelGenerated, setExcelGenerated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [importSuccessMsg, setImportSuccessMsg] = useState('');
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);

  // Step-2 inline template creation state (simplified UX)
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [createTemplateError, setCreateTemplateError] = useState('');
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newColumns, setNewColumns] = useState<Array<{ excelCol: string; systemField: string }>>([
    { excelCol: '', systemField: '' },
  ]);
  const [headerMode, setHeaderMode] = useState<'ROW' | 'COLUMN'>('ROW');
  const [headerRowIndex, setHeaderRowIndex] = useState(1);
  const [excelPreview, setExcelPreview] = useState<ExcelPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [newIdStrategyType, setNewIdStrategyType] = useState<'COLUMN' | 'HASH'>('COLUMN');
  const [newIdColumn, setNewIdColumn] = useState('');
  const [newHashColumns, setNewHashColumns] = useState<string[]>([]);

  // Fetch templates on mount
  const fetchTemplates = useCallback(async () => {
    try {
      const { data } = await api.get<MappingTemplateLite[]>('/mapping-templates/');
      setTemplates(data);
      return data;
    } catch {
      setError('Şablonlar yüklenemedi');
      return [] as MappingTemplateLite[];
    }
  }, []);

  const normalizeHeaderName = useCallback((value: string) =>
    String(value || '')
      .toLocaleLowerCase('tr-TR')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ''), []);

  const detectMatchingTemplate = useCallback((allTemplates: MappingTemplateLite[], preview: ExcelPreview | null) => {
    if (!preview || preview.candidate_columns.length === 0) return '';

    const previewSet = new Set(preview.candidate_columns.map((col) => normalizeHeaderName(col)));

    const matched = allTemplates.find((tpl) => {
      const requiredExcelCols = Object.keys(tpl.column_map || {});
      if (requiredExcelCols.length === 0) return false;
      return requiredExcelCols.every((col) => previewSet.has(normalizeHeaderName(col)));
    });

    return matched?.id || '';
  }, [normalizeHeaderName]);

  const resetCreateTemplateForm = useCallback(() => {
    setCreateTemplateError('');
    setNewTemplateName('');
    setNewColumns([{ excelCol: '', systemField: '' }]);
    setHeaderMode('ROW');
    setHeaderRowIndex(1);
    setExcelPreview(null);
    setNewIdStrategyType('COLUMN');
    setNewIdColumn('');
    setNewHashColumns([]);
  }, []);

  const fetchExcelPreview = useCallback(async () => {
    if (!fileKey) return;
    setIsLoadingPreview(true);
    setCreateTemplateError('');
    try {
      const { data } = await api.get<ExcelPreview>(
        `/excel/preview?file_key=${encodeURIComponent(fileKey)}&header_mode=${headerMode}&header_row_index=${headerRowIndex}`,
      );
      setExcelPreview(data);
      if (data.candidate_columns.length > 0) {
        setNewColumns((prev) =>
          prev.map((row) => ({
            ...row,
            excelCol: row.excelCol && data.candidate_columns.includes(row.excelCol)
              ? row.excelCol
              : '',
          })),
        );
      }
      setNewIdColumn('');
      setNewHashColumns([]);
    } catch {
      setCreateTemplateError('Dosya önizlemesi alınamadı. Başlık seçimini kontrol edin.');
      setExcelPreview(null);
    } finally {
      setIsLoadingPreview(false);
    }
  }, [fileKey, headerMode, headerRowIndex]);

  useEffect(() => {
    if (step === 'template' && showCreateTemplate && fileKey) {
      fetchExcelPreview();
    }
  }, [step, showCreateTemplate, fileKey, fetchExcelPreview]);

  // Handle file selection
  const handleFile = (f: File) => {
    if (!f.name.endsWith('.xlsx')) {
      setError('Sadece .xlsx dosyaları kabul edilir');
      return;
    }
    setFile(f);
    setError('');
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) handleFile(e.target.files[0]);
  };

  // Upload file to MinIO
  const handleUpload = async () => {
    if (!file) return;
    setIsLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const { data } = await api.post('/excel/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const uploadedFileKey = data.file_key as string;
      setFileKey(uploadedFileKey);

      if (data.is_uretim_plan) {
        setUretimPlanState({
          isUretimPlan: true,
          productCount: data.product_count || 0,
          orderCount: data.order_count || 0,
          calismaSaati: data.calisma_saati || 8,
        });
        setStep('uretim_plan');
        return;
      }

      const loadedTemplates = await fetchTemplates();
      try {
        const previewResp = await api.get<ExcelPreview>(
          `/excel/preview?file_key=${encodeURIComponent(uploadedFileKey)}&header_mode=ROW&header_row_index=1`,
        );
        setExcelPreview(previewResp.data);
        const matchId = detectMatchingTemplate(loadedTemplates, previewResp.data);
        setMatchedTemplateId(matchId);
        if (matchId) {
          setTemplateId(matchId);
        }
      } catch {
        setExcelPreview(null);
        setMatchedTemplateId('');
      }

      setStep('template');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Dosya yükleme başarısız';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const runDiffForTemplate = useCallback(async (selectedTemplateId: string) => {
    if (!selectedTemplateId) {
      setError('Lütfen bir şablon seçin');
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const { data } = await api.post(`/excel/diff?file_key=${encodeURIComponent(fileKey)}&template_id=${selectedTemplateId}`);
      setDiff(data);
      setStep('diff');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Diff oluşturulamadı';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [fileKey]);

  // Generate diff
  const handleDiff = async () => {
    await runDiffForTemplate(templateId);
  };

  const addNewColumnRow = () => {
    setNewColumns((prev) => [...prev, { excelCol: '', systemField: '' }]);
  };

  const updateNewColumnRow = (index: number, field: 'excelCol' | 'systemField', value: string) => {
    setNewColumns((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const removeNewColumnRow = (index: number) => {
    setNewColumns((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleHashColumn = (excelColumn: string) => {
    setNewHashColumns((prev) =>
      prev.includes(excelColumn)
        ? prev.filter((c) => c !== excelColumn)
        : [...prev, excelColumn],
    );
  };

  const handleCreateTemplate = async (e: FormEvent) => {
    e.preventDefault();
    setCreateTemplateError('');

    if (!newTemplateName.trim()) {
      setCreateTemplateError('Şablon adı zorunludur.');
      return;
    }

    const validRows = newColumns
      .map((row) => ({ excelCol: row.excelCol.trim(), systemField: row.systemField.trim() }))
      .filter((row) => row.excelCol && row.systemField);

    if (validRows.length === 0) {
      setCreateTemplateError('En az bir sütun eşlemesi girin.');
      return;
    }

    const colMap: Record<string, string> = {};
    validRows.forEach((row) => {
      colMap[row.excelCol] = row.systemField;
    });

    // Validate required fields in template
    const mappedFields = new Set(Object.values(colMap));
    const requiredFields: Array<{ field: string; label: string }> = [
      { field: 'product_name', label: 'Ürün adı (product_name)' },
      { field: 'quantity', label: 'Adet (quantity)' },
      { field: 'supply_days', label: 'Tedarik (gün) (supply_days)' },
      { field: 'assembly_days', label: 'Dizgi (gün/adet) (assembly_days)' },
      { field: 'delivery_days', label: 'Teslimat (gün) (delivery_days)' },
    ];
    const missingDate =
      !mappedFields.has('start_date') && !mappedFields.has('end_date') && !mappedFields.has('date');
    const missingFields = requiredFields
      .filter(({ field }) => !mappedFields.has(field))
      .map(({ label }) => label);
    const allMissing = [
      ...(missingDate ? ['Başlangıç tarihi (start_date) veya bitiş tarihi (end_date)'] : []),
      ...missingFields,
    ];
    if (allMissing.length > 0) {
      const lines = allMissing.map((m) => `• ${m} eşleştirmesi zorunludur.`).join('\n');
      setCreateTemplateError(`Eksik zorunlu alanlar:\n${lines}`);
      return;
    }

    const parse_options = {
      header_mode: headerMode,
      header_row_index: headerRowIndex,
    };

    let unique_id_config: Record<string, unknown> = { parse_options };
    if (newIdStrategyType === 'COLUMN') {
      if (!newIdColumn) {
        setCreateTemplateError('Lütfen tekil sütunu seçin.');
        return;
      }
      const mappedSystemField = colMap[newIdColumn];
      if (!mappedSystemField) {
        setCreateTemplateError('Seçilen tekil sütun eşleme satırlarında bulunamadı.');
        return;
      }
      unique_id_config = { column: mappedSystemField, parse_options };
    } else {
      if (newHashColumns.length < 2) {
        setCreateTemplateError('Çoklu kullanım için en az 2 sütun seçin.');
        return;
      }
      const mappedSystemFields = newHashColumns
        .map((excelCol) => colMap[excelCol])
        .filter(Boolean);
      if (mappedSystemFields.length !== newHashColumns.length) {
        setCreateTemplateError('Hash için seçilen sütunların hepsi eşleme listesinde olmalı.');
        return;
      }
      unique_id_config = { columns: mappedSystemFields, parse_options };
    }

    try {
      setIsSavingTemplate(true);
      const { data } = await api.post('/mapping-templates/', {
        name: newTemplateName.trim(),
        column_map: colMap,
        unique_id_strategy: newIdStrategyType,
        unique_id_config,
      });

      await fetchTemplates();
      setTemplateId(data.id);
      setCreatedTemplateId(data.id);
      setMatchedTemplateId('');
      setShowCreateTemplate(false);
      resetCreateTemplateForm();
      await runDiffForTemplate(data.id);
    } catch (err: any) {
      setCreateTemplateError(err?.response?.data?.detail || 'Şablon kaydedilemedi.');
    } finally {
      setIsSavingTemplate(false);
    }
  };

  // Apply diff
  const handleApply = async () => {
    if (!diff) return;

    const allExternalIds = [
      ...diff.add.map((x) => x.external_id),
      ...diff.remove.map((x) => x.external_id),
      ...diff.update.map((x) => x.external_id),
    ];

    const excludeExternalIds = allExternalIds.filter((id) => !selectedExternalIds.has(id));
    const approvedCount = allExternalIds.length - excludeExternalIds.length;

    if (approvedCount <= 0) {
      setError('Uygulamak için en az bir değişiklik seçin.');
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const { data } = await api.post(`/excel/apply?file_key=${encodeURIComponent(fileKey)}`, {
        apply_adds: true,
        apply_removes: true,
        apply_updates: true,
        exclude_external_ids: excludeExternalIds,
      });
      setSuccessMsg(data.message);
      setStep('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Uygulama başarısız';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // Export filled SIPARIS_PLAN
  const handleExportSiparisPlan = async () => {
    if (!file) return;
    setIsLoading(true);
    setError('');
    setExportWarnings([]);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await api.post('/excel/export-siparis-plan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const data = response.data;

      // Decode base64 to blob and download
      const binaryStr = atob(data.file_base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', data.file_name || 'siparis_plan_dolu.xlsx');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      // Show warnings if any
      if (data.warnings && data.warnings.length > 0) {
        setExportWarnings(data.warnings);
      }

      setExcelGenerated(true);
      setSuccessMsg('Excel dosyası oluşturuldu. Lütfen inceleyin, sonra onaylayın.');
    } catch (err: unknown) {
      const axiosErr = err as any;
      if (axiosErr?.response?.data instanceof Blob) {
        try {
          const text = await axiosErr.response.data.text();
          const json = JSON.parse(text);
          setError(json.detail || axiosErr.message);
        } catch {
          setError(axiosErr.message || 'Sipariş planı dışa aktarılamadı');
        }
      } else {
        const detail = axiosErr?.response?.data?.detail;
        setError(detail || axiosErr.message || 'Sipariş planı dışa aktarılamadı');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Confirm and save to DB (after user reviews the downloaded Excel)
  const handleConfirmSiparisPlan = async () => {
    if (!file) return;
    setIsLoading(true);
    setError('');
    setImportSuccessMsg('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const { data } = await api.post('/excel/confirm-siparis-plan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setImportSuccessMsg(data.message || 'Veritabanına kaydedildi.');
      setExcelGenerated(false);
    } catch (err: unknown) {
      const detail = (err as any)?.response?.data?.detail;
      const msg = detail || (err instanceof Error ? err.message : 'Kaydetme başarısız');
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // Reset
  const handleReset = () => {
    setStep('upload');
    setFile(null);
    setFileKey('');
    setTemplateId('');
    setMatchedTemplateId('');
    setCreatedTemplateId('');
    setDiff(null);
    setError('');
    setSuccessMsg('');
    setShowCreateTemplate(false);
    resetCreateTemplateForm();
    setUretimPlanState(null);
    setExcelGenerated(false);
    setImportSuccessMsg('');
    setExportWarnings([]);
  };

  const availableMappedExcelColumns = newColumns
    .map((row) => row.excelCol.trim())
    .filter(Boolean);

  const selectableExcelColumns = excelPreview?.candidate_columns ?? [];

  const diffApprovalItems = useMemo<DiffApprovalItem[]>(() => {
    if (!diff) return [];

    const addItems = diff.add.map((entry) => {
      const quantity = toReadableValue(entry.data?.quantity);
      const date = toReadableValue(entry.data?.date ?? entry.data?.start_date ?? entry.base_data?.date ?? entry.base_data?.start_date);
      const details: string[] = [`Adet: ${quantity}`, `Tarih: ${date}`];
      if (entry.errors && entry.errors.length > 0) {
        entry.errors.forEach((e) => details.push(`🚫 ${e}`));
      }
      if (entry.warnings && entry.warnings.length > 0) {
        entry.warnings.forEach((w) => details.push(`⚠️ ${w}`));
      }
      return {
        externalId: entry.external_id,
        type: 'add' as const,
        title: `${entry.external_id} nolu ürün eklenecek`,
        details,
      };
    });

    const removeItems = diff.remove.map((entry) => ({
      externalId: entry.external_id,
      type: 'remove' as const,
      title: `${entry.external_id} nolu ürün kaldırılacak`,
      details: ['Bu ürün mevcut listeden çıkarılacak.'],
    }));

    const updateItems = diff.update.map((entry) => {
      const details = entry.changes.map((change) => {
        const fieldName = toActionText(change.field);
        return `${fieldName} değişecek: ${toReadableValue(change.old_value)} -> ${toReadableValue(change.new_value)}`;
      });
      if (entry.errors && entry.errors.length > 0) {
        entry.errors.forEach((e) => details.push(`🚫 ${e}`));
      }
      if (entry.warnings && entry.warnings.length > 0) {
        entry.warnings.forEach((w) => details.push(`⚠️ ${w}`));
      }
      return {
        externalId: entry.external_id,
        type: 'update' as const,
        title: `${entry.external_id} nolu ürün güncellenecek`,
        details,
      };
    });

    return [...addItems, ...updateItems, ...removeItems];
  }, [diff]);

  useEffect(() => {
    if (!diff) {
      setSelectedExternalIds(new Set());
      return;
    }

    const ids = new Set<string>([
      ...diff.add.map((x) => x.external_id),
      ...diff.remove.map((x) => x.external_id),
      ...diff.update.map((x) => x.external_id),
    ]);
    setSelectedExternalIds(ids);
  }, [diff]);

  const progressSteps = useMemo<UploadStep[]>(() => {
    if (uretimPlanState) return ['upload', 'uretim_plan', 'done'];
    return ['upload', 'template', 'diff', 'done'];
  }, [uretimPlanState]);

  const toggleExternalId = (externalId: string) => {
    setSelectedExternalIds((prev) => {
      const next = new Set(prev);
      if (next.has(externalId)) {
        next.delete(externalId);
      } else {
        next.add(externalId);
      }
      return next;
    });
  };

  const selectAllDiffItems = () => {
    const ids = new Set(diffApprovalItems.map((item) => item.externalId));
    setSelectedExternalIds(ids);
  };

  const clearAllDiffItems = () => {
    setSelectedExternalIds(new Set());
  };

  if (!canEdit) {
    return (
      <div className="p-6 max-w-4xl mx-auto animate-fade-in">
        <h1 className="text-2xl font-bold text-white mb-6">Excel Dosyası Yükle</h1>
        <div className="rounded-xl border border-surface-700/50 bg-surface-900/60 px-4 py-6 text-center text-surface-400">
          Salt görüntüleme — Excel yükleme/içe aktarma yalnızca ADMIN/PLANNER rolündeki kullanıcılar içindir.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto animate-fade-in">
      <h1 className="text-2xl font-bold text-white mb-6">Excel Dosyası Yükle</h1>

      {/* Progress steps */}
      <div className="flex items-center mb-8 gap-2">
        {progressSteps.map((s, i) => {
          const stepIndex = progressSteps.indexOf(step);
          return (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                step === s ? 'bg-primary-600 text-white shadow-glow' :
                stepIndex > i ? 'bg-emerald-600 text-white' :
                'bg-surface-800 text-surface-500'
              }`}>
                {stepIndex > i ? '✓' : i + 1}
              </div>
              {i < progressSteps.length - 1 && <div className={`w-12 h-0.5 ${stepIndex > i ? 'bg-emerald-600' : 'bg-surface-700'}`} />}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-6 animate-slide-up">
          {error}
        </div>
      )}

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <div
          className={`glass-card p-12 text-center transition-all duration-300 cursor-pointer
            ${isDragging ? 'border-primary-500 bg-primary-500/10 shadow-glow' : 'hover:border-surface-600'}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <input id="file-input" type="file" accept=".xlsx" className="hidden" onChange={handleFileInput} />
          <svg className="w-16 h-16 text-surface-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          {file ? (
            <div>
              <p className="text-white font-medium">{file.name}</p>
              <p className="text-surface-400 text-sm mt-1">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <div>
              <p className="text-surface-300 font-medium">
                Dosyayı sürükleyin veya tıklayın
              </p>
              <p className="text-surface-500 text-sm mt-1">Sadece .xlsx dosyaları</p>
            </div>
          )}
        </div>
      )}

      {/* Step 1 action */}
      {step === 'upload' && file && (
        <div className="mt-6 flex justify-end">
          <button onClick={handleUpload} disabled={isLoading} className="btn-primary">
            {isLoading ? 'Yükleniyor...' : 'Yükle ve Devam Et'}
          </button>
        </div>
      )}

      {/* Step 2: Select template */}
      {step === 'template' && (
        <div className="glass-card p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold text-white">Eşleme Şablonu Seç veya Oluştur</h3>
            <button
              type="button"
              className="btn-ghost py-1.5 px-3 text-sm"
              onClick={() => {
                setShowCreateTemplate((prev) => !prev);
                setCreateTemplateError('');
              }}
            >
              {showCreateTemplate ? 'Şablon Oluşturmayı Kapat' : '+ Yeni Şablon Oluştur'}
            </button>
          </div>

          {showCreateTemplate && (
            <form onSubmit={handleCreateTemplate} className="mb-6 bg-surface-900/50 border border-surface-700/60 rounded-xl p-4 space-y-4">
              {createTemplateError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-2 rounded-lg text-xs">
                  {createTemplateError}
                </div>
              )}

              <div>
                <label className="block text-sm text-surface-300 mb-1">Şablon Adı</label>
                <input
                  className="input-field"
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                  placeholder="Örn: Nisan Sipariş Şablonu"
                />
              </div>

              <div className="rounded-lg border border-surface-700/60 bg-surface-800/30 p-3 space-y-3">
                <p className="text-sm font-semibold text-surface-200">Excel başlıkları nerede?</p>
                <div className="space-y-2 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer text-surface-300">
                    <input
                      type="radio"
                      className="accent-primary-500"
                      checked={headerMode === 'ROW'}
                      onChange={() => setHeaderMode('ROW')}
                    />
                    İlk satır(lar) başlık bilgisi içeriyor
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-surface-300">
                    <input
                      type="radio"
                      className="accent-primary-500"
                      checked={headerMode === 'COLUMN'}
                      onChange={() => setHeaderMode('COLUMN')}
                    />
                    İlk sütun(lar) başlık bilgisi içeriyor
                  </label>
                </div>

                <div className="grid sm:grid-cols-[220px_auto] gap-3 items-end">
                  <div>
                    <label className="block text-xs text-surface-400 mb-1">Başlık başlangıç satırı</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      className="input-field"
                      value={headerRowIndex}
                      onChange={(e) => setHeaderRowIndex(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-ghost py-2 px-3 text-sm"
                    onClick={fetchExcelPreview}
                    disabled={isLoadingPreview}
                  >
                    {isLoadingPreview ? 'Önizleme alınıyor...' : 'Önizlemeyi Yenile'}
                  </button>
                </div>

                {excelPreview && (
                  <div className="text-xs text-surface-400">
                    {excelPreview.candidate_columns.length > 0
                      ? `${excelPreview.candidate_columns.length} alan bulundu. Eşleştirmeleri sadece listeden seçebilirsiniz.`
                      : 'Bu ayarlarda alan bulunamadı. Başlık yönünü/satırını değiştirip tekrar deneyin.'}
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-surface-700/60 bg-surface-800/30 p-3">
                <p className="text-sm font-semibold text-surface-200 mb-2">Siparişleri nasıl ayırt edelim?</p>
                <p className="text-xs text-surface-400 mb-3">Bu seçim, yüklediğiniz satırın daha önce var olup olmadığını bulmak için kullanılır.</p>

                <div className="space-y-2 text-sm">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      className="accent-primary-500 mt-0.5"
                      checked={newIdStrategyType === 'COLUMN'}
                      onChange={() => setNewIdStrategyType('COLUMN')}
                    />
                    <span className="text-surface-300">
                      <strong>Tek bir sütun kullan</strong>
                      <br />
                      Sipariş No gibi her satırda farklı olan tek alan varsa bunu seçin.
                    </span>
                  </label>

                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      className="accent-primary-500 mt-0.5"
                      checked={newIdStrategyType === 'HASH'}
                      onChange={() => setNewIdStrategyType('HASH')}
                    />
                    <span className="text-surface-300">
                      <strong>Birden fazla sütunu birlikte kullan</strong>
                      <br />
                      Tek sütun yetmiyorsa (ör. Sipariş No tekrar ediyorsa), Sipariş No + Ürün + Tarih gibi alanları birlikte seçin.
                    </span>
                  </label>
                </div>

                {newIdStrategyType === 'COLUMN' ? (
                  <div className="mt-3">
                    <label className="block text-xs text-surface-400 mb-1">Tekil olacak Excel sütunu</label>
                    <select
                      className="input-field"
                      value={newIdColumn}
                      onChange={(e) => setNewIdColumn(e.target.value)}
                    >
                      <option value="">Sütun seçin</option>
                      {availableMappedExcelColumns.map((col) => (
                        <option key={`single-${col}`} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="mt-3">
                    <label className="block text-xs text-surface-400 mb-1">Birlikte kullanılacak sütunlar</label>
                    <div className="grid sm:grid-cols-2 gap-2">
                      {availableMappedExcelColumns.length === 0 ? (
                        <div className="text-xs text-surface-500">Önce aşağıdan sütun eşlemesi girin.</div>
                      ) : (
                        availableMappedExcelColumns.map((col) => (
                          <label key={`hash-${col}`} className="flex items-center gap-2 text-sm text-surface-300">
                            <input
                              type="checkbox"
                              className="accent-primary-500"
                              checked={newHashColumns.includes(col)}
                              onChange={() => toggleHashColumn(col)}
                            />
                            {col}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-surface-200">Sütun Eşleştirmeleri</p>
                  <button type="button" className="btn-ghost py-1 px-2 text-xs" onClick={addNewColumnRow}>+ Satır Ekle</button>
                </div>
                <div className="space-y-2">
                  {newColumns.map((row, idx) => (
                    <div key={`new-col-${idx}`} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <select
                        className="input-field"
                        value={row.excelCol}
                        onChange={(e) => updateNewColumnRow(idx, 'excelCol', e.target.value)}
                      >
                        <option value="">Excel alanı seçin</option>
                        {selectableExcelColumns.map((col) => (
                          <option key={`excel-col-${idx}-${col}`} value={col}>{col}</option>
                        ))}
                      </select>
                      <select
                        className="input-field"
                        value={row.systemField}
                        onChange={(e) => updateNewColumnRow(idx, 'systemField', e.target.value)}
                      >
                        <option value="">Sistemde karşılığı</option>
                        {SYSTEM_FIELD_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label} ({opt.value})</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="text-surface-400 hover:text-red-400 p-2 disabled:opacity-30"
                        disabled={newColumns.length === 1}
                        onClick={() => removeNewColumnRow(idx)}
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost text-sm py-1.5 px-3" onClick={resetCreateTemplateForm}>Temizle</button>
                <button type="submit" className="btn-primary text-sm py-1.5 px-3" disabled={isSavingTemplate}>
                  {isSavingTemplate ? 'Kaydediliyor...' : 'Şablonu Kaydet ve Seç'}
                </button>
              </div>
            </form>
          )}

          {!!matchedTemplateId && matchedTemplateId !== createdTemplateId && (
            <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
              Eşleşen şablon bulundu. Sistem bu şablonu seçti, isterseniz farklı bir şablon seçebilir veya yeni şablon oluşturabilirsiniz.
            </div>
          )}

          {templates.length === 0 ? (
            <p className="text-surface-400">Henüz şablon yok. Yukarıdaki butonla bu ekrandan kolayca oluşturabilirsiniz.</p>
          ) : (
            <div className="space-y-2">
              {templates.map((t) => (
                <label
                  key={t.id}
                  className={`flex items-center gap-3 p-4 rounded-xl cursor-pointer transition-all ${
                    templateId === t.id
                      ? 'bg-primary-600/20 border border-primary-500/30'
                      : matchedTemplateId === t.id
                        ? 'bg-emerald-500/10 border border-emerald-500/40 hover:border-emerald-400/60'
                        : 'bg-surface-800/50 border border-surface-700/50 hover:border-surface-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    checked={templateId === t.id}
                    onChange={() => setTemplateId(t.id)}
                    className="accent-primary-500"
                  />
                  <div className="flex flex-col flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-surface-200 font-medium">{t.name}</span>
                      {matchedTemplateId === t.id && matchedTemplateId !== createdTemplateId && (
                        <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/30">
                          Önerilen
                        </span>
                      )}
                    </div>
                    
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                      {Object.entries(t.column_map || {}).map(([excelCol, sysField]) => (
                        <div key={excelCol} className="text-[10px] flex items-center gap-1.5 text-surface-400 bg-black/20 px-2 py-1 rounded border border-surface-700/20">
                          <span className="truncate max-w-[80px] font-semibold text-surface-300" title={excelCol}>{excelCol}</span>
                          <span className="text-surface-600">→</span>
                          <span className="truncate text-primary-400/80">{SYSTEM_FIELD_OPTIONS.find(o => o.value === sysField)?.label || sysField}</span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-2 flex items-center gap-3 text-[10px] text-surface-500 italic">
                      <span>Tekil Kimlik: {t.unique_id_strategy === 'COLUMN' ? 'Sütun Bazlı' : 'Çoklu Sütun (Hash)'}</span>
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
          <div className="mt-6 flex justify-end">
            <button onClick={handleDiff} disabled={isLoading || !templateId} className="btn-primary">
              {isLoading ? 'Karşılaştırılıyor...' : 'Karşılaştır'}
            </button>
          </div>
        </div>
      )}

      {/* Step: Uretim Plan (for uretim_Planlamadolu format) */}
      {step === 'uretim_plan' && uretimPlanState && (
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold text-white mb-2">Üretim Planlaması Dosyası</h3>
          <p className="text-surface-400 text-sm mb-4">
            Bu dosya bir "Üretim Planlaması" şablonu olarak tanındı.
          </p>

          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="stat-card">
              <span className="text-sm text-surface-400">Ürün</span>
              <span className="text-2xl font-bold text-primary-400">{uretimPlanState.productCount}</span>
              <span className="text-xs text-surface-500">URUN_SURE</span>
            </div>
            <div className="stat-card">
              <span className="text-sm text-surface-400">Sipariş</span>
              <span className="text-2xl font-bold text-primary-400">{uretimPlanState.orderCount}</span>
              <span className="text-xs text-surface-500">SIPARIS_PLAN</span>
            </div>
            <div className="stat-card">
              <span className="text-sm text-surface-400">Çalışma Saati</span>
              <span className="text-2xl font-bold text-primary-400">{uretimPlanState.calismaSaati}</span>
              <span className="text-xs text-surface-500">KAPASITE</span>
            </div>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
              {error}
            </div>
          )}

          {importSuccessMsg && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-4 py-3 rounded-xl text-sm mb-4">
              {importSuccessMsg}
            </div>
          )}

          {successMsg && !importSuccessMsg && (
            <div className="bg-primary-500/10 border border-primary-500/30 text-primary-400 px-4 py-3 rounded-xl text-sm mb-4">
              {successMsg}
            </div>
          )}

          {!excelGenerated && !importSuccessMsg && (
            <div className="flex items-center justify-between">
              <button onClick={() => { setStep('upload'); setUretimPlanState(null); setExcelGenerated(false); }} className="btn-ghost">Geri</button>
              <div className="flex gap-3">
                <button
                  onClick={handleExportSiparisPlan}
                  disabled={isLoading}
                  className="btn-ghost border border-primary-500/30 text-primary-300 hover:bg-primary-500/10"
                >
                  {isLoading ? 'Oluşturuluyor...' : 'Excel İmport Al'}
                </button>
                <button
                  onClick={handleConfirmSiparisPlan}
                  disabled={isLoading}
                  className="btn-primary"
                >
                  {isLoading ? 'Kaydediliyor...' : 'Sisteme Kaydet'}
                </button>
              </div>
            </div>
          )}

          {excelGenerated && !importSuccessMsg && (
            <div>
              {exportWarnings.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
                  <p className="text-amber-400 text-sm font-semibold mb-1">⚠️ Uyarılar</p>
                  <ul className="text-amber-300/80 text-xs space-y-1">
                    {exportWarnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="bg-surface-800/50 border border-surface-700/60 rounded-xl p-4 mb-4 text-center">
                <p className="text-surface-200 font-medium mb-2">Dosya oluşturuldu ve indirildi.</p>
                <p className="text-surface-400 text-sm">İncelediniz mi? Ürün bilgilerini ve siparişleri sisteme kaydedelim mi?</p>
              </div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => { setExcelGenerated(false); setSuccessMsg(''); setExportWarnings([]); }}
                  className="btn-ghost"
                >
                  İptal
                </button>
                <button
                  onClick={handleConfirmSiparisPlan}
                  disabled={isLoading}
                  className="btn-primary"
                >
                  {isLoading ? 'Kaydediliyor...' : 'Sisteme Kaydet'}
                </button>
              </div>
            </div>
          )}

          {importSuccessMsg && (
            <div className="flex justify-center">
              <button onClick={handleReset} className="btn-primary">Yeni Dosya Yükle</button>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Diff preview */}
      {step === 'diff' && diff && (
        <div className="space-y-6">
          {/* Global import errors */}
          {diff.import_errors && diff.import_errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm font-semibold mb-1">🚫 Kritik Hatalar — Bu kayıtlar atlanacak</p>
              <ul className="text-red-300/80 text-xs space-y-1">
                {[...new Set(diff.import_errors)].map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Global import warnings */}
          {diff.import_warnings && diff.import_warnings.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
              <p className="text-amber-400 text-sm font-semibold mb-1">⚠️ Uyarılar</p>
              <ul className="text-amber-300/80 text-xs space-y-1">
                {[...new Set(diff.import_warnings)].map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="stat-card">
              <span className="text-sm text-surface-400">Yeni</span>
              <span className="text-2xl font-bold text-emerald-400">+{diff.summary.total_add}</span>
            </div>
            <div className="stat-card">
              <span className="text-sm text-surface-400">Silinen</span>
              <span className="text-2xl font-bold text-red-400">−{diff.summary.total_remove}</span>
            </div>
            <div className="stat-card">
              <span className="text-sm text-surface-400">Güncellenen</span>
              <span className="text-2xl font-bold text-amber-400">~{diff.summary.total_update}</span>
            </div>
            <div className="stat-card">
              <span className="text-sm text-surface-400">Değişmemiş</span>
              <span className="text-2xl font-bold text-surface-400">{diff.summary.total_unchanged}</span>
            </div>
          </div>

          <div className="glass-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="text-sm text-surface-300">
                Değişiklikleri tek tek onaylayın. Seçili: <span className="text-white font-semibold">{selectedExternalIds.size}</span> / {diffApprovalItems.length}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={selectAllDiffItems} className="btn-ghost text-xs py-1.5 px-3">Hepsini Seç</button>
                <button type="button" onClick={clearAllDiffItems} className="btn-ghost text-xs py-1.5 px-3">Seçimi Temizle</button>
              </div>
            </div>

            {diffApprovalItems.length === 0 ? (
              <div className="text-sm text-surface-400">Onay bekleyen değişiklik bulunamadı.</div>
            ) : (
              <div className="space-y-3 max-h-[420px] overflow-auto pr-1">
                {diffApprovalItems.map((item) => {
                  const selected = selectedExternalIds.has(item.externalId);
                  const badgeClass =
                    item.type === 'add'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                      : item.type === 'remove'
                        ? 'bg-red-500/20 text-red-300 border-red-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30';
                  const stateTextClass = selected ? 'text-emerald-300' : 'text-red-300 line-through';

                  return (
                    <label
                      key={`${item.type}-${item.externalId}`}
                      className={`block rounded-xl border p-3 cursor-pointer transition-colors ${selected ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-red-500/40 bg-red-500/10 hover:border-red-400/60'}`}
                    >
                      <div className="flex items-start gap-3 justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[11px] uppercase tracking-wider border rounded-full px-2 py-0.5 ${badgeClass}`}>
                              {item.type === 'add' ? 'Ekle' : item.type === 'remove' ? 'Kaldır' : 'Güncelle'}
                            </span>
                            <span className={`font-medium break-all ${stateTextClass}`}>{item.title}</span>
                          </div>
                          <div className="space-y-1">
                            {item.details.map((detail, idx) => (
                              <div key={`${item.externalId}-${idx}`} className={`text-xs ${detail.startsWith('🚫') ? 'text-red-400' : stateTextClass}`}>- {detail}</div>
                            ))}
                          </div>
                        </div>
                        <input
                          type="checkbox"
                          className="mt-1 h-5 w-5 accent-emerald-500 rounded border-2 border-surface-300"
                          checked={selected}
                          onChange={() => toggleExternalId(item.externalId)}
                        />
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-3">
            <button onClick={handleReset} className="btn-ghost">İptal</button>
            <button onClick={handleApply} disabled={isLoading} className="btn-primary">
              {isLoading ? 'Uygulanıyor...' : 'Değişiklikleri Uygula'}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Done */}
      {step === 'done' && (
        <div className="glass-card p-8 text-center">
          <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-white text-lg font-semibold mb-2">İşlem Tamamlandı!</p>
          <p className="text-surface-400 mb-6">{successMsg}</p>
          <button onClick={handleReset} className="btn-primary">Yeni Dosya Yükle</button>
        </div>
      )}
    </div>
  );
}
