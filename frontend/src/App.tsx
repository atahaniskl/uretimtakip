/**
 * App — Root component with routing and auth.
 */

import { Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import AuthentikCallbackPage from './pages/AuthentikCallbackPage';
import UploadPage from './pages/UploadPage';
import AuditLogPage from './pages/AuditLogPage';
import MappingTemplatesPage from './pages/MappingTemplatesPage';
import BackupPage from './pages/BackupPage';
import RegisterPage from './pages/RegisterPage';
import UsersPage from './pages/UsersPage';
import HolidaysPage from './pages/HolidaysPage';
import ProductInfoPage from './pages/ProductInfoPage';
import DeliveryCalendarPage from './pages/DeliveryCalendarPage';
import FeedbackItemsPage from './pages/FeedbackItemsPage';
import OrderDetailsPage from './pages/OrderDetailsPage';
import StatisticsPage from './pages/StatisticsPage';
import StatusQueryPage from './pages/StatusQueryPage';
import PurchasingPage from './pages/PurchasingPage';
import OrderHistoryPage from './pages/OrderHistoryPage';
import SettingsPage from './pages/SettingsPage';
import AppearancePage from './pages/AppearancePage';
import ReleaseNotesPage from './pages/ReleaseNotesPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <svg className="animate-spin h-10 w-10 text-primary-500" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      </div>
    );
  }

  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/auth/authentik/callback"
        element={<AuthentikCallbackPage />}
      />
      <Route
        path="/register"
        element={isAuthenticated ? <Navigate to="/" replace /> : <RegisterPage />}
      />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Navigate to="/delivery-calendar" replace />} />
        <Route path="/gantt" element={<Navigate to="/delivery-calendar" replace />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/mapping-templates" element={<MappingTemplatesPage />} />
        <Route path="/audit-logs" element={<AuditLogPage />} />
        <Route path="/order-history" element={<OrderHistoryPage />} />
        <Route path="/backups" element={<BackupPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/holidays" element={<HolidaysPage />} />
        <Route path="/product-info" element={<ProductInfoPage />} />
        <Route path="/delivery-calendar" element={<DeliveryCalendarPage />} />
        <Route path="/status-query" element={<StatusQueryPage />} />
        <Route path="/order-details" element={<OrderDetailsPage />} />
        <Route path="/statistics" element={<StatisticsPage />} />
        <Route path="/purchasing" element={<PurchasingPage />} />
        <Route path="/feedback-items" element={<FeedbackItemsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/appearance" element={<AppearancePage />} />
        <Route path="/release-notes" element={<ReleaseNotesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#1e293b',
            color: '#f1f5f9',
            border: '1px solid #334155',
            fontSize: '13px',
          },
          success: {
            iconTheme: { primary: '#10b981', secondary: '#1e293b' },
            style: { border: '1px solid rgba(16, 185, 129, 0.4)' },
          },
          error: {
            iconTheme: { primary: '#ef4444', secondary: '#1e293b' },
            style: { border: '1px solid rgba(239, 68, 68, 0.4)' },
          },
        }}
      />
      <AppRoutes />
    </AuthProvider>
  );
}
