/**
 * Request/Suggestion/Complaint page for planners and admins.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

type FeedbackCategory = 'REQUEST' | 'SUGGESTION' | 'COMPLAINT';

interface FeedbackItem {
  id: string;
  category: FeedbackCategory;
  description: string;
  screenshot_filename?: string | null;
  has_screenshot: boolean;
  created_by: string;
  created_by_username?: string | null;
  created_at: string;
  is_checked: boolean;
  checked_by?: string | null;
  checked_by_username?: string | null;
  checked_at?: string | null;
}

const CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'REQUEST', label: 'Istek' },
  { value: 'SUGGESTION', label: 'Oneri' },
  { value: 'COMPLAINT', label: 'Sikayet' },
];

const categoryLabel = (value: FeedbackCategory) => {
  const found = CATEGORY_OPTIONS.find((item) => item.value === value);
  return found?.label || value;
};

export default function FeedbackItemsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingCheckId, setLoadingCheckId] = useState<string | null>(null);
  const [loadingScreenshotId, setLoadingScreenshotId] = useState<string | null>(null);
  const [category, setCategory] = useState<FeedbackCategory>('REQUEST');
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const isAdmin = user?.role === 'ADMIN';
  const isAuthorized = user?.role === 'ADMIN' || user?.role === 'PLANNER' || user?.role === 'VIEWER';

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => Number(a.is_checked) - Number(b.is_checked) || Date.parse(b.created_at) - Date.parse(a.created_at)),
    [items],
  );

  const fetchItems = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get<FeedbackItem[]>('/feedback-items/');
      setItems(Array.isArray(data) ? data : []);
      setError('');
    } catch (e: any) {
      setItems([]);
      setError(String(e?.response?.data?.detail || 'Kayitlar yuklenemedi.'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthorized) return;
    fetchItems();
  }, [fetchItems, isAuthorized]);

  const handleCreate = async () => {
    const cleanedDescription = description.trim();
    if (cleanedDescription.length < 3) {
      setFormError('Aciklama en az 3 karakter olmalidir.');
      return;
    }

    if (screenshot && screenshot.size > 5 * 1024 * 1024) {
      setFormError('Ekran goruntusu boyutu 5MB ustunde olamaz.');
      return;
    }

    setFormError('');
    setIsSubmitting(true);

    try {
      const payload = new FormData();
      payload.append('category', category);
      payload.append('description', cleanedDescription);
      if (screenshot) payload.append('screenshot', screenshot);

      await api.post('/feedback-items/', payload, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      setDescription('');
      setScreenshot(null);
      await fetchItems();
    } catch (e: any) {
      setFormError(String(e?.response?.data?.detail || 'Kayit olusturulamadi.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleCheck = async (item: FeedbackItem) => {
    if (!isAdmin) return;
    try {
      setLoadingCheckId(item.id);
      const payload = new FormData();
      payload.append('is_checked', item.is_checked ? 'false' : 'true');

      await api.patch(`/feedback-items/${item.id}/check`, payload, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      await fetchItems();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail || 'Kayit durumu guncellenemedi.'));
    } finally {
      setLoadingCheckId(null);
    }
  };

  const openScreenshot = async (item: FeedbackItem) => {
    if (!item.has_screenshot) return;
    try {
      setLoadingScreenshotId(item.id);
      const response = await api.get(`/feedback-items/${item.id}/screenshot`, {
        responseType: 'blob',
      });
      const blobUrl = URL.createObjectURL(response.data);
      const opened = window.open(blobUrl, '_blank', 'noopener,noreferrer');
      if (!opened) {
        setError('Gorsel acilamadi. Tarayici pop-up engellemis olabilir.');
      }
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    } catch (e: any) {
      setError(String(e?.response?.data?.detail || 'Ekran goruntusu acilamadi.'));
    } finally {
      setLoadingScreenshotId(null);
    }
  };

  if (!isAuthorized) {
    return (
      <div className="p-6">
        <div className="glass-card p-6 text-sm text-red-300 border border-red-500/20">
          Bu alana erisim yetkiniz bulunmuyor.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 animate-fade-in space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Istek / Oneri / Sikayet</h1>
          <p className="text-surface-400 text-sm mt-1">Tum kullanicilar kayit acabilir ve tum kayitlari gorebilir. Sadece admin check atabilir.</p>
        </div>
        <button type="button" className="btn-ghost text-sm" onClick={fetchItems} disabled={isLoading}>Yenile</button>
      </div>

      <div className="glass-card p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-surface-400 mb-1">Kategori</label>
            <select className="input-field" value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory)}>
              {CATEGORY_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs text-surface-400 mb-1">Ekran Goruntusu (Opsiyonel)</label>
            <input
              className="input-field"
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp"
              onChange={(e) => setScreenshot(e.target.files?.[0] || null)}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-surface-400 mb-1">Aciklama</label>
          <textarea
            className="input-field min-h-[120px]"
            placeholder="Sorunu, istegi veya oneriyi detayli yazin..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {formError && <div className="text-red-300 text-sm">{formError}</div>}

        <div className="flex justify-end">
          <button type="button" className="btn-primary" onClick={handleCreate} disabled={isSubmitting}>
            {isSubmitting ? 'Kaydediliyor...' : 'Kayit Olustur'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-4 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-700/50 text-surface-400">
              <th className="text-left py-3 px-4 font-medium">Check</th>
              <th className="text-left py-3 px-4 font-medium">Kategori</th>
              <th className="text-left py-3 px-4 font-medium">Aciklama</th>
              <th className="text-left py-3 px-4 font-medium">Ekran Goruntusu</th>
              <th className="text-left py-3 px-4 font-medium">Olusturan</th>
              <th className="text-right py-3 px-4 font-medium">Yetki</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-surface-500">Yukleniyor...</td>
              </tr>
            )}

            {!isLoading && sortedItems.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-surface-500">Kayit bulunamadi.</td>
              </tr>
            )}

            {!isLoading && sortedItems.map((item) => {
              return (
                <tr key={item.id} className="border-b border-surface-800/50 align-top hover:bg-surface-800/30">
                  <td className="py-3 px-4">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary-500"
                      checked={item.is_checked}
                      disabled={!isAdmin || loadingCheckId === item.id}
                      onChange={() => toggleCheck(item)}
                      aria-label="Kayit check durumu"
                    />
                    {item.checked_by_username && (
                      <div className="text-xs text-surface-500 mt-1">{item.checked_by_username}</div>
                    )}
                  </td>
                  <td className="py-3 px-4 text-surface-200">{categoryLabel(item.category)}</td>
                  <td className="py-3 px-4 text-surface-200 whitespace-pre-wrap max-w-[520px]">{item.description}</td>
                  <td className="py-3 px-4">
                    {item.has_screenshot ? (
                      <button
                        type="button"
                        className="btn-ghost text-xs px-3 py-1"
                        onClick={() => openScreenshot(item)}
                        disabled={loadingScreenshotId === item.id}
                      >
                        {loadingScreenshotId === item.id ? 'Aciliyor...' : 'Ac'}
                      </button>
                    ) : (
                      <span className="text-surface-500">Yok</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-surface-300">
                    <div>{item.created_by_username || '-'}</div>
                    <div className="text-xs text-surface-500">{new Date(item.created_at).toLocaleString('tr-TR')}</div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="text-xs text-surface-500">{isAdmin ? 'Admin duzenler' : 'Sadece admin'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
