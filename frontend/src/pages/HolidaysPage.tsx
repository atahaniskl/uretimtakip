/**
 * Holiday management page.
 */

import { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

interface HolidayItem {
  id: string;
  holiday_date: string;
  name: string;
  is_active: boolean;
}

export default function HolidaysPage() {
  const { user } = useAuth();
  // Backend (holidays.py) create/delete/seed için ADMIN/PLANNER rolü zorunlu
  // kılıyor ve nav'da da bu sayfa zaten yalnızca o rollere gösteriliyor (bkz.
  // Layout.tsx) — ama doğrudan URL ile gelen bir VIEWER yine de tüm düğmeleri
  // görüp 403 alırdı (purchasing.py/UploadPage.tsx'teki AYNI sınıf düzeltme).
  const canEdit = user?.role === 'ADMIN' || user?.role === 'PLANNER';
  const [holidays, setHolidays] = useState<HolidayItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSeeding, setIsSeeding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchHolidays = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get<HolidayItem[]>('/holidays/');
      setHolidays(Array.isArray(data) ? data : []);
      setError('');
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Tatil listesi alinamadi.';
      setError(String(message));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHolidays();
  }, [fetchHolidays]);

  const resetModal = () => {
    setNewDate('');
    setNewName('');
    setIsModalOpen(false);
  };

  const handleCreateHoliday = async () => {
    if (!newDate) {
      setError('Lutfen tarih secin.');
      return;
    }

    try {
      setIsSaving(true);
      setError('');
      setSuccess('');
      await api.post('/holidays/', {
        holiday_date: newDate,
        name: newName.trim() || 'Resmi Tatil',
      });
      setSuccess('Tatil eklendi.');
      resetModal();
      await fetchHolidays();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Tatil kaydedilemedi.';
      setError(String(message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteHoliday = async (holiday: HolidayItem) => {
    if (!window.confirm(`${holiday.holiday_date} tarihli tatili silmek istediginize emin misiniz?`)) {
      return;
    }

    try {
      setDeletingId(holiday.id);
      setError('');
      setSuccess('');
      await api.delete(`/holidays/${holiday.id}`);
      setSuccess('Tatil silindi.');
      await fetchHolidays();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Tatil silinemedi.';
      setError(String(message));
    } finally {
      setDeletingId(null);
    }
  };

  const handleSeedTrHolidays = async () => {
    try {
      setIsSeeding(true);
      setError('');
      setSuccess('');
      const { data } = await api.post('/holidays/seed-tr');
      setSuccess(`${data?.message || 'TR sabit resmi tatilleri yuklendi.'} (Eklenen: ${data?.added_count ?? 0})`);
      await fetchHolidays();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'TR resmi tatilleri yuklenemedi.';
      setError(String(message));
    } finally {
      setIsSeeding(false);
    }
  };

  const formatDate = (value: string) => {
    const date = new Date(`${value}T00:00:00`);
    return date.toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Tatil Yonetimi</h1>
          <p className="text-surface-400 text-sm mt-1">Resmi tatilleri tanimlayin, is gunu hesaplarini guncelleyin.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost text-sm" onClick={fetchHolidays} disabled={isLoading}>Yenile</button>
          {canEdit && (
            <>
              <button className="btn-ghost text-sm" onClick={handleSeedTrHolidays} disabled={isSeeding || isLoading} title="Sabit ulusal tatiller + Ramazan ve Kurban Bayramı">
                {isSeeding ? 'Yukleniyor...' : 'TR Resmi & Dini Tatillerini Yukle'}
              </button>
              <button className="btn-primary text-sm" onClick={() => setIsModalOpen(true)}>Yeni Tatil Ekle</button>
            </>
          )}
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

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-700/50 text-surface-400">
              <th className="text-left py-3 px-4 font-medium">Tarih</th>
              <th className="text-left py-3 px-4 font-medium">Tatil Adi</th>
              <th className="text-right py-3 px-4 font-medium">Aksiyonlar</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={3} className="py-12 text-center text-surface-500">Yukleniyor...</td>
              </tr>
            )}

            {!isLoading && holidays.length === 0 && (
              <tr>
                <td colSpan={3} className="py-12 text-center text-surface-500">Tatil kaydi yok.</td>
              </tr>
            )}

            {!isLoading && holidays.map((holiday) => (
              <tr key={holiday.id} className="border-b border-surface-800/50 hover:bg-surface-800/30">
                <td className="py-3 px-4 text-surface-200">{formatDate(holiday.holiday_date)}</td>
                <td className="py-3 px-4 text-surface-300">{holiday.name}</td>
                <td className="py-3 px-4 text-right">
                  {canEdit && (
                    <button
                      className="btn-ghost text-xs px-3 py-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10"
                      onClick={() => handleDeleteHoliday(holiday)}
                      disabled={deletingId === holiday.id}
                    >
                      {deletingId === holiday.id ? 'Siliniyor...' : 'Sil'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg glass-card p-6">
            <h2 className="text-xl font-bold text-white mb-4">Yeni Tatil Ekle</h2>

            <div className="space-y-4">
              <label className="block text-sm text-surface-300">
                Tarih
                <input
                  type="date"
                  className="input-field mt-1"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                />
              </label>

              <label className="block text-sm text-surface-300">
                Tatil Adi
                <input
                  type="text"
                  className="input-field mt-1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Ornek: 29 Ekim Cumhuriyet Bayrami"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button className="btn-ghost text-sm" onClick={resetModal} disabled={isSaving}>Vazgec</button>
              <button className="btn-primary text-sm" onClick={handleCreateHoliday} disabled={isSaving}>
                {isSaving ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
