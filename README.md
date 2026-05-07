# Be Ther Backend (Fastify + MongoDB)

API server for Be Ther: auth (email OTP via Brevo SMTP, Google ID token), JWT, posts, social actions, notifications, explore catalog, and media upload (local disk or Cloudflare R2).

## Quick start

1. Copy `.env.example` to `.env` and set at least `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `GOOGLE_WEB_CLIENT_ID` (use your real Web client ID from Google Cloud Console).
2. `npm install`
3. `npm run dev`

Optional: `npm run seed:explore` to insert explore events after MongoDB is up.

## Environment

All variables are documented in [`.env.example`](./.env.example). For plain-language onboarding (OTP flow, R2 vs local, emulator URL), see [../docs/FEATURE_NOTE_AUTH_MEDIA.md](../docs/FEATURE_NOTE_AUTH_MEDIA.md).

## Scripts

- `npm run dev` — watch mode with `tsx`
- `npm run build` / `npm start` — production build and run
- `npm run typecheck` / `npm run lint`
- `npm run seed:explore` — seed `explore_events`
