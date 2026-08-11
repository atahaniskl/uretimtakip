/**
 * Register page for new users. Accounts require admin approval.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { getApiErrorMessage } from '../lib/errorMessage';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== passwordRepeat) {
      setError('Sifreler ayni olmali.');
      return;
    }

    setIsLoading(true);
    try {
      await api.post('/auth/register', { username, password });
      setSuccess('Kayit alindi. Giris icin admin onayi bekleniyor.');
      setTimeout(() => navigate('/login'), 1200);
    } catch (e: any) {
      const message = getApiErrorMessage(e, 'Kayit olusturulamadi.');
      setError(String(message));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary-600/20 rounded-full blur-3xl animate-pulse-slow" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-primary-400/10 rounded-full blur-3xl animate-pulse-slow" />

      <div className="glass-card p-10 w-full max-w-md animate-fade-in relative z-10">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white">Yeni Kayit</h1>
          <p className="text-surface-400 mt-2 text-sm">Kayit sonrasi hesabiniz admin onayina duser.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-xl text-sm whitespace-pre-line">
              {error}
            </div>
          )}

          {success && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-xl text-sm">
              {success}
            </div>
          )}

          <div>
            <label htmlFor="register-username" className="block text-sm font-medium text-surface-300 mb-1.5">Kullanici Adi</label>
            <input
              id="register-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input-field"
              placeholder="kullanici_adi"
              required
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="register-password" className="block text-sm font-medium text-surface-300 mb-1.5">Sifre</label>
            <input
              id="register-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              placeholder="••••••••"
              required
            />
          </div>

          <div>
            <label htmlFor="register-password-repeat" className="block text-sm font-medium text-surface-300 mb-1.5">Sifre Tekrar</label>
            <input
              id="register-password-repeat"
              type="password"
              value={passwordRepeat}
              onChange={(e) => setPasswordRepeat(e.target.value)}
              className="input-field"
              placeholder="••••••••"
              required
            />
          </div>

          <button type="submit" disabled={isLoading} className="btn-primary w-full">
            {isLoading ? 'Kayit olusturuluyor...' : 'Kayit Ol'}
          </button>
        </form>

        <p className="text-surface-400 text-sm mt-5 text-center">
          Hesabiniz var mi? <Link to="/login" className="text-primary-400 hover:text-primary-300">Giris yapin</Link>
        </p>
      </div>
    </div>
  );
}
