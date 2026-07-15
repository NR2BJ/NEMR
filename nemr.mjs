// NEMR — keeps a NetEase Music session alive and its region flag warm, with no
// browser. It replays the desktop app's cookies from the server: refreshes the
// token pair the way the app does (so the login never expires -> no 2FA), and
// sends periodic requests carrying a mainland-China X-Real-IP (so music stops
// going grey abroad). Seed cookies once with extract-macos.mjs; rotations are
// persisted back to COOKIE_FILE so the session survives restarts.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { weapi } from './weapi.mjs';

const COOKIE_FILE = process.env.COOKIE_FILE || '/data/cookies.json';
const LOG_FILE = process.env.LOG_FILE || '/data/nemr.jsonl';
const REGION_IP = process.env.REGION_IP || '211.161.244.70';
const TRACK_IDS = (process.env.TRACK_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 21600); // 6h
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeteaseMusicDesktop/3.0.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCookies() {
  try {
    return JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
  } catch {
    console.error(
      `[nemr] no cookie seed at ${COOKIE_FILE}. Run extract-macos.mjs on the ` +
        `machine with the logged-in desktop app, or drop a cookies.json there.`
    );
    process.exit(1);
  }
}

function saveCookies(cookies) {
  mkdirSync(dirname(COOKIE_FILE), { recursive: true });
  writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

const cookieHeader = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');

// Merge any Set-Cookie the server hands back (rotated tokens) into the store.
function mergeSetCookie(cookies, res) {
  const list = res.headers.getSetCookie?.() || [];
  let changed = 0;
  for (const line of list) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || value === 'EXPIRED' || value.toLowerCase() === 'deleteme') continue;
    if (cookies[name] !== value) { cookies[name] = value; changed++; }
  }
  return changed;
}

async function weapiPost(cookies, uri, payload, { regionIp } = {}) {
  const csrf = cookies['__csrf'] || '';
  const body = weapi({ ...payload, csrf_token: csrf });
  const res = await fetch(`https://music.163.com${uri}?csrf_token=${csrf}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(cookies),
      Referer: 'https://music.163.com/',
      'User-Agent': UA,
      ...(regionIp ? { 'X-Real-IP': regionIp } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function songPlayable(cookies, ids, regionIp) {
  const { json } = await weapiPost(
    cookies,
    '/weapi/song/enhance/player/url',
    { ids: `[${ids.join(',')}]`, br: 320000 },
    { regionIp }
  );
  const rows = Array.isArray(json.data) ? json.data : [];
  return { code: json.code ?? null, asked: ids.length, playable: rows.filter((d) => d && d.url).length };
}

async function runOnce(cookies) {
  const at = new Date().toISOString();
  const rec = { at, regionIp: REGION_IP };

  // 1. Refresh the token pair from mainland — the app's own keep-alive.
  const refresh = await weapiPost(cookies, '/weapi/login/token/refresh', {}, { regionIp: REGION_IP });
  const rotated = mergeSetCookie(cookies, refresh.res);
  if (rotated) saveCookies(cookies);
  rec.refresh = { code: refresh.json.code ?? null, rotated };

  // 2. Heartbeat: is the session still alive?
  const acct = await weapiPost(cookies, '/weapi/w/nuser/account/get', {}, { regionIp: REGION_IP });
  rec.loggedIn = Boolean(acct.json.profile);
  rec.userId = acct.json.profile?.userId ?? null;

  // 3. Observe the region flag. phone = no header (what your phone sees),
  //    china = with header (what keeps the flag warm).
  if (TRACK_IDS.length) {
    rec.phone = await songPlayable(cookies, TRACK_IDS, null).catch((e) => ({ error: String(e) }));
    rec.china = await songPlayable(cookies, TRACK_IDS, REGION_IP).catch((e) => ({ error: String(e) }));
  }

  appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
  if (!rec.loggedIn) {
    console.error('[nemr] session is no longer logged in — re-seed cookies from the desktop app.');
  }
  return rec;
}

async function main() {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const cookies = loadCookies();
  if (!cookies['MUSIC_U'] || !cookies['__csrf']) {
    console.error('[nemr] cookie seed is missing MUSIC_U and/or __csrf.');
    process.exit(1);
  }

  if (INTERVAL_SEC <= 0) {
    const rec = await runOnce(cookies);
    process.exit(rec.loggedIn ? 0 : 1);
  }
  console.error(`[nemr] running every ${INTERVAL_SEC}s; region IP ${REGION_IP}`);
  for (;;) {
    await runOnce(cookies).catch((e) => console.error('[nemr] run failed:', e));
    await sleep(INTERVAL_SEC * 1000);
  }
}

main();
