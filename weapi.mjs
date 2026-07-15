// NetEase "weapi" request encryption, implemented on Node's built-in crypto so
// this repo has zero npm dependencies. weapi double-AES-encrypts the JSON body
// and RSA-encrypts the random second key — the same scheme the web player uses.
import crypto from 'node:crypto';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PUBKEY = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7' +
  'b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280' +
  '104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932' +
  '575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b' +
  '3ece0462db0a22b8e7';

function aes(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}

// RSA with no padding: reverse the key text, treat as a big-endian integer,
// raise to the public exponent mod the modulus.
function rsa(text) {
  const rev = Buffer.from([...text].reverse().join(''), 'utf8').toString('hex');
  let base = BigInt('0x' + rev) % BigInt('0x' + MODULUS);
  const mod = BigInt('0x' + MODULUS);
  let exp = BigInt('0x' + PUBKEY);
  let r = 1n;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r.toString(16).padStart(256, '0');
}

export function weapi(obj) {
  const text = JSON.stringify(obj);
  let secret = '';
  const rnd = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) secret += BASE62[rnd[i] % 62];
  return { params: aes(aes(text, PRESET_KEY), secret), encSecKey: rsa(secret) };
}
