import { NotificationType } from '@prisma/client';

const LEAD_TYPES: NotificationType[] = [
  NotificationType.LEAD_CAPTURED,
  NotificationType.LEAD_ASSIGNED,
  NotificationType.LEAD_UPDATED,
  NotificationType.LEAD_DELETED,
];

/** Frontend path a notification opens (device push, email button) — mirrors the in-app bell. */
export function notificationPath(n: { type: NotificationType; leadId: string | null; taskId: string | null }): string {
  if (n.type === NotificationType.TASK_ALLOTTED) return '/follow-ups';
  if (n.type === NotificationType.TRIP_SHARED) return '/trips';
  if (n.leadId) return `/leads/${n.leadId}`;
  if (n.taskId) return '/todo';
  return LEAD_TYPES.includes(n.type) ? '/leads' : '/dashboard';
}
