// Fetches the NSE / BSE corporate lists and writes data/corp-raw.json (read by the corporate-actions Worker through RELAY_URL).
// Also pushes missing quarterly XBRL results (res2:<SYMBOL>) to the Worker's /ingest endpoint so hover cards load from KV.
const fs = require('fs');
const OUT = 'data/corp-raw.json';
const NSE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ist = (o = 0) => new Date(Date.now() + 5.5 * 3600e3 + o * 864e5).toISOString().slice(0, 10);
const dmy = (i) => i.split('-').reverse().join('-');
const ymd = (i) => i.replace(/-/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = ist(-30), TO = ist(90), AF = ist(-2), AT = ist(0);

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const WORKER_KEY = process.env.WORKER_KEY || '';
const MAX_XBRL_PER_RUN = 15; // keeps each 20-min run fast and well within NSE rate limits

let cookie = '', cookieAt = 0;
async function warm() {
  if (cookie && Date.now() - cookieAt < 240000) return;
  const r = await fetch(NSE + '/', { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  cookie = sc.map((c) => c.split(';')[0]).join('; '); cookieAt = Date.now();
  console.log('  nse warm-up: HTTP ' + r.status + ', cookies: ' + sc.length);
}
async function nse(path, qs, tries = 2) {
  for (let a = 0; a < tries; a++) {
    await warm();
    const r = await fetch(NSE + path + '?' + qs, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9', 'Referer': NSE + '/companies-listing/corporate-filings-actions', 'Cookie': cookie }, signal: AbortSignal.timeout(25000) });
    if (r.ok) { const t = (await r.text()).trim(); if (!t || t[0] === '<') throw new Error('HTML instead of JSON'); const j = JSON.parse(t); return Array.isArray(j) ? j : (j.data || j.results || []); }
    cookie = ''; if (a === tries - 1) throw new Error('HTTP ' + r.status);
    await sleep(1500);
  }
}
async function nseXml(url) {
  await warm();
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml,*/*', 'Accept-Language': 'en-IN,en;q=0.9', 'Referer': NSE + '/', 'Cookie': cookie }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('XBRL HTTP ' + r.status);
  const t = await r.text();
  if (!/contextRef=/i.test(t)) throw new Error('Not valid XBRL');
  return t;
}
async function bse(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9', 'Referer': 'https://www.bseindia.com/', 'Origin': 'https://www.bseindia.com' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = (await r.text()).trim(); if (!t || t[0] === '<') throw new Error('HTML instead of JSON');
  const j = JSON.parse(t); return Array.isArray(j) ? j : (Object.values(j || {}).find(Array.isArray) || []);
}
async function postWorker(payload) {
  const r = await fetch(WORKER_URL + '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Key': WORKER_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  return await r.json();
}

const isFiling = (r) => /financial\s*results?|integrated\s*filing.*financial/i.test(String(r.desc || '')) || /outcome\s+of\s+board\s+meeting/i.test(String(r.desc || '') + ' ' + String(r.attchmntText || ''));
const qsN = (a, b) => `index=equities&from_date=${dmy(a)}&to_date=${dmy(b)}`;

async function syncQuarterlyXbrl(data) {
  if (!WORKER_URL || !WORKER_KEY) {
    console.log('\nSkipping XBRL sync (WORKER_URL / WORKER_KEY not set).');
    return;
  }
  const today = ist(0);
  const syms = new Set();

  // 1) Stocks with result filings in nseFil
  (data.nseFil || []).forEach((r) => {
    const s = String(r.symbol || r.sm_symbol || '').toUpperCase().trim();
    if (s) syms.add(s);
  });

  // 2) Stocks whose board meeting date is today or in the past 30 days
  (data.nseBm || []).forEach((r) => {
    const s = String(r.bm_symbol || r.symbol || '').toUpperCase().trim();
    const purpose = [r.bm_purpose || r.purpose || '', r.bm_desc || r.subject || ''].join(' ');
    const rawDt = String(r.bm_date || r.meetingDate || '').trim();
    if (!s || !/result|financial|quarterly|annual|audited/i.test(purpose)) return;
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(rawDt);
    const mons = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    const iso = m && mons[m[2].toLowerCase()] ? `${m[3]}-${mons[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : rawDt.slice(0, 10);
    if (iso && iso <= today && iso >= FROM) syms.add(s);
  });

  const candidates = [...syms];
  console.log(`\nChecking XBRL results for ${candidates.length} recent result stocks (max ${MAX_XBRL_PER_RUN} uploads this run)...`);
  let uploaded = 0, skipped = 0;

  for (const sym of candidates) {
    if (uploaded >= MAX_XBRL_PER_RUN) break;
    try {
      const enc = encodeURIComponent(sym);
      let intRows = await nse('/api/integrated-filing-results', `index=equities&symbol=${enc}&period_ended=all&type=Integrated%20Filing-%20Financials`);
      if (!intRows.length) {
        await sleep(400);
        intRows = await nse('/api/integrated-filing-results', `index=equities&symbol=${enc}`);
      }
      if (!intRows.length) continue;

      const plan = await postWorker({ type: 'result-plan', sym, intRows });
      if (!plan.ok || plan.alreadyStored || !Array.isArray(plan.urls) || !plan.urls.length) {
        skipped++;
        await sleep(300);
        continue;
      }

      const xmls = {};
      for (const u of plan.urls) {
        try { xmls[u] = await nseXml(u); } catch (e) { console.log(`  ${sym} xml err: ${e.message}`); }
        await sleep(350);
      }
      if (!Object.keys(xmls).length) continue;

      const saved = await postWorker({ type: 'result', sym, intRows, xmls });
      if (saved.ok) {
        uploaded++;
        console.log(`  SAVED ${sym}: ${saved.quarters} quarters (${saved.basis})`);
      } else {
        console.log(`  FAIL ${sym}: ${saved.error}`);
      }
      await sleep(600);
    } catch (e) {
      console.log(`  ERR ${sym}: ${e.message}`);
      await sleep(800);
    }
  }
  console.log(`XBRL sync done: ${uploaded} newly saved to KV, ${skipped} already in KV.`);
}

(async () => {
  const jobs = [
    ['bseRes', () => bse(`https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w?scripcode=&Fdate=${ymd(FROM)}&TDate=${ymd(TO)}&industry=`)],
    ['bseAct', () => bse(`https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Fdate=${ymd(FROM)}&TDate=${ymd(TO)}&Purposecode=&ddlcategorys=E&ddlindustrys=&scripcode=&segment=0&strSearch=S`)],
    ['nseAct', () => nse('/api/corporates-corporateActions', qsN(FROM, TO))],
    ['nseBm', () => nse('/api/corporate-board-meetings', qsN(FROM, TO))],
    ['nseFil', async () => (await nse('/api/corporate-announcements', qsN(AF, AT))).filter(isFiling)],
  ];
  const data = {}, status = {};
  for (const [k, fn] of jobs) {
    try { const rows = await fn(); if (rows.length) { data[k] = rows; status[k] = 'ok ' + rows.length; } else status[k] = 'empty'; }
    catch (e) { status[k] = 'FAILED ' + e.message; }
    console.log(k.padEnd(7) + status[k]);
    await sleep(900);
  }
  if (!Object.keys(data).length) { console.log('\nNOTHING could be fetched: NSE / BSE are refusing GitHub as well.'); process.exit(1); }

  let old = null; try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
  const same = old && Object.keys(data).length === Object.keys(old).filter((k) => Array.isArray(old[k])).length && Object.keys(data).every((k) => JSON.stringify(old[k]) === JSON.stringify(data[k]));
  // the Worker ignores a file older than 48 h, so even unchanged data is re-stamped every 12 h
  if (!same || !old.fetchedAt || Date.now() - Date.parse(old.fetchedAt) >= 12 * 3600e3) {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, status, ...data }));
    console.log('\nWrote ' + OUT + ' (' + Object.keys(data).join(', ') + ')');
  } else {
    console.log('\nNo change - file left as it is.');
  }

  // Sync quarterly XBRL results into CORP_KV
  await syncQuarterlyXbrl(data);
})().catch((e) => { console.error(e); process.exit(1); });
