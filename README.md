# NEMR — NetEase Music Refresher

Keeps NetEase Music working outside mainland China, without a browser and
without re-logging in.

If you use NetEase Music from Korea/Japan/anywhere abroad, two things keep
breaking:

1. **Music goes grey.** Every few days most songs get region-locked.
2. **You get logged out.** The web session drops on its own, and logging back in
   means 2FA every time (SMS code / QR scan / app approval).

NEMR runs on a server and quietly handles both. You extract your desktop app's
session once, paste it into one environment variable, and deploy. That's it.

## How it works

Two small tricks, both verified against the live API:

- **Grey music is just one header.** NetEase decides your region from an
  `X-Real-IP` header. NEMR sends every request with a mainland-China IP, so the
  server keeps serving real playback URLs instead of grey ones. (This is exactly
  what the NetEaseMusicWorld browser extension does — NEMR just does it from the
  server, no browser needed.)
- **Staying logged in = refreshing, not re-logging.** The desktop app never logs
  out because it holds a refresh token and quietly renews its session. The web
  player doesn't. NEMR does what the app does: it calls the refresh endpoint on a
  timer. Since it reuses an existing session instead of starting a new login,
  **2FA never comes up.**

Every 6 hours the container refreshes the session, checks it's still alive, and
(optionally) logs whether your grey tracks are playable. No dependencies — the
NetEase request crypto is implemented on Node's built-in `crypto`.

## Setup

### 1. Get your cookie line (once, on your Mac)

Run this on the machine where the **desktop app is logged in**:

```bash
python3 extract-macos.py | pbcopy
```

It reads the app's stored session and copies a single `key=value; key=value; …`
line to your clipboard. That line **is** your login — don't paste it anywhere
except step 2.

> No Python? macOS installs it with `xcode-select --install`.
>
> **Windows / no desktop app:** the extractor is macOS-only for now. As a
> fallback, log into the web player, open DevTools → Application → Cookies, and
> join the cookies into one `name=value; name=value` line. Include at least
> `MUSIC_U` and `__csrf`; add `MUSIC_R_T` if present (without it, grey-unlock
> still works but login refresh won't).

### 2. Deploy in Portainer

**Stacks → Add stack → Repository:**

| Field | Value |
|-------|-------|
| Repository URL | `https://github.com/NR2BJ/NEMR` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

Under **Environment variables**, add:

| Name | Value |
|------|-------|
| `NEMR_COOKIE` | the line from step 1 |
| `TRACK_IDS` | *(optional)* grey track IDs to watch, comma-separated |

Click **Deploy**. Done.

The image builds on your server straight from this repo — no Docker Hub, no
registry. Your cookies and logs live in a Docker-managed volume (`nemr-data`)
that's created automatically. Nothing to place on disk, no paths to configure.

## Checking it works

Open the container logs in Portainer. A healthy run looks like:

```
[nemr] loaded 23 cookies from env; persistence ON (/data/cookies.json)
{"at":"…","refresh":{"code":200},"loggedIn":true,"userId":12345678,…}
```

`loggedIn: true` and `refresh.code: 200` mean you're good. The `userId` should be
**your** account — a quick sanity check that the right session loaded.

If something's wrong, the log tells you:

| What you see | Meaning |
|--------------|---------|
| `loggedIn: false`, `userId: null`, `refresh.code` ≠ 200 | Session died — re-seed (below) |
| `seed is missing MUSIC_U and/or __csrf` at startup | Bad cookie line — re-run the extractor |
| `phone: 0`, `china: N` (with `TRACK_IDS`) | Region-lock was active and the header unlocked it — working as intended |

## Re-seeding (when the login finally dies)

Redo step 1 for a fresh line, update `NEMR_COOKIE`, and redeploy the stack. If
the new line is a different session, NEMR swaps to it automatically — no need to
touch the volume.

## Environment variables

| Name | Default | Purpose |
|------|---------|---------|
| `NEMR_COOKIE` | *(required first run)* | Your session cookie line |
| `TRACK_IDS` | *(none)* | Grey track IDs to observe, comma-separated |
| `REGION_IP` | `211.161.244.70` | Mainland-China IP for the `X-Real-IP` header |
| `INTERVAL_SEC` | `21600` (6h) | How often to refresh |

## Honest caveats

- **Long-term durability isn't proven yet.** Refresh returns 200 and rotates the
  token pair without breaking the app's own login — all verified. Whether it
  keeps a session alive for *months* only the logs will tell. If `loggedIn` ever
  goes false, that assumption was wrong; just re-seed.
- **`211.161.244.70` is hardcoded upstream** and could stop working someday. Swap
  `REGION_IP` if it does.
- The `/weapi/…` endpoints are unofficial. NetEase can change them anytime.
- The extractor targets the macOS app's current storage format (v3.x); a big app
  update could break it.

## Files

| File | Role |
|------|------|
| `extract-macos.py` | One-time cookie extractor (runs on your Mac) |
| `nemr.mjs` | The service: refresh, heartbeat, observe, repeat |
| `weapi.mjs` | NetEase request encryption, zero dependencies |
| `Dockerfile` / `docker-compose.yml` | Tiny `node:alpine` image + named volume |
