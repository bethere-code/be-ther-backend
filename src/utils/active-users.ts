/** Users with screen_time in this window count as "active in the app". */
export const ACTIVE_USER_WINDOW_MINUTES = 10;

export function activeUsersSince(now = Date.now()): Date {
  return new Date(now - ACTIVE_USER_WINDOW_MINUTES * 60 * 1000);
}
