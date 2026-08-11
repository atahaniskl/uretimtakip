/**
 * Admin user management page.
 */

import { useCallback, useEffect, useState } from 'react';
import api from '../lib/api';

interface ManagedUser {
  id: string;
  username: string;
  role: 'ADMIN' | 'PLANNER' | 'VIEWER';
  is_approved: boolean;
}

export default function UsersPage() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      const { data } = await api.get<ManagedUser[]>('/users/');
      setUsers(data);
      setError('');
    } catch {
      setError('Kullanicilar yuklenemedi. Bu ekran yalnizca ADMIN icindir.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const updateUser = async (userId: string, payload: Partial<ManagedUser>) => {
    try {
      setSavingUserId(userId);
      await api.patch(`/users/${userId}`, payload);
      await fetchUsers();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Kullanici guncellenemedi.';
      setError(String(message));
    } finally {
      setSavingUserId(null);
    }
  };

  const handleDelete = async (userId: string) => {
    if (!window.confirm('Bu kullaniciyi silmek istediginize emin misiniz?')) {
      return;
    }

    try {
      setSavingUserId(userId);
      await api.delete(`/users/${userId}`);
      await fetchUsers();
    } catch (e: any) {
      const message = e?.response?.data?.detail || 'Kullanici silinemedi.';
      setError(String(message));
    } finally {
      setSavingUserId(null);
    }
  };

  return (
    <div className="p-6 animate-fade-in">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Kullanici Yonetimi</h1>
          <p className="text-surface-400 text-sm mt-1">Onay, rol degisikligi ve silme islemleri.</p>
        </div>
        <button className="btn-ghost text-sm" onClick={fetchUsers} disabled={isLoading}>Yenile</button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm mb-4">
          {error}
        </div>
      )}

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-700/50 text-surface-400">
              <th className="text-left py-3 px-4 font-medium">Kullanici</th>
              <th className="text-left py-3 px-4 font-medium">Rol</th>
              <th className="text-left py-3 px-4 font-medium">Durum</th>
              <th className="text-right py-3 px-4 font-medium">Islem</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-surface-500">Yukleniyor...</td>
              </tr>
            )}

            {!isLoading && users.length === 0 && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-surface-500">Kullanici bulunamadi.</td>
              </tr>
            )}

            {!isLoading && users.map((user) => (
              <tr key={user.id} className="border-b border-surface-800/50 hover:bg-surface-800/30">
                <td className="py-3 px-4 text-surface-200">{user.username}</td>
                <td className="py-3 px-4">
                  <select
                    className="input-field max-w-[160px]"
                    value={user.role}
                    onChange={(e) => updateUser(user.id, { role: e.target.value as ManagedUser['role'] })}
                    disabled={savingUserId === user.id}
                  >
                    <option value="ADMIN">ADMIN</option>
                    <option value="PLANNER">PLANNER</option>
                    <option value="VIEWER">VIEWER</option>
                  </select>
                </td>
                <td className="py-3 px-4">
                  {user.is_approved ? (
                    <span className="badge badge-success">Onayli</span>
                  ) : (
                    <span className="badge badge-warning">Onay Bekliyor</span>
                  )}
                </td>
                <td className="py-3 px-4 text-right">
                  <div className="inline-flex items-center gap-2">
                    {user.is_approved ? (
                      <button
                        className="btn-ghost text-xs px-3 py-1.5"
                        onClick={() => updateUser(user.id, { is_approved: false })}
                        disabled={savingUserId === user.id}
                      >
                        Onayi Kaldir
                      </button>
                    ) : (
                      <button
                        className="btn-primary text-xs px-3 py-1.5"
                        onClick={() => updateUser(user.id, { is_approved: true })}
                        disabled={savingUserId === user.id}
                      >
                        Onayla
                      </button>
                    )}
                    <button
                      className="btn-ghost text-xs px-3 py-1.5 border border-red-500/40 text-red-300 hover:bg-red-500/10"
                      onClick={() => handleDelete(user.id)}
                      disabled={savingUserId === user.id}
                    >
                      Sil
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
