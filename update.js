// Bureauscherm: haalt weer, nieuws en agenda op en schrijft data.json.
// Draait elk kwartier op GitHub (zie .github/workflows/update.yml). Node 20, geen extra pakketten.
"use strict";
const crypto = require("crypto");
const fs = require("fs");

const OUT = process.argv[2] || "data.json";
const PLACE = process.env.PLACE || "Brussel";
const LAT = process.env.LAT || "50.85";
const LON = process.env.LON || "4.35";
const FEED = process.env.FEED || "https://www.vrt.be/vrtnws/nl.rss.articles.xml";
// Links mogen gescheiden zijn door spaties, nieuwe regels, komma's, of zelfs aan elkaar geplakt.
const ICS = (process.env.ICS_URLS || "").match(/(?:webcals?|https?):\/\/.+?(?=(?:webcals?|https?):\/\/|[\s,;]|$)/gi) || [];
const KEY = process.env.CAL_KEY || "";
const DAY = 864e5;

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Bureauscherm" } });
  if (!r.ok) throw new Error(url + " gaf " + r.status);
  return r.text();
}
const pad = n => (n < 10 ? "0" : "") + n;

/* ---------- weer ---------- */
async function weather() {
  const u = "https://api.open-meteo.com/v1/forecast?latitude=" + LAT + "&longitude=" + LON +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
    "&hourly=precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min" +
    "&timezone=Europe%2FBrussels&forecast_days=4&wind_speed_unit=kmh";
  const j = JSON.parse(await get(u));
  const now = new Date();
  const key = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + "T" + pad(now.getHours()) + ":00";
  let start = j.hourly.time.indexOf(key);
  if (start < 0) start = 0;
  const hourly = [];
  for (let i = Math.max(0, start - 1); i < j.hourly.time.length && hourly.length < 30; i++)
    hourly.push({ t: j.hourly.time[i], p: j.hourly.precipitation_probability[i] || 0 });
  return {
    place: PLACE,
    now: {
      t: j.current.temperature_2m, feel: j.current.apparent_temperature, code: j.current.weather_code,
      wind: j.current.wind_speed_10m, day: j.current.is_day
    },
    days: j.daily.time.map((d, i) => ({
      d, code: j.daily.weather_code[i], max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i]
    })),
    hourly
  };
}

