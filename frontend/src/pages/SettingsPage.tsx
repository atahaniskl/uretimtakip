import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';

interface StepAssignment {
  order_id: string;
  split_id: string | null;
  order_name: string;
  order_number: string;
  delivery_date: string | null;
  quantity: number | null;
  split_quantity: number | null;
  split_start_date: string | null;
  split_end_date: string | null;
  has_multiple_splits: boolean;
  supply_days: number | null;
  assembly_days: number | null;
  quality_minutes: number | null;
  epoxy_minutes: number | null;
  conformal_minutes: number | null;
  montaj_minutes: number | null;
  montaj_kalite_minutes: number | null;
  test1_minutes: number | null;
  test2_minutes: number | null;
  final_test_minutes: number | null;
  delivery_days: number | null;
  outsource_days: number | null;
  assembly: number;
  production: number;
  test: number;
  is_outsourced: boolean;
}

interface ConflictStep {
  order_id: string;
  order_name: string;
  order_number: string;
  step_key: string;
  stage_label: string;
  employees: number;
  quantity: number | null;
  delivery_date: string | null;
  stage_start: string;
  stage_end: string;
}

interface ConcurrencyConflict {
  date: string;
  total_employees: number;
  max_allowed: number;
  exceeds_by: number;
  steps: ConflictStep[];
  suggestion: string;
}

interface ConcurrencyReport {
  max_concurrent_employees: number;
  conflicts: ConcurrencyConflict[];
}

function parseDecimalInput(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return NaN;
  return Number(normalized);
}

function formatDecimalInput(value: number) {
  return String(value).replace('.', ',');
}

function splitEmployeeName(fullName: string) {
  const parts = fullName.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
}

