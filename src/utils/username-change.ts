/** Same bounds as signup UI: lowercase letters and digits, 3–20 chars. */
export const USERNAME_CHANGE_REGEX = /^[a-z0-9]{3,20}$/;

export const USERNAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function usernameChangeLocked(
  changedAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (changedAt == null) return false;
  const t = changedAt instanceof Date ? changedAt.getTime() : Date.parse(String(changedAt));
  if (!Number.isFinite(t)) return false;
  return now - t < USERNAME_CHANGE_COOLDOWN_MS;
}
