export type DeviceSnapshot = {
  platform: string;
  model: string;
  os: string;
  appVersion: string;
  appBuild: string;
  deviceId: string;
  at: Date;
};

export type DeviceSnapshotInput = {
  platform?: unknown;
  model?: unknown;
  os?: unknown;
  appVersion?: unknown;
  appBuild?: unknown;
  deviceId?: unknown;
};

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeDeviceInput(raw: DeviceSnapshotInput | undefined | null): Omit<DeviceSnapshot, 'at'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const platform = clip(raw.platform, 32);
  if (!platform) return null;
  return {
    platform,
    model: clip(raw.model, 80),
    os: clip(raw.os, 40),
    appVersion: clip(raw.appVersion, 32),
    appBuild: clip(raw.appBuild, 16),
    deviceId: clip(raw.deviceId, 128),
  };
}

/** First snapshot is write-once. Last always follows the newest login/device. */
export function applyDeviceSnapshot(
  current: { firstDevice?: DeviceSnapshot | null; lastDevice?: DeviceSnapshot | null },
  incoming: Omit<DeviceSnapshot, 'at'>,
  isNewUser: boolean,
  now: Date = new Date(),
): { firstDevice: DeviceSnapshot; lastDevice: DeviceSnapshot } {
  const last: DeviceSnapshot = { ...incoming, at: now };
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
  return {
    platform: clip(app.platform, 32) || last?.platform || '',
    model: last?.model ?? '',
    os: last?.os ?? '',
    appVersion: clip(app.version, 32),
    appBuild: clip(app.build, 16),
    deviceId: last?.deviceId ?? '',
    at: now,
  };
}