function computeStepDays(
  a: StepAssignment,
  asmEmp: number,
  prodEmp: number,
  testEmp: number,
  workHours: number,
) {
  const qty = Math.max(1, a.quantity || 1);
  const workMin = workHours * 60;

  // Fason (dış dizgi): dizgi günü çalışanla hesaplanmaz; düz fason günü gösterilir.
  const assembly = a.is_outsourced
    ? (a.outsource_days ? Math.max(1, Math.round(a.outsource_days as number)) : null)
    : (a.assembly_days
        ? Math.ceil((a.assembly_days as number) * qty / asmEmp)
        : null);

  const prodMinutes = [
    a.quality_minutes, a.epoxy_minutes, a.conformal_minutes,
    a.montaj_minutes, a.montaj_kalite_minutes,
  ].filter((m): m is number => m != null);
  const production = prodMinutes.some(m => m > 0)
    ? prodMinutes.reduce((s, m) => s + Math.ceil(m * qty / (workMin * prodEmp)), 0)
    : null;

  const testMinutes = [a.test1_minutes, a.test2_minutes, a.final_test_minutes].filter((m): m is number => m != null);
  const test = testMinutes.some(m => m > 0)
    ? testMinutes.reduce((s, m) => s + Math.ceil(m * qty / (workMin * testEmp)), 0)
    : null;

  return { assembly, production, test };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';

  // ── Work Hours ──
  const [workHours, setWorkHours] = useState(8);
  const [workHoursInput, setWorkHoursInput] = useState('8');
  const [isUpdatingWorkHours, setIsUpdatingWorkHours] = useState(false);
  const workHoursDirty = useRef(false);

  // ── Max Concurrent Employees ──
  const [maxEmployees, setMaxEmployees] = useState(10);
  const [maxEmployeesInput, setMaxEmployeesInput] = useState('10');
  const [isUpdatingMaxEmp, setIsUpdatingMaxEmp] = useState(false);
  const maxEmpDirty = useRef(false);

  // ── Employee Names ──
  const [employeeNames, setEmployeeNames] = useState<string[]>([]);
  const [savedEmployeeNames, setSavedEmployeeNames] = useState<string[]>([]);
  const [isSavingEmployeeNames, setIsSavingEmployeeNames] = useState(false);
  const employeeNamesDirty = useRef(false);

  // ── Step Assignments ──
  const [assignments, setAssignments] = useState<StepAssignment[]>([]);

  // ── Concurrency Report ──
  const [report, setReport] = useState<ConcurrencyReport | null>(null);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());

  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  // ── Fetch work hours ──
  const fetchWorkHours = useCallback(async () => {
    try {
      const { data } = await api.get<{ value: number }>('/settings/work-hours-per-day');
      setWorkHours(data.value);
      setWorkHoursInput(formatDecimalInput(data.value));
    } catch { /* ignore */ }
  }, []);

  // ── Fetch max employees ──
  const fetchMaxEmployees = useCallback(async () => {
    try {
      const { data } = await api.get<{ value: number }>('/settings/max-concurrent-employees');
      setMaxEmployees(data.value);
      setMaxEmployeesInput(formatDecimalInput(data.value));
    } catch { /* ignore */ }
  }, []);

  // ── Fetch employee names ──
  const fetchEmployeeNames = useCallback(async () => {
    try {
      const { data } = await api.get<{ employees: string[] }>('/settings/employee-names');
      const employees = data.employees.length > 0 ? data.employees : [''];
      setEmployeeNames(employees);
      setSavedEmployeeNames(data.employees);
      employeeNamesDirty.current = false;
    } catch { /* ignore */ }
  }, []);

  // ── Fetch step assignments ──
  const fetchAssignments = useCallback(async () => {
    try {
      const { data } = await api.get<{ assignments: StepAssignment[] }>('/settings/step-employees');
      setAssignments(data.assignments);
    } catch { /* ignore */ }
  }, []);

  // ── Fetch report ──
  const fetchReport = useCallback(async () => {
    try {
      const { data } = await api.get<ConcurrencyReport>('/settings/employee-concurrency-report');
      setReport(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchWorkHours();
    fetchMaxEmployees();
    fetchEmployeeNames();
    fetchAssignments();
    fetchReport();
  }, [fetchWorkHours, fetchMaxEmployees, fetchEmployeeNames, fetchAssignments, fetchReport]);

  // ── Work Hours save ──
  const handleSaveWorkHours = async () => {
    const val = parseDecimalInput(workHoursInput);
    if (!val || val < 1 || val > 24) {
      setError('Gecerli bir saat girin (1-24).');
      return;
    }
    try {
      setIsUpdatingWorkHours(true);
      setError('');
      const eskiDeger = workHours;
      await api.put('/settings/work-hours-per-day', { value: val });
      setWorkHours(val);
      setWorkHoursInput(formatDecimalInput(val));
      workHoursDirty.current = false;
      setSuccess(`Gunluk calisma saati ${eskiDeger} → ${val} saat olarak guncellendi.`);
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Guncellenemedi.');
    } finally {
      setIsUpdatingWorkHours(false);
    }
  };

  const handleCancelWorkHours = () => {
    setWorkHoursInput(formatDecimalInput(workHours));
    workHoursDirty.current = false;
  };

  // ── Max Employees save ──
  const handleSaveMaxEmployees = async () => {
    const val = parseDecimalInput(maxEmployeesInput);
    if (!val || val < 1 || val > 200) {
      setError('Gecerli bir deger girin (1-200).');
      return;
    }
    try {
      setIsUpdatingMaxEmp(true);
      setError('');
      await api.put('/settings/max-concurrent-employees', { value: val });
      setMaxEmployees(val);
      setMaxEmployeesInput(formatDecimalInput(val));
      maxEmpDirty.current = false;
      setSuccess(`Maksimum es zamanli calisan sayisi ${val} olarak guncellendi.`);
      fetchReport();
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Guncellenemedi.');
    } finally {
      setIsUpdatingMaxEmp(false);
    }
  };

  const handleCancelMaxEmployees = () => {
    setMaxEmployeesInput(formatDecimalInput(maxEmployees));
    maxEmpDirty.current = false;
  };

  // ── Employee names save ──
  const handleEmployeeNamePartChange = (index: number, part: 'firstName' | 'lastName', value: string) => {
    setEmployeeNames(prev => prev.map((name, i) => {
      if (i !== index) return name;
      const current = splitEmployeeName(name);
      const firstName = part === 'firstName' ? value : current.firstName;
      const lastName = part === 'lastName' ? value : current.lastName;
      return [firstName, lastName].map(v => v.trim()).filter(Boolean).join(' ');
    }));
    employeeNamesDirty.current = true;
    setError('');
    setSuccess('');
  };

  const handleAddEmployeeName = () => {
    setEmployeeNames(prev => [...prev, '']);
    employeeNamesDirty.current = true;
    setError('');
    setSuccess('');
  };

  const handleRemoveEmployeeName = (index: number) => {
    setEmployeeNames(prev => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [''];
    });
    employeeNamesDirty.current = true;
    setError('');
    setSuccess('');
  };

  const handleCancelEmployeeNames = () => {
    setEmployeeNames(savedEmployeeNames.length > 0 ? savedEmployeeNames : ['']);
    employeeNamesDirty.current = false;
    setError('');
    setSuccess('');
  };

  const handleSaveEmployeeNames = async () => {
    const names = employeeNames.map(name => name.trim().replace(/\s+/g, ' '));
    const filledNames = names.filter(Boolean);
    const invalidName = filledNames.find(name => name.split(' ').length < 2);
    if (invalidName) {
      setError(`Isim ve soyisim girin: ${invalidName}`);
      return;
    }
    const seen = new Set<string>();
    const duplicateName = filledNames.find(name => {
      const lookup = name.toLocaleLowerCase('tr-TR');
      if (seen.has(lookup)) return true;
      seen.add(lookup);
      return false;
    });
    if (duplicateName) {
      setError(`Tekrarlanan calisan adi: ${duplicateName}`);
      return;
    }

    try {
      setIsSavingEmployeeNames(true);
      setError('');
      const { data } = await api.put<{ employees: string[] }>('/settings/employee-names', { employees: filledNames });
      const employees = data.employees.length > 0 ? data.employees : [''];
      setEmployeeNames(employees);
      setSavedEmployeeNames(data.employees);
      employeeNamesDirty.current = false;
      setSuccess('Calisan adlari kaydedildi.');
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Calisan adlari kaydedilemedi.');
    } finally {
      setIsSavingEmployeeNames(false);
    }
  };

  const renderInput = (a: StepAssignment, field: 'assembly' | 'production' | 'test') => {
    // Fason (dış dizgi) siparişlerde dizgi adımı dış firmada yapılır; çalışan atanamaz.
    if (field === 'assembly' && a.is_outsourced) {
      return (
        <span className="text-amber-300 text-[11px] italic whitespace-nowrap">Fason üretim</span>
      );
    }
    return (
      <>
        <span className={`text-sm font-medium ${a[field] > maxEmployees ? 'text-red-400' : 'text-surface-100'}`}>
          {formatDecimalInput(a[field] ?? 0)}
        </span>
        {a[field] > maxEmployees && <div className="text-red-400 text-xs mt-1 whitespace-nowrap">Maksimum {maxEmployees}</div>}
      </>
    );
  };

  // ── Compute totals ──


  const toggleDate = (d: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  };

  const colCount = 10;

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Konfigurasyon</h1>
          <p className="text-surface-400 text-sm mt-1">Sistem geneli ayarlari yonetin.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-xl text-sm mb-4">
          {success}
        </div>
      )}

      {report && report.conflicts.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-4 py-3 rounded-xl text-sm mb-4">
          <span className="font-semibold">Uyari:</span> Toplamda {report.conflicts.length} gun icin
          maksimum es zamanli çalışan sayisi ({report.max_concurrent_employees}) asilmis durumda.
          Çalışan sayilarini duzenleyerek bu uyarilari cozebilirsiniz.
        </div>
      )}

      {/* ── Daily Work Hours ── */}
      <div className="glass-card p-5 mb-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-surface-300 text-sm font-medium whitespace-nowrap">Gunluk Çalışma Saati</span>
            <input
              type="text"
              inputMode="decimal"
              value={workHoursInput}
              disabled={!canEdit}
              onChange={(e) => {
                workHoursDirty.current = true;
                setWorkHoursInput(e.target.value);
                setError('');
                setSuccess('');
              }}
              onBlur={() => {
                const v = parseDecimalInput(workHoursInput);
                if (!isNaN(v)) {
                  const clamped = Math.min(24, Math.max(1, v));
                  setWorkHoursInput(formatDecimalInput(clamped));
                }
              }}
              className="w-20 px-3 py-1.5 bg-surface-800/60 border border-surface-700/50 rounded-lg text-surface-100 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
            />
            <span className="text-surface-500 text-xs">saat</span>
          </div>
          <div className="flex items-center gap-2">
            {workHoursDirty.current && canEdit && (
              <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={handleCancelWorkHours}>Iptal</button>
            )}
            {canEdit && (
              <button type="button" className="btn-primary text-xs px-3 py-1.5" disabled={isUpdatingWorkHours || !workHoursDirty.current} onClick={handleSaveWorkHours}>
                {isUpdatingWorkHours ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            )}
          </div>
        </div>
        <p className="text-surface-500 text-xs mt-3">
          Excel'deki KAPASITE sayfasindan alinir. Takvim ve gorev tarihleri bu degere gore hesaplanir.
        </p>
      </div>

      {/* ── Max Concurrent Employees ── */}
      <div className="glass-card p-5 mb-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-surface-300 text-sm font-medium whitespace-nowrap">Maksimum Es Zamanli Çalışan</span>
            <input
              type="text"
              inputMode="decimal"
              value={maxEmployeesInput}
              disabled={!canEdit}
              onChange={(e) => {
                maxEmpDirty.current = true;
                setMaxEmployeesInput(e.target.value);
                setError('');
                setSuccess('');
              }}
              onBlur={() => {
                const v = parseDecimalInput(maxEmployeesInput);
                if (!isNaN(v)) {
                  const clamped = Math.min(200, Math.max(1, v));
                  setMaxEmployeesInput(formatDecimalInput(clamped));
                }
              }}
              className="w-20 px-3 py-1.5 bg-surface-800/60 border border-surface-700/50 rounded-lg text-surface-100 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary-500/50 disabled:opacity-50"
            />
            <span className="text-surface-500 text-xs">kisi</span>
          </div>
          <div className="flex items-center gap-2">
            {maxEmpDirty.current && canEdit && (
              <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={handleCancelMaxEmployees}>Iptal</button>
            )}
            {canEdit && (
              <button type="button" className="btn-primary text-xs px-3 py-1.5" disabled={isUpdatingMaxEmp || !maxEmpDirty.current} onClick={handleSaveMaxEmployees}>
                {isUpdatingMaxEmp ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            )}
          </div>
        </div>
        <p className="text-surface-500 text-xs mt-3">
          Ayni anda çalışabilecek maksimum kisi sayisi. Bu deger asildiginda asagidaki raporda uyari gosterilir.
        </p>
      </div>

      {/* ── Employee Names ── */}
      <div className="glass-card p-5 mb-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-white text-sm font-semibold">Çalışan Adlari</h2>
            <p className="text-surface-500 text-xs mt-0.5">
              Çalisanlari isim ve soyisim olarak kaydedin.
            </p>
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              {employeeNamesDirty.current && (
                <button type="button" className="btn-ghost text-xs px-3 py-1.5" onClick={handleCancelEmployeeNames}>Iptal</button>
              )}
              <button type="button" className="btn-primary text-xs px-3 py-1.5" disabled={isSavingEmployeeNames || !employeeNamesDirty.current} onClick={handleSaveEmployeeNames}>
                {isSavingEmployeeNames ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          {employeeNames.map((name, index) => {
            const { firstName, lastName } = splitEmployeeName(name);
            return (
              <div key={index} className="flex flex-wrap items-center gap-3">
                <div className="w-8 text-right text-surface-500 text-sm tabular-nums">{index + 1}</div>
                <input
                  type="text"
                  value={firstName}
                  disabled={!canEdit}
                  onChange={(e) => handleEmployeeNamePartChange(index, 'firstName', e.target.value)}
                  placeholder="Ad"
                  className="w-44 max-w-full px-4 py-2.5 bg-surface-800/50 border border-surface-700/50 rounded-xl text-surface-100 placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all duration-200 h-10 text-sm disabled:opacity-50"
                />
                <input
                  type="text"
                  value={lastName}
                  disabled={!canEdit}
                  onChange={(e) => handleEmployeeNamePartChange(index, 'lastName', e.target.value)}
                  placeholder="Soyad"
                  className="w-56 max-w-full px-4 py-2.5 bg-surface-800/50 border border-surface-700/50 rounded-xl text-surface-100 placeholder-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 focus:border-primary-500 transition-all duration-200 h-10 text-sm disabled:opacity-50"
                />
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => handleRemoveEmployeeName(index)}
                    className="btn-ghost h-10 px-3 py-2 text-xs"
                    aria-label={`${index + 1}. calisani sil`}
                  >
                    Sil
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {canEdit && (
          <button type="button" className="btn-ghost text-xs px-3 py-1.5 mt-3" onClick={handleAddEmployeeName}>
            Çalışan Ekle
          </button>
        )}
      </div>

      {/* ── Step Employee Assignments ── */}
      <div className="glass-card p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-white text-sm font-semibold">Siparis Bazinda Calisan Sayilari</h2>
            <p className="text-surface-500 text-xs mt-0.5">
              Her siparisin Dizgi, Uretim ve Test adimlarinda kac kisinin calistigini goruntuleyin (salt okunur).
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <thead>
              <tr className="border-b border-surface-700/50 text-surface-400 text-xs">
                <th className="text-center py-2 pr-2 border-r border-surface-700/30 font-semibold" rowSpan={2}>Siparis No</th>
                <th className="text-center py-2 pr-2 border-r border-surface-700/30 font-semibold" rowSpan={2}>Urun Adi</th>
                <th className="text-center py-2 px-2 border-r border-surface-700/30 font-semibold" rowSpan={2}>Adet</th>
                <th className="text-center py-2 pr-2 border-r border-surface-700/30 font-semibold" rowSpan={2}>Teslim Tarihi</th>
                <th className="text-center py-2 px-2 border-r border-surface-700/30 font-semibold" colSpan={3}>Is Gunu</th>
                <th className="text-center py-2 px-2 border-l border-surface-700/30 font-medium w-20" rowSpan={2}>Dizgi</th>
                <th className="text-center py-2 px-2 font-medium w-20" rowSpan={2}>Uretim</th>
                <th className="text-center py-2 px-2 font-medium w-20" rowSpan={2}>Test</th>
              </tr>
              <tr className="border-b border-surface-700/50 text-surface-500 text-xs">
                <th className="text-center py-1.5 px-2 border-r border-surface-700/30 font-medium">Dizgi</th>
                <th className="text-center py-1.5 px-2 border-r border-surface-700/30 font-medium">Uretim</th>
                <th className="text-center py-1.5 px-2 font-medium">Test</th>
              </tr>
            </thead>
            <tbody>
              {assignments.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="text-center py-8 text-surface-500 text-sm">
                    Henuz siparis bulunmuyor.
                  </td>
                </tr>
              )}
              {(() => {
                const groups = new Map<string, StepAssignment[]>();
                for (const a of assignments) {
                  const arr = groups.get(a.order_id) ?? [];
                  arr.push(a);
                  groups.set(a.order_id, arr);
                }
                const rows: JSX.Element[] = [];
                for (const [, group] of groups) {
                  const orderLevel = group[0];
                  const isMulti = orderLevel.has_multiple_splits;
                  if (isMulti) {
                    const isExpanded = expandedOrders.has(orderLevel.order_id);
                    rows.push(
                      <tr key={orderLevel.order_id} className="border-b border-surface-800/50 bg-surface-800/10">
                        <td className="py-2 pr-2 border-r border-surface-800/30 text-center">
                          <button
                            type="button"
                            onClick={() => setExpandedOrders(prev => {
                              const next = new Set(prev);
                              if (next.has(orderLevel.order_id)) next.delete(orderLevel.order_id);
                              else next.add(orderLevel.order_id);
                              return next;
                            })}
                            className="text-surface-400 hover:text-surface-200"
                          >
                            <svg className={`w-3.5 h-3.5 transition-transform inline-block ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                          <span className="ml-1 text-surface-100 text-sm font-medium">{orderLevel.order_number}</span>
                        </td>
                        <td className="py-2 pr-2 border-r border-surface-800/30 text-center text-surface-200 truncate">{orderLevel.order_name}</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-300 text-sm truncate">{orderLevel.quantity != null ? orderLevel.quantity : '-'}</td>
                        <td className="py-2 pr-2 border-r border-surface-800/30 text-center text-surface-300 text-sm truncate">{orderLevel.delivery_date ? orderLevel.delivery_date.split('-').reverse().join('/') : '-'}</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-500 text-sm italic">-</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-500 text-sm italic">-</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-500 text-sm italic">-</td>
                        <td className="py-2 px-2 text-center border-l border-surface-800/30">
                          <div className="text-surface-500 text-xs italic">Parça bazında</div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="text-surface-500 text-xs italic">Parça bazında</div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="text-surface-500 text-xs italic">Parça bazında</div>
                        </td>
                      </tr>
                    );
                    if (isExpanded) {
                      const splits = group.filter(a => a.split_id != null);
                      for (const a of splits) {
                        const days = computeStepDays(a, a.assembly, a.production, a.test, workHours);
                        rows.push(
                          <tr key={a.split_id} className="border-b border-surface-800/30 bg-surface-900/30">
                            <td className="py-1.5 pr-2 border-r border-surface-800/30 text-center text-surface-400 text-xs italic pl-6" colSpan={2}>
                              Parça {splits.indexOf(a) + 1}{a.is_outsourced ? ' (Fason)' : ''} — {a.split_start_date?.split('-').reverse().join('/') ?? '-'} ~ {a.split_end_date?.split('-').reverse().join('/') ?? '-'}
                            </td>
                            <td className="py-1.5 px-2 border-r border-surface-800/30 text-center text-surface-300 text-xs">{a.split_quantity != null ? a.split_quantity : '-'}</td>
                            <td className="py-1.5 pr-2 border-r border-surface-800/30 text-center text-surface-300 text-xs">{a.split_end_date ? a.split_end_date.split('-').reverse().join('/') : '-'}</td>
                            <td className="py-1.5 px-2 border-r border-surface-800/30 text-center text-surface-200 text-xs">{days.assembly ?? '-'}</td>
                            <td className="py-1.5 px-2 border-r border-surface-800/30 text-center text-surface-200 text-xs">{days.production ?? '-'}</td>
                            <td className="py-1.5 px-2 border-r border-surface-800/30 text-center text-surface-200 text-xs">{days.test ?? '-'}</td>
                            <td className="py-1.5 px-2 text-center border-l border-surface-800/30">
                              {renderInput(a, 'assembly')}
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              {renderInput(a, 'production')}
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              {renderInput(a, 'test')}
                            </td>
                          </tr>
                        );
                      }
                    }
                  } else {
                    const a = orderLevel;
                    const days = computeStepDays(a, a.assembly, a.production, a.test, workHours);
                    rows.push(
                      <tr key={a.order_id} className="border-b border-surface-800/50 hover:bg-surface-800/20">
                        <td className="py-2 pr-2 border-r border-surface-800/30 text-center text-surface-100 text-sm font-medium truncate">{a.order_number}</td>
                        <td className="py-2 pr-2 border-r border-surface-800/30 text-center text-surface-200 truncate">{a.order_name}</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-300 text-sm truncate">{a.quantity != null ? a.quantity : '-'}</td>
                        <td className="py-2 pr-2 border-r border-surface-800/30 text-center text-surface-300 text-sm truncate">{a.delivery_date ? a.delivery_date.split('-').reverse().join('/') : '-'}</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-200 text-sm">{days.assembly ?? '-'}</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-200 text-sm">{days.production ?? '-'}</td>
                        <td className="py-2 px-2 border-r border-surface-800/30 text-center text-surface-200 text-sm">{days.test ?? '-'}</td>
                        <td className="py-2 px-2 text-center border-l border-surface-800/30">
                          {renderInput(a, 'assembly')}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {renderInput(a, 'production')}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {renderInput(a, 'test')}
                        </td>
                      </tr>
                    );
                  }
                }
                return rows;
              })()}
            </tbody>
          </table>
        </div>

      </div>

      {/* ── Concurrency Conflict Report ── */}
      {report && report.conflicts.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="text-white text-sm font-semibold mb-3">Es Zamanli Çalışan Uyarilari</h2>
          <p className="text-surface-400 text-xs mb-3">
            Asagidaki gunlerde aktif siparis adimlarinin toplam calisan sayisi maksimum degeri ({report.max_concurrent_employees}) asmaktadir.
          </p>
          <div className="space-y-2">
            {report.conflicts.map(c => (
              <div key={c.date} className="bg-surface-800/40 border border-surface-700/40 rounded-lg">
                <button
                  onClick={() => toggleDate(c.date)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-surface-200 text-sm font-medium">{c.date}</span>
                    <span className="text-red-400 text-xs bg-red-500/10 px-2 py-0.5 rounded">
                      {c.total_employees} kisi (max {c.max_allowed}, {c.exceeds_by} fazla)
                    </span>
                  </div>
                  <svg className={`w-4 h-4 text-surface-500 transition-transform ${expandedDates.has(c.date) ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <div className="px-4 pb-1.5">
                  <p className="text-xs text-amber-400 font-medium leading-relaxed">{c.suggestion}</p>
                </div>
                {expandedDates.has(c.date) && (
                  <div className="px-4 pb-3 space-y-1.5">
                    {c.steps.map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-xs text-surface-400 bg-surface-900/40 px-3 py-1.5 rounded">
                        <div className="flex items-center gap-2">
                          <span className="text-surface-200">{s.order_name}</span>
                          <span className="text-primary-400">{s.stage_label}</span>
                          <span>({s.stage_start} - {s.stage_end})</span>
                        </div>
                        <span className="text-surface-300 font-medium">{s.employees} kisi</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
