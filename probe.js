import { chromium } from 'playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PROFILE_DIR = process.env.PROFILE_DIR || '/data/profile';
const EXT_DIR = process.env.EXT_DIR || '/ext';
const LOG_FILE = process.env.LOG_FILE || '/data/probe.jsonl';
const SHOT_DIR = process.env.SHOT_DIR || '/data/shots';
const TRACK_IDS = (process.env.TRACK_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SETTLE_MS = Number(process.env.SETTLE_MS || 10000);
const LOGIN_HOLD_MS = Number(process.env.LOGIN_HOLD_MS || 0);
// >0 turns the probe into a long-running service that samples on a timer, which
// is the shape Portainer stacks expect. 0 means one shot and exit, for cron.
const INTERVAL_SEC = Number(process.env.PROBE_INTERVAL_SEC || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publicIp() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctl.signal });
    return (await r.json()).ip;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// The whole unlock is one request header, injected by a declarativeNetRequest
// rule the extension's service worker registers. If the worker never woke up,
// the rule is absent and every other number in this record is meaningless.
async function checkExtension(ctx) {
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) return { loaded: false };

  const state = await sw
    .evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const { mode } = await chrome.storage.local.get('mode');
      return {
        mode: mode ?? null,
        rules: rules.map((r) => ({
          id: r.id,
          urlFilter: r.condition?.urlFilter ?? r.condition?.regexFilter ?? null,
          headers: (r.action?.requestHeaders || []).map((h) => `${h.header}: ${h.value}`),
        })),
      };
    })
    .catch((e) => ({ error: String(e) }));

  const spoofedIp = state.rules
    ?.flatMap((r) => r.headers)
    .find((h) => h.startsWith('X-Real-IP: '))
    ?.slice('X-Real-IP: '.length);

  return { loaded: true, active: Boolean(spoofedIp), spoofedIp: spoofedIp ?? null, ...state };
}

async function checkAccount(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/nuser/account/get', { credentials: 'include' });
    const j = await r.json();
    return {
      code: j.code ?? null,
      userId: j.account?.id ?? null,
      nickname: j.profile?.nickname ?? null,
      loggedIn: Boolean(j.profile),
    };
  });
}

// A track is "grey" when NetEase hands back a null playable url for it.
async function checkTracks(page, ids) {
  if (!ids.length) return null;
  return page.evaluate(async (trackIds) => {
    const q = `ids=%5B${trackIds.join('%2C')}%5D&br=320000`;
    const r = await fetch(`/api/song/enhance/player/url?${q}`, { credentials: 'include' });
    const j = await r.json();
    const rows = Array.isArray(j.data) ? j.data : [];
    return {
      code: j.code ?? null,
      asked: trackIds.length,
      answered: rows.length,
      playable: rows.filter((d) => d && d.url).length,
      perTrack: rows.map((d) => ({ id: d.id, playable: Boolean(d.url), fee: d.fee ?? null })),
    };
  }, ids);
}

// The decisive test. Same cookies, same tracks, but sent straight from node:
// real Korean IP, no X-Real-IP header, no extension. This is exactly what the
// phone app sees. If these tracks are playable here, something on NetEase's
// side is remembering that this account is "in China" — and that memory is the
// thing the periodic web refresh keeps alive.
async function checkAsClient(ctx, ids) {
  if (!ids.length) return null;

  const cookies = await ctx.cookies('https://music.163.com');
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const q = `ids=%5B${ids.join('%2C')}%5D&br=320000`;

  const r = await fetch(`https://music.163.com/api/song/enhance/player/url?${q}`, {
    headers: {
      Cookie: cookieHeader,
      Referer: 'https://music.163.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeteaseMusicDesktop/2.10.10',
    },
  });
  const j = await r.json();
  const rows = Array.isArray(j.data) ? j.data : [];
  return {
    code: j.code ?? null,
    asked: ids.length,
    answered: rows.length,
    playable: rows.filter((d) => d && d.url).length,
    sentCookies: cookies.length,
  };
}

async function runOnce() {
  const at = new Date().toISOString();
  const record = { at, ip: await publicIp(), ok: false };

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    viewport: { width: 1280, height: 900 },
  });

  try {
    record.extension = await checkExtension(ctx).catch((e) => ({ error: String(e) }));

    // Order matters. The browser visit below sends the spoofed header, which is
    // the very thing suspected of refreshing NetEase's region cache. Measure the
    // cold state first or the probe contaminates its own experiment.
    record.clientCold = await checkAsClient(ctx, TRACK_IDS).catch((e) => ({ error: String(e) }));

    const page = await ctx.newPage();
    await page.goto('https://music.163.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(SETTLE_MS);

    record.account = await checkAccount(page).catch((e) => ({ error: String(e) }));
    record.browser = await checkTracks(page, TRACK_IDS).catch((e) => ({ error: String(e) }));

    // Same call as clientCold, now that a header-bearing request has landed.
    // cold=0 + warm>0 is the signature of a server-side region cache.
    record.clientWarm = await checkAsClient(ctx, TRACK_IDS).catch((e) => ({ error: String(e) }));
    record.ok = true;

    const shot = `${SHOT_DIR}/${at.replace(/[:.]/g, '-')}.png`;
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    record.screenshot = shot;

    // Keeps the browser alive so a human can scan the QR / enter an SMS code
    // over VNC before the profile is written back out.
    if (LOGIN_HOLD_MS > 0) {
      console.error(`[nemr] holding browser open for ${LOGIN_HOLD_MS}ms for manual login`);
      await page.waitForTimeout(LOGIN_HOLD_MS);
      record.accountAfterHold = await checkAccount(page).catch((e) => ({ error: String(e) }));
    }
  } catch (e) {
    record.error = String(e);
  } finally {
    await ctx.close().catch(() => {});
  }

  appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  console.log(JSON.stringify(record, null, 2));
  return record;
}

async function main() {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });

  if (INTERVAL_SEC <= 0) {
    const record = await runOnce();
    process.exit(record.ok ? 0 : 1);
  }

  console.error(`[nemr] service mode: sampling every ${INTERVAL_SEC}s`);
  for (;;) {
    await runOnce().catch((e) => console.error('[nemr] run failed:', e));
    await sleep(INTERVAL_SEC * 1000);
  }
}

main();
