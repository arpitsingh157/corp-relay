// Saves the stock universe ONCE a day to data/universe.json (skipped if the file is under 20 h old).
// Universe = NSE "NIFTY TOTAL MARKET" (about the top 750 companies by full market cap, which is roughly the 7-8k crore and above group).
// If the fetch fails or looks wrong, the old file is kept. Never fails the job.
'use strict';
const fs = require('fs');
const OUT = 'data/universe.json';
const NSE = 'https://www.nseindia.com';
const INDEX = process.env.UNIVERSE_INDEX || 'NIFTY TOTAL MARKET';
const MIN_FFMC_CR = Number(process.env.MIN_FFMC_CR) || 0;   // optional extra cut on free-float cap (crore); 0 = off
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCookie() {
  const r = await fetch(NSE + '/', { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  return sc.map((c) => c.split(';')[0]).join('; ');
}

(async () => {
  try {
    const st = fs.statSync(OUT);
    if (Date.now() - st.mtimeMs < 20 * 3600e3) { console.log('universe: file is fresh, skipped'); return; }
  } catch (e) { /* no file yet */ }

  let rows = null;
  for (let a = 0; a < 3 && !rows; a++) {
    try {
      const cookie = await getCookie();
      const r = await fetch(NSE + '/api/equity-stockIndices?index=' + encodeURIComponent(INDEX), {
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9', 'Referer': NSE + '/market-data/live-equity-market', 'Cookie': cookie },
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = (await r.text()).trim(); if (!t || t[0] === '<') throw new Error('HTML instead of JSON');
      rows = JSON.parse(t).data || [];
    } catch (e) { console.log('universe attempt ' + (a + 1) + ' failed: ' + e.message); await sleep(2000); }
  }
  if (!rows) { console.log('universe: could not fetch, old file kept'); return; }

  const syms = [];
  const cap = {};
  for (const r of rows) {
    const s = String(r.symbol || '').toUpperCase().trim();
    if (!s || /\s/.test(s) || s === INDEX.toUpperCase()) continue;       // first row is the index itself
    const cr = Number(r.ffmc) > 0 ? Number(r.ffmc) / 1e7 : null;
    if (MIN_FFMC_CR && cr != null && cr < MIN_FFMC_CR) continue;
    syms.push(s); cap[s] = cr == null ? null : Math.round(cr);
  }
  if (syms.length < 300) { console.log('universe: only ' + syms.length + ' symbols, looks wrong, old file kept'); return; }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), index: INDEX, count: syms.length, symbols: syms.sort(), ffmcCr: cap }));
  console.log('universe: saved ' + syms.length + ' symbols (' + INDEX + ')');
})().catch((e) => { console.log('universe error: ' + e.message); });
