// Fetches the NSE / BSE corporate lists and writes data/corp-raw.json (read by the corporate-actions Worker through RELAY_URL).
// Runs on GitHub Actions (Node 20, global fetch). Prints one line per source so you can see at once whether NSE / BSE let GitHub in.
const fs = require('fs');
const OUT = 'data/corp-raw.json';
const NSE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ist = (o = 0) => new Date(Date.now() + 5.5 * 3600e3 + o * 864e5).toISOString().slice(0, 10);
const dmy = (i) => i.split('-').reverse().join('-');
const ymd = (i) => i.replace(/-/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = ist(-30), TO = ist(90), AF = ist(-2), AT = ist(0);

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
async function bse(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-IN,en;q=0.9', 'Referer': 'https://www.bseindia.com/', 'Origin': 'https://www.bseindia.com' }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = (await r.text()).trim(); if (!t || t[0] === '<') throw new Error('HTML instead of JSON');
  const j = JSON.parse(t); return Array.isArray(j) ? j : (Object.values(j || {}).find(Array.isArray) || []);
}
const isFiling = (r) => /financial\s*results?|integrated\s*filing.*financial/i.test(String(r.desc || '')) || /outcome\s+of\s+board\s+meeting/i.test(String(r.desc || '') + ' ' + String(r.attchmntText || ''));
const qsN = (a, b) => `index=equities&from_date=${dmy(a)}&to_date=${dmy(b)}`;

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
  if (same && old.fetchedAt && Date.now() - Date.parse(old.fetchedAt) < 12 * 3600e3) { console.log('\nNo change - file left as it is.'); return; }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, status, ...data }));
  console.log('\nWrote ' + OUT + ' (' + Object.keys(data).join(', ') + ')');
})().catch((e) => { console.error(e); process.exit(1); });
