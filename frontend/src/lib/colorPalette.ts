/**
 * Shared color palettes for consistent task coloring across components
 */

export const YEARLY_MONTH_WEEKEND_COLORS_DARK = [
  'rgba(239, 68, 68, 0.2)',
  'rgba(249, 115, 22, 0.2)',
  'rgba(234, 179, 8, 0.2)',
  'rgba(132, 204, 22, 0.2)',
  'rgba(34, 197, 94, 0.2)',
  'rgba(20, 184, 166, 0.2)',
  'rgba(6, 182, 212, 0.2)',
  'rgba(59, 130, 246, 0.2)',
  'rgba(99, 102, 241, 0.2)',
  'rgba(168, 85, 247, 0.2)',
  'rgba(217, 70, 239, 0.2)',
  'rgba(236, 72, 153, 0.2)',
];

export const YEARLY_MONTH_WEEKEND_COLORS_LIGHT = [
  'rgba(239, 68, 68, 0.35)',
  'rgba(249, 115, 22, 0.35)',
  'rgba(234, 179, 8, 0.35)',
  'rgba(132, 204, 22, 0.35)',
  'rgba(34, 197, 94, 0.35)',
  'rgba(20, 184, 166, 0.35)',
  'rgba(6, 182, 212, 0.35)',
  'rgba(59, 130, 246, 0.35)',
  'rgba(99, 102, 241, 0.35)',
  'rgba(168, 85, 247, 0.35)',
  'rgba(217, 70, 239, 0.35)',
  'rgba(236, 72, 153, 0.35)',
];

export const EVENT_PALETTE = [
  { bg: '#2563eb', fg: '#dbeafe' },
  { bg: '#059669', fg: '#d1fae5' },
  { bg: '#dc2626', fg: '#fee2e2' },
  { bg: '#7c3aed', fg: '#ede9fe' },
  { bg: '#0f766e', fg: '#ccfbf1' },
  { bg: '#ea580c', fg: '#ffedd5' },
  { bg: '#be185d', fg: '#fce7f3' },
  { bg: '#0369a1', fg: '#e0f2fe' },
];

export const INHOUSE_COLOR = { bg: '#2563eb', fg: '#dbeafe' };
export const OUTSOURCED_COLOR = { bg: '#ca8a04', fg: '#fefce8' };

/**
 * Get a consistent color for a task based on its ID
 * This ensures the same task always displays with the same color across all views
 */
export const getTaskColor = (taskId: string): { bg: string; fg: string } => {
  const palette = EVENT_PALETTE;
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = ((hash << 5) - hash) + taskId.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  const index = Math.abs(hash) % palette.length;
  return palette[index];
};
