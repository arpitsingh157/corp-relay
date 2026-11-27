// Saves the stock universe ONCE a day to data/universe.json (skipped if the file is under 20 h old).
// Source 1: NSE index list CSVs from nsearchives.nseindia.com (static files, no cookie needed).
// Source 2: NSE live API equity-stockIndices (needs cookies, often blocked from GitHub).
// Universe = NIFTY TOTAL MARKET (Nifty 500 + Microcap 250, about 750 companies). If every source fails, the old file is kept.
'use strict';
const fs = require('fs');
const OUT = 'data/universe.json';
const NSE = 'https://www.nseindia.com';
const ARCH = 'https://nsearchives.nseindia.com/content/indices/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function csvSymbols(file) {
  const r = await fetch(ARCH + file, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*', 'Referer': NSE + '/' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(file + ' HTTP ' + r.status);
  const lines = (await r.text()).split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const i = head.indexOf('symbol');
  if (i < 0) throw new Error(file + ' has no Symbol column');
  return lines.slice(1).map((l) => (l.split(',')[i] || '').trim().toUpperCase()).filter((s) => /^[A-Z0-9&-]+$/.test(s));
}

async function apiSymbols(index) {
  const r0 = await fetch(NSE + '/', { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(20000) });
  const sc = typeof r0.headers.getSetCookie === 'function' ? r0.headers.getSetCookie() : [];
  const cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const r = await fetch(NSE + '/api/equity-stockIndices?index=' + encodeURIComponent(index), {
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': NSE + '/market-data/live-equity-market', 'Cookie': cookie },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('api HTTP ' + r.status);
  const t = (await r.text()).trim(); if (!t || t[0] === '<') throw new Error('api HTML instead of JSON');
  return (JSON.parse(t).data || []).map((x) => String(x.symbol || '').toUpperCase().trim()).filter((s) => /^[A-Z0-9&-]+$/.test(s));
}

(async () => {
  try {
    if (Date.now() - fs.statSync(OUT).mtimeMs < 20 * 3600e3) { console.log('universe: file is fresh, skipped'); return; }
  } catch (e) { /* no file yet */ }

  const sources = [
    ['csv total market', () => csvSymbols('ind_niftytotalmarket_list.csv')],
    ['csv nifty500 + microcap250', async () => [...await csvSymbols('ind_nifty500list.csv'), ...await csvSymbols('ind_niftymicrocap250_list.csv')]],
    ['api total market', () => apiSymbols('NIFTY TOTAL MARKET')],
  ];
  for (const [name, fn] of sources) {
    try {
      const syms = [...new Set(await fn())].sort();
      if (syms.length < 300) throw new Error('only ' + syms.length + ' symbols, looks wrong');
      fs.mkdirSync('data', { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: name, count: syms.length, symbols: syms }));
      console.log('universe: saved ' + syms.length + ' symbols (' + name + ')');
      return;
    } catch (e) { console.log('universe source "' + name + '" failed: ' + e.message); await sleep(1500); }
  }
  console.log('universe: every source failed, old file kept (if any)');
})().catch((e) => { console.log('universe error: ' + e.message); });
