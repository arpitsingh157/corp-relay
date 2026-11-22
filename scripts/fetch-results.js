// Fetches quarterly result figures (NSE XBRL) and writes one small file per stock: data/results/<SYMBOL>.json
// The corporate-actions Worker reads these files from GitHub when NSE refuses the Worker itself (see getResultRelay in the Worker).
// Runs on GitHub Actions (Node 20). Needs NO secrets. Works through the stocks that need it, MAX_SYMBOLS per run, newest filings first.
'use strict';
const fs = require('fs');
const path = require('path');

const NSE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const UNIVERSE_URL = 'https://angelone.arpit332.workers.dev/fno-list';
const DIR = 'data/results';
const RAW = 'data/corp-raw.json';
const MAX = Number(process.env.MAX_SYMBOLS) || 25;
const DEADLINE = Date.now() + 11 * 60 * 1000;      // stop starting new stocks after 11 minutes
const CR = 1e7;                                    // XBRL carries absolute rupees
const BACK_DAYS = 35;                              // board meetings this far back are checked for missing figures
const RETRY_MS = 3 * 3600e3;                       // a stock that gave nothing is not retried for 3 h
const CONS_WAIT_MS = 48 * 3600e3;                  // standalone-only: keep waiting for the consolidated filing this long
const IST = 5.5 * 3600e3;
const MONS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- small helpers (same logic as the Worker) ---------- */
const dayMs = (v) => { const m = /^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{4})/.exec(String(v || '').trim()); return m && MONS[m[2].toLowerCase()] != null ? Date.UTC(+m[3], MONS[m[2].toLowerCase()], +m[1]) : null; };
const stampMs = (v) => { const d = dayMs(v); if (d == null) return 0; const t = /(\d{2}):(\d{2}):(\d{2})/.exec(String(v)); return d + (t ? (+t[1] * 3600 + +t[2] * 60 + +t[3]) * 1000 : 0); };
const isCons = (r) => /^consol/i.test(String(r.consolidated || ''));
// "16-Oct-2026 15:42:10" or "2026-10-16 15:42:10" (IST) -> epoch ms (UTC), 0 if unknown
function istMs(v) {
  const s = String(v || '').trim(); let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s))) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - IST;
  const d = dayMs(s); if (d == null) return 0;
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s.replace(/^\d{1,2}-[A-Za-z]+-\d{4}/, ''));
  return d + (t ? (+t[1] * 3600 + +t[2] * 60 + +(t[3] || 0)) * 1000 : 0) - (t ? IST : 0);
}
// last finished calendar quarter (IST today): in November -> 30 Sep
function expectedQe(nowMs) { const d = new Date(nowMs + IST); return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 0); }
const fileOf = (sym) => path.join(DIR, sym.replace(/[^A-Z0-9-]/g, '_') + '.json');