/* ---------- nieuws (RSS of Atom) ---------- */
function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function text(html) { return decode(decode(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function tag(block, name) {
  const m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(block);
  return m ? m[1] : "";
}
function attr(block, name, a, extra) {
  const re = new RegExp("<" + name + "\\b([^>]*)/?>", "gi");
  let m;
  while ((m = re.exec(block))) {
    if (extra && !extra.test(m[1])) continue;
    const v = new RegExp(a + '="([^"]*)"', "i").exec(m[1]);
    if (v) return decode(v[1]);
  }
  return "";
}
// FEEDS: "Naam|url" per regel. Standaard VRT NWS en Sporza.
const FEEDS = (process.env.FEEDS || ("VRT NWS|" + FEED + "\nSporza|https://sporza.be/nl.rss.xml"))
  .split(/\n/).map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf("|"); return i > 0 ? { src: l.slice(0, i).trim(), url: l.slice(i + 1).trim() } : { src: "Nieuws", url: l }; });
async function news() {
  let all = [];
  for (const f of FEEDS) {
    try { all = all.concat((await feed(f.url)).map(x => Object.assign(x, { src: f.src }))); }
    catch (e) { console.error("Feed niet bereikbaar:", f.src, e.message); }
  }
  if (!all.length) throw new Error("geen enkele feed bereikbaar");
  return all.sort((a, b) => b.at - a.at);
}
async function feed(url) {
  const xml = await get(url);
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.slice(0, 20).map(b => {
    const link = text(tag(b, "link")) || attr(b, "link", "href", /rel="alternate"|^(?![\s\S]*rel=)/i) || attr(b, "link", "href");
    const img = attr(b, "enclosure", "url") || attr(b, "media:content", "url") || attr(b, "media:thumbnail", "url") ||
      attr(b, "link", "href", /rel="enclosure"/i);
    const when = Date.parse(text(tag(b, "pubDate")) || text(tag(b, "published")) || text(tag(b, "updated"))) || Date.now();
    return {
      title: text(tag(b, "title")), link,
      desc: text(tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 260),
      img, at: when
    };
  }).filter(x => x.title);
}

/* ---------- agenda (iCloud .ics) ---------- */
function unesc(s) { return s.replace(/\\n/gi, " · ").replace(/\\([,;\\])/g, "$1"); }
function icsDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v || "");
  if (!m) return null;
  if (!m[4]) return { d: new Date(+m[1], m[2] - 1, +m[3]), allDay: true };
  if (m[7]) return { d: new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])), allDay: false };
  return { d: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
}
function parseICS(src) {
  const lines = src.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const evs = []; let cur = null;
  for (const L of lines) {
    if (L === "BEGIN:VEVENT") { cur = { ex: [] }; continue; }
    if (L === "END:VEVENT") { if (cur && cur.start) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = L.indexOf(":"); if (ci < 0) continue;
    const name = L.slice(0, ci).split(";")[0], val = L.slice(ci + 1);
    if (name === "DTSTART") { const a = icsDate(val); if (a) { cur.start = a.d; cur.allDay = a.allDay; } }
    else if (name === "DTEND") { const b = icsDate(val); if (b) cur.end = b.d; }
    else if (name === "DURATION") cur.dur = val;
    else if (name === "SUMMARY") cur.title = unesc(val);
    else if (name === "LOCATION") cur.loc = unesc(val);
    else if (name === "UID") cur.uid = val;
    else if (name === "RRULE") cur.rrule = val;
    else if (name === "STATUS") cur.status = val;
    else if (name === "EXDATE") val.split(",").forEach(p => { const x = icsDate(p); if (x) cur.ex.push(x.d.getTime()); });
    else if (name === "RECURRENCE-ID") { const r = icsDate(val); if (r) cur.rid = r.d.getTime(); }
  }
  for (const ev of evs) {
    if (!ev.end && ev.dur) {
      const dm = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(ev.dur) || [];
      ev.end = new Date(ev.start.getTime() + ((+dm[1] || 0) * 7 + (+dm[2] || 0)) * DAY + (+dm[3] || 0) * 36e5 + (+dm[4] || 0) * 6e4);
    }
    if (!ev.end) ev.end = new Date(ev.start.getTime() + (ev.allDay ? DAY : 0));
  }
  return evs;
}
function expand(ev, from, to, overrides) {
  const out = [], dur = ev.end - ev.start;
  const push = s => {
    const t = s.getTime();
    if (ev.ex.indexOf(t) >= 0 || overrides[ev.uid + "|" + t]) return;
    if (t < to.getTime() && t + dur > from.getTime()) out.push({ s: t, e: t + dur, allDay: !!ev.allDay, title: ev.title || "", loc: ev.loc || "" });
  };
  if (!ev.rrule) { push(ev.start); return out; }
  const R = {}; ev.rrule.split(";").forEach(p => { const kv = p.split("="); R[kv[0]] = kv[1]; });
  const iv = +(R.INTERVAL || 1), count = R.COUNT ? +R.COUNT : 1e9, until = R.UNTIL ? icsDate(R.UNTIL).d : null, s = ev.start;
  const map = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
  let byday = null, n = 0;
  if (R.BYDAY && R.FREQ === "WEEKLY") byday = R.BYDAY.split(",").map(c => map[c.replace(/[^A-Z]/g, "")]).filter(x => x !== undefined).sort();
  const mk = (y, mo, d) => new Date(y, mo, d, s.getHours(), s.getMinutes(), s.getSeconds());
  for (let k = 0; k < 4000; k++) {
    const c = [];
    if (R.FREQ === "DAILY") c.push(mk(s.getFullYear(), s.getMonth(), s.getDate() + k * iv));
    else if (R.FREQ === "WEEKLY") {
      if (byday) { const mon = s.getDate() - ((s.getDay() + 6) % 7) + k * 7 * iv; byday.forEach(b => { const d = mk(s.getFullYear(), s.getMonth(), mon + b); if (d >= s) c.push(d); }); }
      else c.push(mk(s.getFullYear(), s.getMonth(), s.getDate() + k * 7 * iv));
    } else if (R.FREQ === "MONTHLY" || R.FREQ === "YEARLY") {
      const y = R.FREQ === "YEARLY" ? s.getFullYear() + k * iv : s.getFullYear();
      const mo = R.FREQ === "YEARLY" ? (R.BYMONTH ? +R.BYMONTH - 1 : s.getMonth()) : s.getMonth() + k * iv;
      if (R.BYDAY) {
        // bv. "2TU" (2de dinsdag), "-1FR" (laatste vrijdag) of BYDAY=TU;BYSETPOS=2 zoals Outlook het schrijft
        const m = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(R.BYDAY);
        const nth = m && (m[1] ? +m[1] : R.BYSETPOS ? +R.BYSETPOS : 0);
        if (!m || !nth) break; // patroon dat we niet kennen: liever niets tonen dan iets fout
        const wd = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }[m[2]];
        let d;
        if (nth > 0) { const first = new Date(y, mo, 1); d = mk(first.getFullYear(), first.getMonth(), 1 + ((wd - first.getDay() + 7) % 7) + (nth - 1) * 7); }
        else { const last = new Date(y, mo + 1, 0); d = mk(last.getFullYear(), last.getMonth(), last.getDate() - ((last.getDay() - wd + 7) % 7) + (nth + 1) * 7); }
        if (d.getMonth() === new Date(y, mo, 1).getMonth() && d >= s) c.push(d);
      } else {
        const day = R.BYMONTHDAY ? +R.BYMONTHDAY : s.getDate();
        const d = mk(y, mo, day);
        if (d.getDate() === day && d >= s) c.push(d);
      }
    }
    else { push(s); break; }
    for (const d of c) {
      if (until && d > until) return out;
      if (++n > count) return out;
      if (d >= to) return out;
      push(d);
    }
  }
  return out;
}
async function calendar() {
  if (!ICS.length || !KEY) return null;
  const all = [];
  for (const u of ICS) {
    try { all.push(...parseICS(await get(u.replace(/^webcals?:\/\//i, "https://")))); }
    catch (e) { console.error("Agenda niet bereikbaar:", e.message); }
  }
  const now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), now.getDate()), to = new Date(from.getTime() + 15 * DAY);
  const ov = {}; all.forEach(e => { if (e.rid) ov[e.uid + "|" + e.rid] = 1; });
  let occ = [];
  all.forEach(e => { if (e.status !== "CANCELLED") occ = occ.concat(expand(e, from, to, ov)); });
  occ.sort((a, b) => a.s - b.s);
  return encrypt(JSON.stringify(occ.slice(0, 150)), KEY);
}

/* ---------- versleuteling: SHA-256 in tellermodus, zelfde code staat in index.html ---------- */
function encrypt(plain, pass) {
  const key = crypto.createHash("sha256").update(pass, "utf8").digest();
  const nonce = crypto.randomBytes(16), pt = Buffer.from(plain, "utf8"), ct = Buffer.alloc(pt.length);
  for (let i = 0; i < pt.length; i += 32) {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(i / 32);
    const ks = crypto.createHash("sha256").update(Buffer.concat([key, nonce, ctr])).digest();
    for (let j = 0; j < 32 && i + j < pt.length; j++) ct[i + j] = pt[i + j] ^ ks[j];
  }
  const check = crypto.createHash("sha256").update(Buffer.concat([key, pt])).digest("hex").slice(0, 16);
  return { n: nonce.toString("base64"), c: ct.toString("base64"), h: check };
}

(async () => {
  const out = { updated: Date.now() };
  const jobs = [["weather", weather], ["news", news], ["cal", calendar]];
  for (const [k, fn] of jobs) {
    try { out[k] = await fn(); }
    catch (e) { console.error(k + " mislukt:", e.message); out[k] = null; }
  }
  out.calConfigured = !!(ICS.length && KEY);
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("Geschreven:", OUT, "weer:", !!out.weather, "nieuws:", out.news ? out.news.length : 0, "agenda:", !!out.cal);
})();
