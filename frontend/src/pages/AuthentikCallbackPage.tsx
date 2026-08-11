/**
 * Authentik callback page — stores backend-issued JWT and enters the app.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function AuthentikCallbackPage() {
  const { completeTokenLogin } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState('');

  useEffect(() => {
    const accessToken = searchParams.get('access_token');
    const callbackError = searchParams.get('error');

    if (callbackError) {
      setError(callbackError);
      return;
    }

    if (!accessToken) {
      setError('Authentik girisi tamamlanamadi.');
      return;
    }

    completeTokenLogin(accessToken)
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError('Authentik oturumu dogrulanamadi.'));
  }, [completeTokenLogin, navigate, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="glass-card p-8 w-full max-w-md text-center">
        {error ? (
          <>
            <h1 className="text-xl font-bold text-white">Giris tamamlanamadi</h1>
            <p className="text-sm text-red-300 mt-3">{error}</p>
            <Link to="/login" className="btn-primary inline-flex mt-6">
              Giris ekranina don
            </Link>
          </>
        ) : (
          <>
            <svg className="animate-spin h-9 w-9 text-primary-500 mx-auto" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <p className="text-surface-300 mt-4">Authentik oturumu aciliyor...</p>
          </>
        )}
      </div>
    </div>
  );
}
