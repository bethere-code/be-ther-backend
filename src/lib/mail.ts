import nodemailer from 'nodemailer';

import type { Env } from '../config/env.js';

export async function sendOtpEmail(env: Env, to: string, code: string): Promise<void> {
  const expiresInMinutes = env.OTP_TTL_MIN;
  const subject = 'Your Be Ther verification code';
  const text =
    `Your verification code is: ${code}\n\n` +
    `This code is valid for ${expiresInMinutes} minutes.\n` +
    'Never share your OTP with anyone.';
  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0f1724;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f1724;padding:28px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#0b111b;border:1px solid #1f2937;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 16px 28px;">
                <p style="margin:0 0 10px 0;color:#9ca3af;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">Be Ther Security</p>
                <h1 style="margin:0;color:#f9fafb;font-size:30px;line-height:1.2;font-weight:800;">Your verification code</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 24px 28px;">
                <p style="margin:0;color:#d1d5db;font-size:20px;line-height:1.5;">
                  Use this one-time password to sign in:
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 18px 28px;">
                <div style="display:inline-block;background:#111827;border:1px solid #334155;border-radius:12px;padding:18px 22px;color:#f9fafb;font-size:42px;font-weight:800;letter-spacing:0.12em;">
                  ${code}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 12px 28px;">
                <p style="margin:0;color:#e5e7eb;font-size:16px;line-height:1.6;">
                  This OTP is valid for <strong>${expiresInMinutes} minutes</strong> only.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px 28px;">
                <p style="margin:0;color:#fca5a5;font-size:15px;line-height:1.6;font-weight:600;">
                  Never share your OTP with anyone.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#111827;border-top:1px solid #1f2937;">
                <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
                  If you did not request this code, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  if (env.OTP_DEV_LOG) {
    console.info(`[OTP_DEV_LOG] to=${to} code=${code}`);
  }

  if (!env.BREVO_SMTP_USER || !env.BREVO_SMTP_PASSWORD) {
    if (env.NODE_ENV === 'production' && !env.OTP_DEV_LOG) {
      throw new Error('Email is not configured');
    }
    return;
  }

  const transporter = nodemailer.createTransport({
    host: env.BREVO_SMTP_HOST,
    port: Number(env.BREVO_SMTP_PORT), // ensure number
    secure: false, // port 587 uses STARTTLS
    requireTLS: true,
    auth: {
      user: env.BREVO_SMTP_USER,
      pass: env.BREVO_SMTP_PASSWORD,
    },
    tls: {
      servername: env.BREVO_SMTP_HOST,
    },
  });

  try {
    await transporter.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject,
      text,
      html,
    });
  } catch (err) {
    // In development, OTP_DEV_LOG is enough to continue auth flow even if SMTP is misconfigured.
    if (env.NODE_ENV !== 'production' && env.OTP_DEV_LOG) {
      console.warn('[OTP_DEV_LOG] email delivery failed, continuing in dev mode:', err);
      return;
    }
    throw err;
  }
}
