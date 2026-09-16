import { Schema, model } from 'mongoose';

/** Singleton admin-tunable config for event RSVP nudges (key = `event_nudges`). */
const eventNudgeSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'event_nudges' },
    /** Master switch — off stops all nudge sends + in-process timer work. */
    enabled: { type: Boolean, default: true },
    interestedEnabled: { type: Boolean, default: true },
    goingEnabled: { type: Boolean, default: true },
    /** Recipient-local quiet window for interested daily random fire [start, end). */
    quietStartHour: { type: Number, min: 0, max: 23, default: 10 },
    quietEndHour: { type: Number, min: 1, max: 24, default: 20 },
    /** Hours before event start for going reminder. */
    goingHoursBefore: { type: Number, min: 1, max: 72, default: 6 },
    /** In-process poll interval (minutes). Ignored when runner=external. */
    tickIntervalMinutes: { type: Number, min: 2, max: 30, default: 5 },
    /**
     * interval = setTimeout loop inside API process (cheap).
     * external = only POST /api/v1/internal/nudge-tick (cron/curl).
     * off = never auto-run (manual tick still allowed with secret).
     */
    runner: {
      type: String,
      enum: ['interval', 'external', 'off'],
      default: 'interval',
    },
    /** Fallback IANA when user/event TZ missing. */
    defaultTimezone: { type: String, default: 'Asia/Kolkata' },
  },
  { timestamps: true },
);

export const EventNudgeSettingsModel = model(
  'EventNudgeSettings',
  eventNudgeSettingsSchema,
);

export type EventNudgeSettings = {
  key: string;
  enabled: boolean;
  interestedEnabled: boolean;
  goingEnabled: boolean;
  quietStartHour: number;
  quietEndHour: number;
  goingHoursBefore: number;
  tickIntervalMinutes: number;
  runner: 'interval' | 'external' | 'off';
  defaultTimezone: string;
};

export const EVENT_NUDGE_SETTINGS_DEFAULTS: EventNudgeSettings = {
  key: 'event_nudges',
  enabled: true,
  interestedEnabled: true,
  goingEnabled: true,
  quietStartHour: 10,
  quietEndHour: 20,
  goingHoursBefore: 6,
  tickIntervalMinutes: 5,
  runner: 'interval',
  defaultTimezone: 'Asia/Kolkata',
};
