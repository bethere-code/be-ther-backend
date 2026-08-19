export function parseAdminLogins(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const i = trimmed.indexOf(':');
    if (i < 1) continue;
    const email = trimmed.slice(0, i).trim().toLowerCase();
    const password = trimmed.slice(i + 1);
    if (email && password) map.set(email, password);
  }
  return map;
}
