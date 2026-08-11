/**
 * Gantt task types shared across components.
 */

export interface GanttTask {
  id: string;
  text: string;
  start_date: string;
  duration: number;
  parent: string | null;
  type: 'project' | 'task';
  progress?: number;
  status?: string;
  external_id?: string;
  manual_edit?: boolean;
  quantity?: number;
  is_outsourced?: boolean;
  customer_name?: string | null;
  responsible_personnel?: string | null;
  order_date?: string | null;
  promised_date?: string | null;
  requirement_date?: string | null;
  penalty_date?: string | null;
  is_explicit_split?: boolean;
}

export interface GanttUpdatePayload {
  start_date: string;
  end_date: string;
}

export interface SplitPayload {
  ratio?: number; // Default 0.5 (50/50 split)
}

export interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'PLANNER' | 'VIEWER';
  is_approved: boolean;
}
