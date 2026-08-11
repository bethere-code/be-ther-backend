# Be Ther Backend (Fastify + MongoDB)

API server for Be Ther: auth (email OTP via Brevo SMTP, Google ID token), JWT, posts, social actions, notifications, explore catalog, and media upload (local disk or Cloudflare R2).

## Quick start

1. Copy `.env.example` to `.env` and set at least `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `GOOGLE_WEB_CLIENT_ID` (use your real Web client ID from Google Cloud Console).
2. `npm install`
3. `npm run dev`

Optional: `npm run seed:explore` to insert explore events after MongoDB is up.

## Environment

All variables are documented in [`.env.example`](./.env.example). For plain-language onboarding (OTP flow, R2 vs local, emulator URL), see [../docs/FEATURE_NOTE_AUTH_MEDIA.md](../docs/FEATURE_NOTE_AUTH_MEDIA.md).

## Production Deployment (Docker + Nginx + Jenkins)

1. Copy `.env.production.example` to `.env.production` and fill real secrets.
2. Start backend stack:
   - `docker compose -f docker-compose.prod.yml up -d --build`
3. Verify app health:
   - `curl http://127.0.0.1:3000/health`
4. Configure Nginx with `deploy/nginx/be-ther.com.conf`:
   - Copy file to `/etc/nginx/sites-available/be-ther.com.conf`
   - Create symlink in `/etc/nginx/sites-enabled/`
   - **Required for WhatsApp previews:** `location /e/` must proxy to the API (not the marketing SPA). Without this, crawlers see bolt.new Open Graph tags.
   - `sudo nginx -t && sudo systemctl reload nginx`
5. Enable HTTPS:
   - `sudo certbot --nginx -d be-ther.com -d www.be-ther.com`

### Share link previews (WhatsApp / iMessage)

Share URLs stay `https://be-ther.com/e/:postId` (`SHARE_WEB_BASE_URL`).

| URL | What serves it | OG tags |
| --- | --- | --- |
| `/e/:id` (correct) | Fastify share route via Nginx | Event title, caption, photo |
| `/e/:id` (broken) | Marketing SPA (`index.html`) | Generic “Be Ther” + bolt.new image |
| `/api/e/:id` | Fastify (via `/api/` strip) | Event tags (works today; not used in app shares) |

After fixing Nginx, re-check:

```bash
curl -s "https://be-ther.com/e/<postId>" | grep -E 'og:title|og:image'
```

WhatsApp caches previews — after deploy, paste the link in [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/) and click **Scrape Again**, or share a fresh URL.

### Jenkins pipeline

- Use `Jenkinsfile` in this folder.
- Jenkins agent must have Docker + Docker Compose installed and permission to run Docker.
- Keep `.env.production` on the server (do not commit secrets).
- Pipeline validates (`lint`, `typecheck`) and deploys with:
  - `docker compose -f docker-compose.prod.yml up -d --build`

## Scripts

- `npm run dev` — watch mode with `tsx`
- `npm run build` / `npm start` — production build and run
- `npm run typecheck` / `npm run lint`
- `npm run seed:explore` — seed `explore_events`