/* ---------- NSE access ---------- */
let cookie = '', cookieAt = 0;
async function warm() {
  if (cookie && Date.now() - cookieAt < 240000) return;
  const r = await fetch(NSE + '/', { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  cookie = sc.map((c) => c.split(';')[0]).join('; '); cookieAt = Date.now();
}
async function nseJson(p, qs) {
  for (let a = 0; a < 2; a++) {
    await warm();
    const r = await fetch(NSE + p + '?' + qs, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9', 'Referer': NSE + '/companies-listing/corporate-filings-actions', 'Cookie': cookie }, signal: AbortSignal.timeout(25000) });
    if (r.ok) {
      const t = (await r.text()).trim(); if (!t || t[0] === '<') throw new Error('HTML instead of JSON');
      const j = JSON.parse(t); return Array.isArray(j) ? j : (j.data || j.results || []);
    }
    cookie = ''; if (a === 1) throw new Error('HTTP ' + r.status);
    await sleep(1500);
  }
}
async function xbrlText(u) {
  await warm();
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml,*/*', 'Referer': NSE + '/', 'Accept-Language': 'en-IN,en;q=0.9', 'Cookie': cookie }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('XBRL download HTTP ' + r.status);
  const x = await r.text();
  if (!/contextRef=/i.test(x)) throw new Error('not XBRL (' + x.slice(0, 60).replace(/\s+/g, ' ') + ')');
  return x;
}

/* ---------- XBRL reading (copied from the Worker so the figures are identical) ---------- */
function parseXbrl(xml) {
  const ctx = {};
  const cre = /<(?:[\w.-]+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?context>/g;
  let m;
  while ((m = cre.exec(xml))) {
    const body = m[2];
    if (/<(?:[\w.-]+:)?(explicitMember|typedMember|scenario)\b/i.test(body)) continue;
    const st = /<(?:[\w.-]+:)?startDate>\s*([^<\s]+)/.exec(body), en = /<(?:[\w.-]+:)?endDate>\s*([^<\s]+)/.exec(body);
    if (st && en) ctx[m[1]] = { start: st[1], end: en[1] };
  }
  const facts = {};
  const names = new Set();
  const fre = /<(?:[\w.-]+:)?([A-Za-z][A-Za-z0-9_]*)\s[^>]*?contextRef="([^"]+)"[^>]*>\s*([^<]*?)\s*<\//g;
  let unitText = null, f;
  while ((f = fre.exec(xml))) {
    const name = f[1], cid = f[2], val = f[3];
    if (/ScaleOfFigures|LevelOfRounding/i.test(name) && val) unitText = val;
    const n = Number(String(val).replace(/,/g, ''));
    if (val === '' || !isFinite(n)) continue;
    const k = name.toLowerCase();
    names.add(name);
    (facts[k] = facts[k] || {});
    if (facts[k][cid] === undefined) facts[k][cid] = n;
  }
  const pickFact = (cands, cid, prefix, test) => {
    for (const c of cands) { const v = facts[c.toLowerCase()]; if (v && v[cid] !== undefined) return v[cid]; }
    if (prefix) { for (const k of Object.keys(facts)) if (k.startsWith(prefix.toLowerCase()) && facts[k][cid] !== undefined) return facts[k][cid]; }
    if (test) { for (const k of Object.keys(facts)) if (facts[k][cid] !== undefined && test(k)) return facts[k][cid]; }
    return null;
  };
  const byEnd = {};
  Object.entries(ctx).forEach(([cid, c]) => {
    const days = (Date.parse(c.end) - Date.parse(c.start)) / 86400000;
    if (!(days >= 80 && days <= 100)) return;
    const row = {
      fromDate: c.start, toDate: c.end,
      revenue: pickFact(['RevenueFromOperations', 'RevenueFromOperationsNet', 'InterestEarned'], cid),
      income: pickFact(['Income', 'TotalIncome'], cid),
      pbt: pickFact(['ProfitBeforeTax', 'ProfitLossBeforeTax', 'ProfitLossFromOrdinaryActivitiesBeforeTax', 'ProfitBeforeTaxFromContinuingOperations'], cid, null, (k) => k.includes('beforetax') && !/exceptional|discontinu|extraordinary|provision/.test(k)),
      exceptional: pickFact(['ExceptionalItemsBeforeTax', 'ExceptionalItems'], cid),
      pat: pickFact(['ProfitLossForPeriod', 'ProfitLossForThePeriod', 'ProfitLossForPeriodFromContinuingOperations', 'NetProfitLossForThePeriod', 'ProfitLossFromOrdinaryActivitiesAfterTax'], cid),
      other: pickFact(['OtherIncome'], cid),
      expenses: pickFact(['Expenses', 'TotalExpenses'], cid),
      finance: pickFact(['FinanceCosts'], cid),
      dep: pickFact(['DepreciationDepletionAndAmortisationExpense', 'DepreciationAndAmortisationExpense'], cid),
      tax: pickFact(['TaxExpense', 'TaxExpenseForPeriod'], cid, null, (k) => k.includes('taxexpense') && !/deferred|current|earlier|other/.test(k)),
      patOwners: pickFact(['ProfitOrLossAttributableToOwnersOfParent'], cid),
      eps: pickFact(['BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations', 'BasicEarningsLossPerShareFromContinuingOperations'], cid, 'BasicEarningsLossPerShare', (k) => k.includes('pershare') && !k.includes('dilut')),
      bank: pickFact(['InterestEarned'], cid) != null,
    };
    if (row.pbt == null && row.pat != null && row.tax != null) row.pbt = row.pat + row.tax;
    const have = row.revenue != null || row.income != null || row.pat != null;
    if (have && (!byEnd[c.end] || (row.pat != null && byEnd[c.end].pat == null))) byEnd[c.end] = row;
  });
  const quarters = Object.values(byEnd).sort((x, y) => y.toDate.localeCompare(x.toDate));
  return { unit: unitText, quarters, contextCount: Object.keys(ctx).length, factNames: [...names].slice(0, 400) };
}
const MONEY = ['revenue', 'income', 'pbt', 'exceptional', 'pat', 'other', 'expenses', 'finance', 'dep', 'tax', 'patOwners'];
function toCrores(q, div) {
  const o = { ...q };
  MONEY.forEach((k) => { o[k] = q[k] == null ? null : q[k] / div; });
  const other = o.other != null ? o.other : (o.income != null && o.revenue != null ? o.income - o.revenue : null);
  o.ebit = !q.bank && o.pbt != null && o.finance != null && other != null ? o.pbt + o.finance - other - (o.exceptional || 0) : null;
  return o;
}

/* ---------- one stock: same selection rules as the Worker's resLive step 3a ---------- */
async function getIntRows(sym) {
  const enc = encodeURIComponent(sym);
  for (const qs of [`index=equities&symbol=${enc}&period_ended=all&type=Integrated%20Filing-%20Financials`, `index=equities&symbol=${enc}`]) {
    try { const rows = await nseJson('/api/integrated-filing-results', qs); if (rows.length) return rows; } catch (e) { if (qs.endsWith('Financials') === false) throw e; }
    await sleep(500);
  }
  return [];
}
async function buildBlock(sym) {
  const intRows = await getIntRows(sym);
  let cand = intRows.filter((r) => r && /\.xml(\?|$)/i.test(String(r.xbrl || '')) && dayMs(r.qe_Date) != null);
  const fin = cand.filter((r) => /financial/i.test(String(r.type || '')));
  if (fin.length) cand = fin;
  if (!cand.length) return { error: 'no filing rows with an XBRL link (' + intRows.length + ' rows)' };
  const newestQ = Math.max(...cand.map((r) => dayMs(r.qe_Date)));
  const consNow = cand.some((r) => dayMs(r.qe_Date) === newestQ && isCons(r));
  const consExpected = cand.some(isCons);
  const useCons = consNow;                                   // consolidated if the newest quarter has it, else standalone
  const byQe = new Map();
  cand.forEach((r) => {
    if (isCons(r) !== useCons) return;
    const q = dayMs(r.qe_Date), t = stampMs(r.revised_Date || r.broadcast_Date || r.creation_Date), old = byQe.get(q);
    if (!old || t > old.t) byQe.set(q, { q, t, url: r.xbrl, at: r.broadcast_Date || '' });
  });
  const qes = [...byQe.values()].sort((a, b) => b.q - a.q);
  if (!qes.length) return { error: 'no filing for the chosen basis' };
  const latest = qes[0];
  const near = (days) => qes.find((x) => x !== latest && Math.abs((latest.q - x.q) / 86400000 - days) <= 20);
  const picks = [latest, near(91), near(365)].filter(Boolean);
  const merged = new Map(); let unitText = null;
  for (const pk of picks) {
    try {
      const p = parseXbrl(await xbrlText(pk.url));
      unitText = unitText || p.unit;
      p.quarters.forEach((q) => { if (!merged.has(q.toDate) || Date.parse(q.toDate) === pk.q) merged.set(q.toDate, q); });
    } catch (e) { console.log('    xbrl failed: ' + e.message); }
    await sleep(400);
  }
  const quarters = [...merged.values()].sort((x, y) => y.toDate.localeCompare(x.toDate)).map((q) => toCrores(q, CR));
  if (!quarters.length || quarters[0].toDate !== new Date(latest.q).toISOString().slice(0, 10)) return { error: 'the newest quarter could not be read' };
  return { consExpected, block: { basis: useCons ? 'cons' : 'stand', qe: latest.q, atMs: latest.t, at: latest.at, url: latest.url, rawUnit: unitText, quarters } };
}

// A board meeting counts as a RESULT meeting only when its purpose / agenda text says so. The company name at the start of bm_desc
// ("HDB FINANCIAL SERVICES LTD has informed the Exchange about ...") is cut off first, so a name containing "Financial" is not a match,
// and "fund raising", "annual general meeting" and similar agendas are not results.
function isResultMeeting(row) {
  const purpose = String(row.bm_purpose || row.purpose || '');
  let desc = String(row.bm_desc || row.subject || '');
  const cut = desc.search(/\bto consider\b/i);
  if (cut >= 0) desc = desc.slice(cut);
  else desc = desc.replace(/^.*?\bhas informed the exchange\b/i, '');
  return /\bresults?\b|\bquarterly\b|\bunaudited\b|\baudited\b|\bfinancial\s+statements?\b/i.test(purpose + ' ' + desc);
}

function isComplete(entry, E, now) {
  const c = entry && entry.bases && entry.bases.cons, s = entry && entry.bases && entry.bases.stand;
  const b = c && (!s || c.qe >= s.qe) ? c : (s || c);
  if (!b || b.qe < E) return false;
  if (b.basis === 'stand' && entry.consExpected && now - (b.atMs || 0) < CONS_WAIT_MS) return false;
  return true;
}

// One small index of every stock whose figures were filed in the last 45 days: the Worker uses it to show the "Result out" pill
// even when NSE's board-meeting list has no row for that stock. Written only when something changed.
function writeIndex() {
  const now = Date.now(), items = {};
  for (const f of fs.readdirSync(DIR).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let e; try { e = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (x) { continue; }
    if (!e || !e.sym || !e.bases) continue;
    const c = e.bases.cons, s = e.bases.stand;
    const b = c && (!s || c.qe >= s.qe) ? c : (s || c);
    if (!b || !b.atMs) continue;
    const filedUtc = b.atMs - IST;                          // atMs holds the IST wall-clock time as if it were UTC
    const day = new Date(b.atMs).toISOString().slice(0, 10);
    if (now - filedUtc > 45 * 864e5) continue;              // only recent filings
    if ((Date.parse(day) - b.qe) / 864e5 > 100) continue;   // a revised old quarter is not a new result
    items[e.sym] = { qe: new Date(b.qe).toISOString().slice(0, 10), day, outAt: new Date(filedUtc).toISOString() };
  }
  const file = path.join(DIR, '_index.json');
  let oldItems = null; try { oldItems = JSON.parse(fs.readFileSync(file, 'utf8')).items; } catch (x) { /* first time */ }
  if (oldItems && JSON.stringify(oldItems) === JSON.stringify(items)) { console.log('index unchanged (' + Object.keys(items).length + ' stocks)'); return; }
  fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), items }));
  console.log('index written: ' + Object.keys(items).length + ' stocks');
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  let raw; try { raw = JSON.parse(fs.readFileSync(RAW, 'utf8')); } catch (e) { console.log('data/corp-raw.json not found - nothing to do'); return; }
  const now = Date.now(), E = expectedQe(now);

  let uni = null;
  try {
    const r = await fetch(UNIVERSE_URL, { signal: AbortSignal.timeout(20000) });
    if (r.ok) { const j = await r.json(); uni = new Set([...(j.nifty500 || []).map((x) => x && x.symbol), ...(j.fnoSymbols || [])].filter(Boolean).map((s) => String(s).toUpperCase())); if (!uni.size) uni = null; }
  } catch (e) { /* no filter */ }
  console.log('stock list: ' + (uni ? uni.size + ' symbols' : 'not available, no filter'));

  // candidates: fresh filings (newest first), then board meetings of the last BACK_DAYS days (newest first)
  const cand = new Map();   // sym -> { fresh: epoch ms of newest filing, meet: epoch ms of meeting }
  const bump = (sym, key, v) => { if (!sym) return; const c = cand.get(sym) || { fresh: 0, meet: 0, prio: 0 }; if (v > c[key]) c[key] = v; cand.set(sym, c); };
  (raw.nseFil || []).forEach((r) => bump(String(r.symbol || '').toUpperCase().trim(), 'fresh', istMs(r.an_dt || r.sort_date) || now));
  // your own stocks (priority.txt in the repo + the symbols box of "Run workflow"): always fetched first, whatever their result date
  let prioFile = ''; try { prioFile = fs.readFileSync('priority.txt', 'utf8'); } catch (e) { /* no file */ }
  const prio = [process.env.SYMBOLS || '', prioFile].join(',').split(/[\s,;]+/).map((x) => x.toUpperCase().trim()).filter((x) => /^[A-Z0-9&-]+$/.test(x));
  prio.forEach((x) => bump(x, 'prio', 1));
  console.log('priority stocks: ' + (prio.length ? prio.join(', ') : 'none'));
  const lo = now - BACK_DAYS * 864e5;
  (raw.nseBm || []).forEach((r) => {
    const d = dayMs(r.meetingDate || r.bm_date || r.date);
    if (d == null || d > now || d < lo) return;
    if (!isResultMeeting(r)) return;
    bump(String(r.bm_symbol || r.symbol || '').toUpperCase().trim(), 'meet', d);
  });
  const todo = [...cand.entries()].filter(([s, c]) => c.prio || !uni || uni.has(s)).sort((a, b) => (b[1].prio - a[1].prio) || (b[1].fresh - a[1].fresh) || (b[1].meet - a[1].meet));
  console.log('candidates: ' + todo.length + ', will process up to ' + MAX);

  let done = 0, ok = 0, failed = 0, skipped = 0;
  for (const [sym, c] of todo) {
    if (done >= MAX || Date.now() > DEADLINE) break;
    let ex = null; try { ex = JSON.parse(fs.readFileSync(fileOf(sym), 'utf8')); } catch (e) { /* new */ }
    const savedMs = ex && ex.savedAt ? Date.parse(ex.savedAt) : 0;
    const freshNow = c.fresh > savedMs;
    if (ex && isComplete(ex, E, now) && !freshNow) { skipped++; continue; }
    if (ex && ex.lastTry && now - Date.parse(ex.lastTry) < RETRY_MS && !freshNow) { skipped++; continue; }
    done++;
    let res;
    try { res = await buildBlock(sym); } catch (e) { res = { error: String(e.message || e) }; }
    const base = ex || { sym, bases: {} };
    if (res.block) {
      const old = base.bases[res.block.basis];
      const next = { sym, savedAt: new Date().toISOString(), consExpected: !!res.consExpected, pdf: base.pdf || null, bases: { ...base.bases } };
      if (!old || old.qe <= res.block.qe) next.bases[res.block.basis] = res.block;
      fs.writeFileSync(fileOf(sym), JSON.stringify(next));
      ok++; console.log(sym.padEnd(14) + 'ok  ' + res.block.basis + ' quarter ended ' + new Date(res.block.qe).toISOString().slice(0, 10));
    } else {
      failed++; console.log(sym.padEnd(14) + 'FAILED ' + res.error);
      fs.writeFileSync(fileOf(sym), JSON.stringify({ ...base, sym, lastTry: new Date().toISOString() }));
    }
    await sleep(900);
  }
  writeIndex();
  console.log('\nprocessed ' + done + ' (ok ' + ok + ', failed ' + failed + '), skipped ' + skipped + ', left for next runs ' + Math.max(0, todo.length - done - skipped));
  if (done > 0 && ok === 0) process.exitCode = 0;   // never fail the job: the lists step already did its work
}

module.exports = { parseXbrl, toCrores, expectedQe, istMs, writeIndex, isResultMeeting };
if (require.main === module) main().catch((e) => { console.error(e); });
