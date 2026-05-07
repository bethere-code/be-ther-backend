import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MONGODB_URI: z.string().min(1),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),

    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

    GOOGLE_WEB_CLIENT_ID: z.string().min(1),

    OTP_DEV_LOG: z.coerce.boolean().default(false),
    OTP_TTL_MIN: z.coerce.number().int().positive().default(10),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

    BREVO_SMTP_HOST: z.string().default('smtp-relay.brevo.com'),
    BREVO_SMTP_PORT: z.coerce.number().int().default(587),
    BREVO_SMTP_USER: z.string().optional(),
    BREVO_SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().default('noreply@bether.local'),

    MEDIA_STORAGE: z.enum(['local', 'r2']).default('local'),
    PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:3000'),

    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PUBLIC_BASE_URL: z.string().optional(),
    R2_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.MEDIA_STORAGE === 'r2') {
      if (!val.R2_ACCOUNT_ID || !val.R2_ACCESS_KEY_ID || !val.R2_SECRET_ACCESS_KEY || !val.R2_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET required when MEDIA_STORAGE=r2',
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables. Copy .env.example to .env and adjust.');
  }
  return result.data;
}
