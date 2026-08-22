import fs from 'node:fs';
import path from 'node:path';

/** Keep error log files for at most this many days. */
export const ERROR_LOG_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function errorLogFileForDay(logDir: string, d = new Date()): string {
  return path.join(logDir, `error-${dayStamp(d)}.log`);
}

/** Ensure log dir exists and drop files older than [ERROR_LOG_RETENTION_DAYS]. */
export function initErrorLog(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
  pruneOldErrorLogs(logDir);
}

export function pruneOldErrorLogs(logDir: string, now = Date.now()): void {
  const keepFromDay = dayStamp(new Date(now - (ERROR_LOG_RETENTION_DAYS - 1) * DAY_MS));
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('error-') || !name.endsWith('.log')) continue;
    const filePath = path.join(logDir, name);
    const dayInName = name.slice('error-'.length, -'.log'.length);
    try {
      if (/^\d{4}-\d{2}-\d{2}$/.test(dayInName) && dayInName < keepFromDay) {
        fs.unlinkSync(filePath);
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < now - ERROR_LOG_RETENTION_DAYS * DAY_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup — never break the server for log housekeeping.
    }
  }
}

export function appendErrorLog(logDir: string, entry: Record<string, unknown>): void {
  try {
    initErrorLog(logDir);
    const line = `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`;
    fs.appendFileSync(errorLogFileForDay(logDir), line, 'utf8');
  } catch {
    // Never throw from logging.
  }
}

export function logFatalError(logDir: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  appendErrorLog(logDir, {
    level: 60,
    msg: message,
    ...(stack ? { stack } : {}),
    fatal: true,
  });
}

export function startErrorLogRetention(logDir: string): NodeJS.Timeout {
  const timer = setInterval(() => pruneOldErrorLogs(logDir), DAY_MS);
  timer.unref();
  return timer;
}
