/**
 * Sidebar layout — App shell with navigation.
 */

import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../lib/api';

const RESTORE_LOCK_KEY = 'dps_restore_lock';
const THEME_KEY = 'dps_theme';

type Role = 'ADMIN' | 'PLANNER' | 'VIEWER';

const navItems: Array<{ to: string; label: string; icon: JSX.Element; roles?: Role[]; group?: 'misc' }> = [
  {
    to: '/delivery-calendar',
    label: 'Teslimat Takvimi',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3M5 11h14M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
      </svg>
    ),
  },
  {
    to: '/upload',
    label: 'Excel Yükle',
    group: 'misc',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
    ),
  },
  {
    to: '/product-info',
    label: 'Urun Bilgisi',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z" />
      </svg>
    ),
  },
  {
    to: '/order-details',
    label: 'Sipariş Detayları',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5h16M4 10h16M4 15h16M4 20h16M9 5v15M15 5v15" />
      </svg>
    ),
  },
  {
    to: '/statistics',
    label: 'İstatistikler',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 20h16M7 20v-6m5 6V8m5 12v-9" />
      </svg>
    ),
  },
  {
    to: '/settings',
    label: 'Konfigürasyon',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    to: '/purchasing',
    label: 'Satın Alım',
    group: 'misc',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    ),
  },
  {
    to: '/status-query',
    label: 'Durum Sorgulama',
    group: 'misc',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h10M4 18h7m7-3 2 2 4-4" />
      </svg>
    ),
  },
  {
    to: '/mapping-templates',
    label: 'Eşleme Şablonları',
    group: 'misc',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
  },
  {
    to: '/users',
    label: 'Kullanıcı Yönetimi',
    roles: ['ADMIN'],
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5V9H2v11h5m10 0v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6m10 0H7m10-11V7a2 2 0 00-2-2H9a2 2 0 00-2 2v2m10 0H7" />
      </svg>
    ),
  },
  {
    to: '/holidays',
    label: 'Tatil Yönetimi',
    roles: ['ADMIN', 'PLANNER'],
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3M5 11h14M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
      </svg>
    ),
  },
  {
    to: '/order-history',
    label: 'Sipariş Geçmişi',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  // Kullanicinin kendi gorunum tercihleri — rol kisiti YOK (herkes kendi ekranini
  // ayarlayabilmeli), bu yuzden ust ("primary") menu grubunda ve dizideki yeri
  // geregi Siparis Gecmisi'nin hemen altinda cikar. Sistem geneli uretim
  // parametreleri icin ayri bir sayfa var: /settings ("Konfigurasyon").
  {
    to: '/appearance',
    label: 'Görünüm Ayarları',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    ),
  },
  {
    to: '/audit-logs',
    label: 'Denetim İzleri',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
      </svg>
    ),
  },
  {
    to: '/backups',
    label: 'Sistem Yedekleri',
    roles: ['ADMIN'],
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2l-3 3-3-3H5a2 2 0 01-2-2V7z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9h8M8 12h5" />
      </svg>
    ),
  },
  {
    to: '/release-notes',
    label: 'Sürüm Notları',
    roles: ['ADMIN', 'PLANNER', 'VIEWER'],
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [backupWarning, setBackupWarning] = useState(false);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [restoreLocked, setRestoreLocked] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMiscExpanded, setIsMiscExpanded] = useState(false);
  const [isManagementExpanded, setIsManagementExpanded] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const visibleNavItems = navItems.filter((item) => !item.roles || (user?.role && item.roles.includes(user.role)));
  const primaryNavItems = visibleNavItems.filter((item) => !item.roles && item.group !== 'misc');
  const miscNavItems = visibleNavItems.filter((item) => !item.roles && item.group === 'misc');
  const managementNavItems = visibleNavItems.filter((item) => !!item.roles);

  // Sol navigasyon sabit 218px genişlikte (bkz. index.css .app-sidebar) — dar ekranlarda (telefon,
  // küçültülmüş pencere) bu, sayfa içeriğine neredeyse hiç yer bırakmayıp
  // (özellikle kendi sabit genişlikli panelleri olan sayfalarda, ör. Teslimat
  // Takvimi) ekranın "siyah"/boş görünmesine yol açıyordu. Dar viewport'ta
  // menü otomatik daraltılır (ikon-only, w-20) — kullanıcı isterse yine elle
  // genişletebilir, sadece ilk yükleme/eşiği geçme anında zorlanır.
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    const collapseForNarrowViewport = () => {
      if (mql.matches) setIsSidebarCollapsed(true);
    };
    collapseForNarrowViewport();
    mql.addEventListener('change', collapseForNarrowViewport);
    return () => mql.removeEventListener('change', collapseForNarrowViewport);
  }, []);

  useEffect(() => {
    const syncLock = () => {
      setRestoreLocked(localStorage.getItem(RESTORE_LOCK_KEY) === '1');
    };

    syncLock();
    window.addEventListener('storage', syncLock);
    window.addEventListener('dps-restore-lock-change', syncLock as EventListener);
    const interval = window.setInterval(syncLock, 500);

    return () => {
      window.removeEventListener('storage', syncLock);
      window.removeEventListener('dps-restore-lock-change', syncLock as EventListener);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.remove('theme-light', 'theme-dark');
    body.classList.remove('theme-light', 'theme-dark');
    root.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
    body.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      setBackupWarning(false);
      return;
    }

    let mounted = true;

    const loadHealth = async () => {
      try {
        const { data } = await api.get('/backups/health');
        if (mounted) {
          setBackupWarning(Boolean(data?.warning));
        }
      } catch {
        if (mounted) {
          setBackupWarning(false);
        }
      }
    };

    loadHealth();
    const interval = window.setInterval(loadHealth, 60_000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [user?.role]);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      setPendingApprovalCount(0);
      return;
    }

    let mounted = true;

    const loadPendingApprovals = async () => {
      try {
        const { data } = await api.get('/users/');
        if (!mounted) return;
        if (!Array.isArray(data)) {
          setPendingApprovalCount(0);
          return;
        }
        const pending = data.filter((item: any) => item && item.is_approved === false).length;
        setPendingApprovalCount(pending);
      } catch {
        if (mounted) {
          setPendingApprovalCount(0);
        }
      }
    };

    loadPendingApprovals();
    const interval = window.setInterval(loadPendingApprovals, 30_000);

    const onFocus = () => {
      loadPendingApprovals();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [user?.role]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }
      
      if (e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        navigate('/feedback-items');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const handleLogout = async () => {
    if (restoreLocked) {
      return;
    }
    await logout();
    navigate('/login');
  };

  const toggleSidebar = () => {
    setIsSidebarCollapsed((prev) => !prev);
  };

  const toggleMisc = () => {
    setIsMiscExpanded((prev) => !prev);
  };

  const toggleManagement = () => {
    setIsManagementExpanded((prev) => !prev);
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`app-sidebar ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
        <div className="p-3 border-b border-surface-700/50 flex justify-center">
          <button
            type="button"
            className="sidebar-collapse-toggle sidebar-collapse-toggle--top"
            onClick={toggleSidebar}
            aria-label={isSidebarCollapsed ? 'Menüyü genişlet' : 'Menüyü daralt'}
            title={isSidebarCollapsed ? 'Menüyü genişlet' : 'Menüyü daralt'}
          >
            <svg className={`w-4 h-4 transition-transform ${isSidebarCollapsed ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {!isSidebarCollapsed && <span>Menü</span>}
          </button>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
          {primaryNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={(e) => {
                if (restoreLocked && item.to !== '/backups') {
                  e.preventDefault();
                }
              }}
              className={({ isActive }) =>
                `sidebar-nav-link ${isSidebarCollapsed ? 'is-collapsed' : ''} ${
                  isActive
                    ? 'bg-primary-600/20 text-primary-400 border border-primary-500/30'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/50'
                }`
              }
            >
              {item.icon}
              {!isSidebarCollapsed && (
                <span className="flex items-center gap-2 min-w-0" title={item.label}>
                  <span className="truncate">{item.label}</span>
                  {item.to === '/backups' && backupWarning && (
                    <span className="badge badge-danger border text-[10px] px-1.5 py-0 flex-shrink-0">Uyari</span>
                  )}
                  {item.to === '/users' && pendingApprovalCount > 0 && (
                    <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1.5 flex-shrink-0">
                      {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
                    </span>
                  )}
                  {restoreLocked && item.to === '/backups' && (
                    <span className="badge badge-warning border text-[10px] px-1.5 py-0 flex-shrink-0">Kilitli</span>
                  )}
                </span>
              )}
            </NavLink>
          ))}

          {miscNavItems.length > 0 && (
            <div className={`pt-3 mt-3 border-t border-surface-700/50 ${isSidebarCollapsed ? 'sidebar-management-collapsed' : ''}`}>
              {!isSidebarCollapsed && (
                <button
                  type="button"
                  onClick={toggleMisc}
                  className="w-full flex items-center justify-between px-2 pb-2 text-[11px] uppercase tracking-wider text-surface-500 hover:text-surface-300 transition-colors"
                  aria-expanded={isMiscExpanded}
                >
                  <span>Misc</span>
                  <svg
                    className={`w-3.5 h-3.5 transition-transform ${isMiscExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}
              {(isSidebarCollapsed || isMiscExpanded) && (
                <div className="space-y-1">
                  {miscNavItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={(e) => {
                        if (restoreLocked) {
                          e.preventDefault();
                        }
                      }}
                      className={({ isActive }) =>
                        `sidebar-nav-link ${isSidebarCollapsed ? 'is-collapsed' : ''} ${
                          isActive
                            ? 'bg-primary-600/20 text-primary-400 border border-primary-500/30'
                            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/50'
                        }`
                      }
                    >
                      {item.icon}
                      {!isSidebarCollapsed && <span className="truncate" title={item.label}>{item.label}</span>}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )}

          {managementNavItems.length > 0 && (
            <div className={`pt-3 mt-3 border-t border-surface-700/50 ${isSidebarCollapsed ? 'sidebar-management-collapsed' : ''}`}>
              {!isSidebarCollapsed && (
                <button
                  type="button"
                  onClick={toggleManagement}
                  className="w-full flex items-center justify-between px-2 pb-2 text-[11px] uppercase tracking-wider text-surface-500 hover:text-surface-300 transition-colors"
                  aria-expanded={isManagementExpanded}
                >
                  <span className="flex items-center gap-2">
                    Yonetim
                    {/* Grup kapalıyken de onay bekleyen kullanıcı / yedek uyarısı
                        fark edilsin diye — eskiden bu liste hep açıktı, artık
                        katlanabilir olduğu için altındaki rozetler gizlenebilir. */}
                    {!isManagementExpanded && pendingApprovalCount > 0 && (
                      <span className="inline-flex min-w-[16px] h-[16px] items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold px-1 normal-case tracking-normal">
                        {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
                      </span>
                    )}
                    {!isManagementExpanded && backupWarning && (
                      <span className="badge badge-danger border text-[9px] px-1 py-0 normal-case tracking-normal">Uyari</span>
                    )}
                  </span>
                  <svg
                    className={`w-3.5 h-3.5 transition-transform ${isManagementExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}
              {(isSidebarCollapsed || isManagementExpanded) && (
                <div className="space-y-1">
                  {managementNavItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      onClick={(e) => {
                        if (restoreLocked && item.to !== '/backups') {
                          e.preventDefault();
                        }
                      }}
                      className={({ isActive }) =>
                        `sidebar-nav-link ${isSidebarCollapsed ? 'is-collapsed' : ''} ${
                          isActive
                            ? 'bg-primary-600/20 text-primary-400 border border-primary-500/30'
                            : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800/50'
                        }`
                      }
                    >
                      {item.icon}
                      {!isSidebarCollapsed && (
                        <span className="flex items-center gap-2 min-w-0" title={item.label}>
                          <span className="truncate">{item.label}</span>
                          {item.to === '/backups' && backupWarning && (
                            <span className="badge badge-danger border text-[10px] px-1.5 py-0 flex-shrink-0">Uyari</span>
                          )}
                          {item.to === '/users' && pendingApprovalCount > 0 && (
                            <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1.5 flex-shrink-0">
                              {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
                            </span>
                          )}
                          {restoreLocked && item.to === '/backups' && (
                            <span className="badge badge-warning border text-[10px] px-1.5 py-0 flex-shrink-0">Kilitli</span>
                          )}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>

        {/* Version */}
        {!isSidebarCollapsed && (
          <div className="px-4 pb-2">
            <span className="text-[15px] text-surface-600">v1.15.9</span>
          </div>
        )}

        {/* Theme toggle */}
        <div className="p-4 border-t border-surface-700/50">
          <button
            type="button"
            onClick={toggleTheme}
            className={`w-full flex items-center ${isSidebarCollapsed ? 'justify-center' : 'gap-3'} hover:bg-surface-800/50 rounded-lg -m-1 p-1 transition-all`}
            title={theme === 'dark' ? 'Aydinlik moda gec' : 'Karanlik moda gec'}
            aria-label={theme === 'dark' ? 'Aydinlik moda gec' : 'Karanlik moda gec'}
          >
            <div className="w-8 h-8 bg-surface-700 rounded-full flex items-center justify-center text-primary-400 flex-shrink-0">
              {theme === 'dark' ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3v2.5m0 13V21m9-9h-2.5M5.5 12H3m14.364 6.364l-1.768-1.768M8.404 8.404 6.636 6.636m10.728 0-1.768 1.768M8.404 15.596l-1.768 1.768M12 16a4 4 0 100-8 4 4 0 000 8z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 12.79A9 9 0 1111.21 3c-.05.31-.08.63-.08.95a8 8 0 008 8c.32 0 .64-.03.95-.08z" />
                </svg>
              )}
            </div>
            {!isSidebarCollapsed && (
              <p className="text-sm font-medium text-surface-200 truncate">
                {theme === 'dark' ? 'Aydınlık Mod' : 'Karanlık Mod'}
              </p>
            )}
          </button>
        </div>

        {/* Feedback */}
        <div className="p-4 border-t border-surface-700/50">
          <button
            type="button"
            onClick={() => navigate('/feedback-items')}
            className={`w-full flex items-center ${isSidebarCollapsed ? 'justify-center' : 'gap-3'} hover:bg-surface-800/50 rounded-lg -m-1 p-1 transition-all`}
            title="İstek, Öneri, Şikayet (Shift+P)"
            aria-label="İstek, Öneri, Şikayet"
          >
            <div className="w-8 h-8 bg-surface-700 rounded-full flex items-center justify-center text-primary-400 flex-shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h8M8 14h5m-7 7h12a2 2 0 002-2V7a2 2 0 00-2-2h-3l-1-2H10L9 5H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            {!isSidebarCollapsed && (
              <p className="text-sm font-medium text-surface-200 truncate">İstek, Öneri, Şikayet</p>
            )}
          </button>
        </div>

        {/* User info */}
        <div className="p-4 border-t border-surface-700/50">
          <div className={`flex items-center ${isSidebarCollapsed ? 'justify-center' : 'justify-between'}`}>
            <div className="flex items-center gap-3">
              <div 
                className="w-8 h-8 bg-surface-700 rounded-full flex items-center justify-center text-xs font-bold text-primary-400 flex-shrink-0"
                title={isSidebarCollapsed ? `${user?.username} (${user?.role})` : undefined}
              >
                {user?.username?.charAt(0).toUpperCase()}
              </div>
              {!isSidebarCollapsed && (
                <div className="min-w-0">
                  <p className="text-sm font-medium text-surface-200 truncate">{user?.username}</p>
                  <p className="text-xs text-surface-500 truncate">{user?.role}</p>
                </div>
              )}
            </div>
            {!isSidebarCollapsed && (
              <button
                id="logout-button"
                onClick={handleLogout}
                disabled={restoreLocked}
                className="p-2 rounded-lg text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                title="Çıkış Yap"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 bg-surface-950 flex flex-col">
        <div className="flex-1 min-h-0 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
