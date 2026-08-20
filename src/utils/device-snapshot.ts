export type DeviceLocation = {
  lat: number;
  lng: number;
  accuracyM?: number;
};

export type DeviceSnapshot = {
  platform: string;
  model: string;
  os: string;
  appVersion: string;
  appBuild: string;
  deviceId: string;
  /** Mongoose may store null; treat as missing. */
  location?: DeviceLocation | null;
  at: Date;
};

export type DeviceSnapshotInput = {
  platform?: unknown;
  model?: unknown;
  os?: unknown;
  appVersion?: unknown;
  appBuild?: unknown;
  deviceId?: unknown;
  location?: unknown;
};

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeLocationInput(raw: unknown): DeviceLocation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const lat = typeof o.lat === 'number' ? o.lat : Number(o.lat);
  const lng = typeof o.lng === 'number' ? o.lng : Number(o.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  const accuracyRaw = o.accuracyM;
  const accuracyM =
    accuracyRaw === undefined || accuracyRaw === null
      ? undefined
      : Number(accuracyRaw);
  return {
    lat,
    lng,
    ...(Number.isFinite(accuracyM) && accuracyM! >= 0
      ? { accuracyM: Math.min(accuracyM!, 100_000) }
      : {}),
  };
}

export function normalizeDeviceInput(
  raw: DeviceSnapshotInput | undefined | null,
): Omit<DeviceSnapshot, 'at'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const platform = clip(raw.platform, 32);
  if (!platform) return null;
  const location = normalizeLocationInput(raw.location);
  return {
    platform,
    model: clip(raw.model, 80),
    os: clip(raw.os, 40),
    appVersion: clip(raw.appVersion, 32),
    appBuild: clip(raw.appBuild, 16),
    deviceId: clip(raw.deviceId, 128),
    ...(location ? { location } : {}),
  };
}

/** First snapshot is write-once. Last always follows the newest login/device. */
export function applyDeviceSnapshot(
  current: { firstDevice?: DeviceSnapshot | null; lastDevice?: DeviceSnapshot | null },
  incoming: Omit<DeviceSnapshot, 'at'>,
  isNewUser: boolean,
  now: Date = new Date(),
): { firstDevice: DeviceSnapshot; lastDevice: DeviceSnapshot } {
  const location =
    incoming.location ?? normalizeLocationInput(current.lastDevice?.location) ?? undefined;
  const last: DeviceSnapshot = {
    platform: incoming.platform,
    model: incoming.model,
    os: incoming.os,
    appVersion: incoming.appVersion,
    appBuild: incoming.appBuild,
    deviceId: incoming.deviceId,
    ...(location ? { location } : {}),
    at: now,
  };
  if (isNewUser || !current.firstDevice) {
    return { firstDevice: last, lastDevice: last };
  }
  return { firstDevice: current.firstDevice, lastDevice: last };
}

/** App store update without a new login — lastDevice app fields only. */
export function applyAppVersionToLast(
  last: DeviceSnapshot | undefined | null,
  app: { version: string; build: string; platform?: string },
  now: Date = new Date(),
): DeviceSnapshot {
  const location = normalizeLocationInput(last?.location);
  return {
    platform: clip(app.platform, 32) || last?.platform || '',
    model: last?.model ?? '',
    os: last?.os ?? '',
    appVersion: clip(app.version, 32),
    appBuild: clip(app.build, 16),
    deviceId: last?.deviceId ?? '',
    ...(location ? { location } : {}),
    at: now,
  };
}
