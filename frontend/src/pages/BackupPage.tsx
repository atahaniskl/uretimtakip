/**
 * System backup management page (Admin only).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

const RESTORE_LOCK_KEY = 'dps_restore_lock';

interface BackupItem {
  object_name: string;
  size: number;
  created_at: string | null;
  category: string;
}

interface BackupPolicy {
  automation_enabled: boolean;
  daily_retention: number;
  weekly_retention: number;
  monthly_retention: number;
  manual_retention: number;
  daily_hour_utc: number;
  weekly_weekday_utc: number;
  weekly_hour_utc: number;
  monthly_day_utc: number;
  monthly_hour_utc: number;
  max_hours_without_backup: number;
  updated_at: string | null;
}

interface BackupHealth {
  status: string;
  warning: boolean;
  message: string;
  last_backup_at: string | null;
  hours_since_last_backup: number | null;
  threshold_hours: number;
}

interface RestoreJob {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  object_name: string;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export default function BackupPage() {
  const { user } = useAuth();
  // Backend (backups.py) TÜM uç noktalarda (liste dahil) ADMIN rolü zorunlu
  // kılıyor — PLANNER/VIEWER için bu sayfadaki HER API çağrısı zaten başarısız
  // olurdu (sadece mutasyonlar değil). Nav'da da yalnızca ADMIN'e gösteriliyor
  // (bkz. Layout.tsx) ama doğrudan URL ile gelen biri yine de bozuk/hata dolu
  // bir sayfa görürdü — bunun yerine net bir "yetkiniz yok" mesajı gösterilir.
  const canView = user?.role === 'ADMIN';
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [policy, setPolicy] = useState<BackupPolicy | null>(null);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [health, setHealth] = useState<BackupHealth | null>(null);

  const [targetBackup, setTargetBackup] = useState<BackupItem | null>(null);
  const [ackRisk, setAckRisk] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const [restoreJobId, setRestoreJobId] = useState<string | null>(null);
  const [restoreJobStatus, setRestoreJobStatus] = useState<string | null>(null);
  const [deletingBackupName, setDeletingBackupName] = useState<string | null>(null);
  const restorePollErrorCount = useRef(0);

  const fetchBackups = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get<BackupItem[]>('/backups/');
      setBackups(data);
      setError('');
    } catch {
      setError('Yedekler alınamadı. Bu ekran yalnızca sistem yöneticileri içindir.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchPolicy = useCallback(async () => {
    try {
      const { data } = await api.get<BackupPolicy>('/backups/policy');
      setPolicy(data);
    } catch {
      // Policy errors are reflected in global error state by list/health calls.
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const { data } = await api.get<BackupHealth>('/backups/health');
      setHealth(data);
    } catch {
      // Health is best-effort for dashboard warning.
    }
  }, []);

  useEffect(() => {
    fetchBackups();
    fetchPolicy();
    fetchHealth();
  }, [fetchBackups, fetchPolicy, fetchHealth]);

  useEffect(() => {
    if (!targetBackup || countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [targetBackup, countdown]);

  useEffect(() => {
    const locked = Boolean(targetBackup) || isRestoring || Boolean(restoreJobId);
    if (locked) {
      localStorage.setItem(RESTORE_LOCK_KEY, '1');
    } else {
      localStorage.removeItem(RESTORE_LOCK_KEY);
    }
    window.dispatchEvent(new Event('dps-restore-lock-change'));

    return () => {
      localStorage.removeItem(RESTORE_LOCK_KEY);
      window.dispatchEvent(new Event('dps-restore-lock-change'));
    };
  }, [targetBackup, isRestoring, restoreJobId]);

  useEffect(() => {
    if (!restoreJobId) return;

    const poll = async () => {
      try {
        const { data } = await api.get<RestoreJob>(`/backups/restore-jobs/${restoreJobId}`);
        restorePollErrorCount.current = 0;
        setRestoreJobStatus(data.status);

        if (data.status === 'completed') {
          setError('');
          setSuccess('Geri yükleme tamamlandı. Sayfayı yenileyin.');
          setIsRestoring(false);
          setRestoreJobId(null);
          setRestoreJobStatus(null);
          await fetchBackups();
          await fetchHealth();
        } else if (data.status === 'failed') {
          setSuccess('');
          setError(data.error || 'Geri yükleme başarısız oldu.');
          setIsRestoring(false);
          setRestoreJobId(null);
          setRestoreJobStatus(null);
        }
      } catch (e: any) {
        restorePollErrorCount.current += 1;

        const statusCode = e?.response?.status;
        if (statusCode === 401 || statusCode === 403) {
          setSuccess('');
          setError('Geri yükleme sırasında oturum/yetki değişti. Lütfen tekrar giriş yapıp yedek listesini yenileyin.');
          setIsRestoring(false);
          setRestoreJobId(null);
          setRestoreJobStatus(null);
          return;
        }

        if (statusCode === 404) {
          setSuccess('');
          setError('Geri yükleme işi sunucuda bulunamadı. Sunucu yeniden başlamış olabilir; lütfen yedek listesini yenileyin.');
          setIsRestoring(false);
          setRestoreJobId(null);
          setRestoreJobStatus(null);
          return;
        }

        if (restorePollErrorCount.current >= 30) {
          setSuccess('');
          setError('Geri yükleme durumu uzun süre alınamadı. Yedek listesini yenileyip sonucu kontrol edin.');
          setIsRestoring(false);
          setRestoreJobId(null);
          setRestoreJobStatus(null);
          return;
        }

        setError(`Geri yükleme durumu alınamadı (${restorePollErrorCount.current}/30). Tekrar deneniyor...`);
      }
    };

    poll();
    const interval = window.setInterval(poll, 2000);
    return () => window.clearInterval(interval);
  }, [restoreJobId, fetchBackups, fetchHealth]);

  const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** index;
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return 'Bilinmiyor';
    const date = new Date(iso);
    return date.toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const canRestore = useMemo(() => ackRisk && countdown === 0 && !!targetBackup && !isRestoring, [ackRisk, countdown, targetBackup, isRestoring]);
  const restoreButtonLabel = isRestoring
    ? 'Geri Yükleniyor...'
    : countdown > 0
      ? `Geri Yüklemeyi Başlat (${countdown})`
      : 'Geri Yüklemeyi Başlat';

  const handleCreateBackup = async () => {
    try {
      setIsCreating(true);
      setError('');
      setSuccess('');
      const { data } = await api.post('/backups/create');
      setSuccess(data.message || 'Yedek başarıyla oluşturuldu.');
      await fetchBackups();
      await fetchHealth();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Yedek oluşturulamadı.';
      setError(String(message));
    } finally {
      setIsCreating(false);
    }
  };

  const openRestoreDialog = (backup: BackupItem) => {
    setTargetBackup(backup);
    setAckRisk(false);
    setCountdown(10);
    setSuccess('');
    setError('');
  };

  const closeRestoreDialog = () => {
    setTargetBackup(null);
    setAckRisk(false);
    setCountdown(10);
  };

  const handleRestore = async () => {
    if (!targetBackup) return;
    try {
      setIsRestoring(true);
      setRestoreJobId(null);
      setRestoreJobStatus(null);
      restorePollErrorCount.current = 0;
      setError('');
      setSuccess('');
      const { data } = await api.post<RestoreJob>('/backups/restore', {
        object_name: targetBackup.object_name,
        acknowledge_risk: true,
      });
      setRestoreJobId(data.job_id);
      setRestoreJobStatus(data.status);
      setError('');
      setSuccess('Geri yükleme kuyruğa alındı. Durum kontrol ediliyor...');
      closeRestoreDialog();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const responseData = e?.response?.data;
      const responseText = typeof responseData === 'string'
        ? responseData
        : responseData
          ? JSON.stringify(responseData)
          : '';

      const message = detail
        || responseText
        || (e?.request && !e?.response
          ? 'Sunucu zaman asimina ugradi veya baglanti koptu. Biraz bekleyip yedek listesini yenileyin.'
          : 'Geri yükleme başarısız oldu.');
      setError(String(message));
      setIsRestoring(false);
    } finally {
      // Final state is handled by restore job polling.
    }
  };

  const handleDeleteBackup = async (objectName: string) => {
    if (!window.confirm('Bu yedegi silmek istediginize emin misiniz? Bu islem geri alinamaz.')) {
      return;
    }

    try {
      setDeletingBackupName(objectName);
      setError('');
      setSuccess('');
      const { data } = await api.delete('/backups/', {
        params: { object_name: objectName },
      });
      setSuccess(data?.message || 'Yedek silindi.');
      await fetchBackups();
      await fetchHealth();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Yedek silinemedi.';
      setError(String(message));
    } finally {
      setDeletingBackupName(null);
    }
  };

  const handlePolicyNumberChange = (key: keyof BackupPolicy, value: string) => {
    if (!policy) return;
    const parsed = Number(value);
    setPolicy({
      ...policy,
      [key]: Number.isNaN(parsed) ? 0 : parsed,
    });
  };

  const handleSavePolicy = async () => {
    if (!policy) return;
    try {
      setIsSavingPolicy(true);
      setError('');
      setSuccess('');
      const payload = {
        automation_enabled: policy.automation_enabled,
        daily_retention: policy.daily_retention,
        weekly_retention: policy.weekly_retention,
        monthly_retention: policy.monthly_retention,
        manual_retention: policy.manual_retention,
        daily_hour_utc: policy.daily_hour_utc,
        weekly_weekday_utc: policy.weekly_weekday_utc,
        weekly_hour_utc: policy.weekly_hour_utc,
        monthly_day_utc: policy.monthly_day_utc,
        monthly_hour_utc: policy.monthly_hour_utc,
        max_hours_without_backup: policy.max_hours_without_backup,
      };
      const { data } = await api.put<BackupPolicy>('/backups/policy', payload);
      setPolicy(data);
      setSuccess('Yedekleme politikası güncellendi.');
      await fetchHealth();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Politika güncellenemedi.';
      setError(String(message));
    } finally {
      setIsSavingPolicy(false);
    }
  };

  const categoryLabel = (category: string) => {
    if (category === 'daily') return 'Günlük';
    if (category === 'weekly') return 'Haftalık';
    if (category === 'monthly') return 'Aylık';
    if (category === 'manual') return 'Manuel';
    return 'Eski';
  };

  if (!canView) {
    return (
      <div className="p-6 animate-fade-in">
        <h1 className="text-2xl font-bold text-white mb-6">Sistem Yedekleri</h1>
        <div className="rounded-xl border border-surface-700/50 bg-surface-900/60 px-4 py-6 text-center text-surface-400">
          Bu sayfa yalnızca ADMIN rolündeki kullanıcılar içindir.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Sistem Yedekleri</h1>
          <p className="text-surface-400 text-sm mt-1">
            Veritabanı yedeklerini yönetin ve gerektiğinde tek tıkla geri dönün.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchBackups} className="btn-ghost text-sm" disabled={isLoading}>
            Yenile
          </button>
          <button onClick={handleCreateBackup} className="btn-primary text-sm" disabled={isCreating}>
            {isCreating ? 'Yedek Alınıyor...' : 'Şimdi Yedek Al'}
          </button>
        </div>
      </div>

      <div className="glass-card p-4 mb-5 border-amber-500/30 bg-amber-500/10">
        <p className="text-sm text-amber-200">
          Otomatik yedekleme arka planda belirli aralıklarla çalışır. Geri yükleme işlemi tüm mevcut veriyi seçilen yedek anına çeker.
        </p>
      </div>

      {health?.warning && (
        <div className="bg-red-600/15 border border-red-500/40 text-red-200 px-4 py-3 rounded-xl text-sm mb-4">
          <p className="font-semibold">{health.message}</p>
          <p className="mt-1">
            Son yedek: {health.last_backup_at ? formatDate(health.last_backup_at) : 'Yok'}
            {health.hours_since_last_backup !== null ? ` (${health.hours_since_last_backup} saat önce)` : ''}
          </p>
        </div>
      )}

      {policy && (
        <div className="glass-card p-5 mb-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Yedekleme Politikası</h2>
            <button className="btn-primary text-sm" onClick={handleSavePolicy} disabled={isSavingPolicy}>
              {isSavingPolicy ? 'Kaydediliyor...' : 'Politikayı Kaydet'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <label className="text-sm text-surface-300">
              Günlük saklama adedi
              <input className="input-field mt-1" type="number" min={1} max={90} value={policy.daily_retention} onChange={(e) => handlePolicyNumberChange('daily_retention', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Haftalık saklama adedi
              <input className="input-field mt-1" type="number" min={1} max={104} value={policy.weekly_retention} onChange={(e) => handlePolicyNumberChange('weekly_retention', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Aylık saklama adedi
              <input className="input-field mt-1" type="number" min={1} max={120} value={policy.monthly_retention} onChange={(e) => handlePolicyNumberChange('monthly_retention', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Manuel saklama adedi
              <input className="input-field mt-1" type="number" min={1} max={500} value={policy.manual_retention} onChange={(e) => handlePolicyNumberChange('manual_retention', e.target.value)} />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <label className="text-sm text-surface-300">
              Günlük saat (UTC)
              <input className="input-field mt-1" type="number" min={0} max={23} value={policy.daily_hour_utc} onChange={(e) => handlePolicyNumberChange('daily_hour_utc', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Haftalık gün (0=Pzt)
              <input className="input-field mt-1" type="number" min={0} max={6} value={policy.weekly_weekday_utc} onChange={(e) => handlePolicyNumberChange('weekly_weekday_utc', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Haftalık saat (UTC)
              <input className="input-field mt-1" type="number" min={0} max={23} value={policy.weekly_hour_utc} onChange={(e) => handlePolicyNumberChange('weekly_hour_utc', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Aylık gün (1-28)
              <input className="input-field mt-1" type="number" min={1} max={28} value={policy.monthly_day_utc} onChange={(e) => handlePolicyNumberChange('monthly_day_utc', e.target.value)} />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="text-sm text-surface-300">
              Aylık saat (UTC)
              <input className="input-field mt-1" type="number" min={0} max={23} value={policy.monthly_hour_utc} onChange={(e) => handlePolicyNumberChange('monthly_hour_utc', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300">
              Alarm eşiği (saat)
              <input className="input-field mt-1" type="number" min={1} max={168} value={policy.max_hours_without_backup} onChange={(e) => handlePolicyNumberChange('max_hours_without_backup', e.target.value)} />
            </label>
            <label className="text-sm text-surface-300 flex items-center gap-2 mt-7">
              <input
                type="checkbox"
                checked={policy.automation_enabled}
                onChange={(e) => setPolicy({ ...policy, automation_enabled: e.target.checked })}
              />
              Otomatik yedekleme aktif
            </label>
          </div>
        </div>
      )}

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

      {isRestoring && (
        <div className="bg-blue-500/10 border border-blue-500/30 text-blue-300 px-4 py-3 rounded-xl text-sm mb-4">
          Geri yükleme devam ediyor{restoreJobStatus ? ` (${restoreJobStatus})` : ''}. Bu işlem arka planda sürer.
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-700/50 text-surface-400">
              <th className="text-left py-3 px-4 font-medium">Yedek Dosyası</th>
              <th className="text-left py-3 px-4 font-medium">Tarih</th>
              <th className="text-left py-3 px-4 font-medium">Boyut</th>
              <th className="text-left py-3 px-4 font-medium">Tür</th>
              <th className="text-right py-3 px-4 font-medium">İşlem</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-surface-500">
                  Yedekler yükleniyor...
                </td>
              </tr>
            )}

            {!isLoading && backups.length === 0 && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-surface-500">
                  Henüz yedek bulunmuyor.
                </td>
              </tr>
            )}

            {!isLoading && backups.map((backup) => (
              <tr key={backup.object_name} className="border-b border-surface-800/50 hover:bg-surface-800/30 transition-colors">
                <td className="py-3 px-4 text-surface-200 font-medium">{backup.object_name}</td>
                <td className="py-3 px-4 text-surface-300">{formatDate(backup.created_at)}</td>
                <td className="py-3 px-4 text-surface-300">{formatBytes(backup.size)}</td>
                <td className="py-3 px-4 text-surface-300">{categoryLabel(backup.category)}</td>
                <td className="py-3 px-4 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button className="btn-danger text-xs px-3 py-1.5" onClick={() => openRestoreDialog(backup)} disabled={isRestoring || deletingBackupName === backup.object_name}>
                      Bu Noktaya Geri Dön
                    </button>
                    <button
                      className="btn-ghost text-xs px-3 py-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10"
                      onClick={() => handleDeleteBackup(backup.object_name)}
                      disabled={isRestoring || deletingBackupName === backup.object_name}
                    >
                      {deletingBackupName === backup.object_name ? 'Siliniyor...' : 'Sil'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {targetBackup && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl glass-card p-6 border-red-500/40">
            <h2 className="text-xl font-bold text-white mb-2">Risk Onayı Gerekli</h2>
            <p className="text-sm text-surface-300 mb-3">
              Seçilen yedeğe geri dönüldüğünde mevcut veriler geri döndürülemez şekilde değişir.
            </p>
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-200 mb-4">
              <p>Seçilen yedek: <span className="font-semibold">{targetBackup.object_name}</span></p>
              <p>Tarih: {formatDate(targetBackup.created_at)}</p>
              <p>Boyut: {formatBytes(targetBackup.size)}</p>
            </div>

            <label className="flex items-start gap-2 text-sm text-surface-200 mb-4">
              <input
                type="checkbox"
                checked={ackRisk}
                onChange={(e) => setAckRisk(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Riski anladım, mevcut verilerin üzerine yazılmasını kabul ediyorum.
              </span>
            </label>

            <div className="bg-surface-800/60 border border-surface-700/50 rounded-xl p-3 text-sm text-surface-300 mb-4">
              Güvenlik bekleme süresi: <span className="font-bold text-white">{countdown}</span> saniye
            </div>

            <div className="flex items-center justify-end gap-2">
              <button className="btn-ghost text-sm" onClick={closeRestoreDialog} disabled={isRestoring}>
                Vazgeç
              </button>
              <button className="btn-danger text-sm" onClick={handleRestore} disabled={!canRestore}>
                {restoreButtonLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
