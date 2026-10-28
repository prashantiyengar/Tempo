// Render week / month calendars to a canvas and export as PNG, JPEG or PDF (no external libraries).
import * as T from './tz.js';

const C = {
  bg: '#ffffff', ink: '#1d2230', muted: '#6b7280', line: '#e5e7eb', lineStrong: '#cfd4dc',
  shade: '#f6f7f9', today: '#4f6bed', title: '#111827',
};
const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function wrap(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '', lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      if (lines === maxLines - 1) { ellipsis(ctx, line + ' ' + words.slice(i).join(' '), x, y + lines * lineH, maxW); return lines + 1; }
      ctx.fillText(line, x, y + lines * lineH); lines++; line = words[i];
    } else line = test;
  }
  if (line && lines < maxLines) { ellipsis(ctx, line, x, y + lines * lineH, maxW); lines++; }
  return lines;
}
function ellipsis(ctx, s, x, y, maxW) {
  if (ctx.measureText(s).width <= maxW) return ctx.fillText(s, x, y);
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  ctx.fillText(s + '…', x, y);
}
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#1d2230' : '#ffffff';
}
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * (1 - a));
  return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

// Column layout for overlapping timed items
export function layoutColumns(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [], clusterEnd = -Infinity;
  const flush = () => {
    const cols = [];
    for (const it of cluster) {
      let c = cols.findIndex((end) => end <= it.s);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = it.e; it.col = c;
    }
    for (const it of cluster) { it.cols = cols.length; out.push(it); }
    cluster = [];
  };
  for (const it of sorted) {
    if (it.s >= clusterEnd && cluster.length) flush();
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return out;
}

// `hours` (optional) limits the page to certain hours: { rules: [{ days, start, end }], label } — e.g. work hours,
// "After hours", or 09:00–17:00. Without it, the page shows the whole working day plus anything scheduled around it.
export function renderWeek({ days, items, settings, title, scale = 2, summary = null, hours = null }) {
  const tz = settings.tz;
  const W = 1600, gutter = 64, headH = 100, colW = (W - gutter - 24) / days.length;
  const allDay = items.filter((i) => i.allDay);
  const timed = items.filter((i) => !i.allDay);
  // vertical range
  let h0 = Math.min(8, Math.floor(T.parseHHMM(settings.bounds.start) / 60) - 1), h1 = Math.max(18, Math.ceil(T.parseHHMM(settings.bounds.end) / 60) + 1);
  for (const it of timed) {
    const k = T.dayKey(it.start, tz);
    if (!days.includes(k)) continue;
    h0 = Math.min(h0, Math.floor(T.minutesOfDay(it.start, tz) / 60));
    const endK = T.dayKey(it.end - 1, tz);
    h1 = Math.max(h1, endK !== k ? 24 : Math.ceil(T.minutesOfDay(it.end, tz) / 60));
  }
  h0 = Math.max(0, h0); h1 = Math.min(24, h1);
  // per-day open intervals (minutes) — shaded outside
  const toM = (hhmm) => T.parseHHMM(hhmm);
  const rulesFor = (k) => (hours ? hours.rules : [settings.bounds]).filter((r) => (r.days?.length ? r.days : [0, 1, 2, 3, 4, 5, 6]).includes(T.weekday(k)))
    .map((r) => { const a = toM(r.start); let b = toM(r.end); if (b <= a) b = 1440; return [a, b]; });
  if (hours) {
    const all = days.flatMap(rulesFor);
    const lo = all.length ? Math.min(...all.map((x) => x[0])) : 9 * 60, hi = all.length ? Math.max(...all.map((x) => x[1])) : 17 * 60;
    h0 = Math.floor(lo / 60); h1 = Math.ceil(hi / 60);
  }
  const hourH = Math.max(34, Math.min(60, 1500 / (h1 - h0)));
  // all-day rows
  const rows = [];
  const adPlaced = allDay.map((it) => {
    const a = Math.max(0, days.indexOf(it.startKey) < 0 ? (it.startKey < days[0] ? 0 : 99) : days.indexOf(it.startKey));
    const lastKey = T.addDays(it.endKey, -1);
    const b = days.indexOf(lastKey) < 0 ? (lastKey > days[days.length - 1] ? days.length - 1 : -1) : days.indexOf(lastKey);
    return { it, a, b };
  }).filter((p) => p.a <= p.b && p.a < 99);
  for (const p of adPlaced) {
    let r = rows.findIndex((row) => row.every((q) => q.b < p.a || q.a > p.b));
    if (r < 0) { r = rows.length; rows.push([]); }
    rows[r].push(p); p.row = r;
  }
  const adH = rows.length ? rows.length * 26 + 10 : 0;
  const top = headH + adH;
  const gridBottom = top + (h1 - h0) * hourH;
  const H = gridBottom + 24 + (summary ? SUMMARY_H : 0);

  const cv = document.createElement('canvas');
  cv.width = W * scale; cv.height = H * scale;
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.title; ctx.font = `600 24px ${FONT}`;
  ctx.fillText(title, gutter, 18);
  ctx.fillStyle = C.muted; ctx.font = `13px ${FONT}`;
  ctx.fillText(`Time zone: ${tz}`, W - 24 - ctx.measureText(`Time zone: ${tz}`).width, 26);
  const todayK = T.dayKey(Date.now(), tz);
  // day headers + shading
  days.forEach((k, i) => {
    const x = gutter + i * colW;
    const wd = T.weekday(k);
    const isToday = k === todayK;
    ctx.fillStyle = isToday ? C.today : C.muted; ctx.font = `600 12px ${FONT}`;
    ctx.fillText(T.format(T.dayStart(k, tz), tz, { weekday: 'short' }).toUpperCase(), x + 10, 62);
    ctx.fillStyle = isToday ? C.today : C.ink; ctx.font = `600 20px ${FONT}`;
    ctx.fillText(String(T.parseKey(k).d), x + 10 + ctx.measureText('WWW').width + 4, 57);
    void wd;
    const y0 = top, y1 = top + (h1 - h0) * hourH;
    ctx.fillStyle = C.shade;
    // shade everything outside the open intervals of this day
    const open = rulesFor(k).sort((p, q) => p[0] - q[0]);
    let cur = h0 * 60;
    for (const [a, b2] of [...open, [h1 * 60, h1 * 60]]) {
      const s0 = Math.max(cur, h0 * 60), s1 = Math.min(a, h1 * 60);
      if (s1 > s0) ctx.fillRect(x, y0 + (s0 / 60 - h0) * hourH, colW, ((s1 - s0) / 60) * hourH);
      cur = Math.max(cur, b2);
    }
    if (!y1) ctx.fillRect(x, y0, colW, 0);
  });
  // hour lines
  ctx.font = `11px ${FONT}`;
  for (let h = h0; h <= h1; h++) {
    const y = top + (h - h0) * hourH;
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gutter, y + 0.5); ctx.lineTo(W - 24, y + 0.5); ctx.stroke();
    if (h < h1) {
      ctx.fillStyle = C.muted;
      const lab = settings.h12 ? `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}` : `${T.pad(h)}:00`;
      ctx.fillText(lab, gutter - 8 - ctx.measureText(lab).width, y - 6);
    }
  }
  ctx.strokeStyle = C.lineStrong;
  for (let i = 0; i <= days.length; i++) {
    const x = gutter + i * colW + 0.5;
    ctx.beginPath(); ctx.moveTo(x, headH - 10); ctx.lineTo(x, top + (h1 - h0) * hourH); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(gutter, headH - 10 + 0.5); ctx.lineTo(W - 24, headH - 10 + 0.5); ctx.stroke();
  // all-day bars
  for (const p of adPlaced) {
    const x = gutter + p.a * colW + 3, w = (p.b - p.a + 1) * colW - 6, y = headH + p.row * 26;
    ctx.fillStyle = p.it.color; rr(ctx, x, y, w, 22, 5); ctx.fill();
    ctx.fillStyle = textOn(p.it.color); ctx.font = `600 12px ${FONT}`;
    ellipsis(ctx, p.it.title, x + 7, y + 5, w - 12);
  }
  // timed blocks (clipped to the hours shown)
  ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, (h1 - h0) * hourH); ctx.clip();
  days.forEach((k, i) => {
    const ds = T.dayStart(k, tz), de = T.dayStart(T.addDays(k, 1), tz);
    const segs = timed.filter((it) => it.end > ds && it.start < de).map((it) => ({
      it, s: Math.max(it.start, ds), e: Math.min(it.end, de),
    })).map((g) => ({ ...g, s: (g.s - ds) / T.MIN, e: Math.max((g.e - ds) / T.MIN, (g.s - ds) / T.MIN + 15) }));
    for (const g of layoutColumns(segs)) {
      const x = gutter + i * colW + 2 + (g.col * (colW - 4)) / g.cols;
      const w = (colW - 4) / g.cols - 2;
      const y = top + (g.s / 60 - h0) * hourH + 1;
      const h = Math.max(14, ((g.e - g.s) / 60) * hourH - 2);
      if (y + h < top) continue;
      const col = g.it.color;
      const done = g.it.status === 'done';
      ctx.fillStyle = g.it.kind === 'chunk' ? tint(col, done ? 0.18 : 0.28) : col;
      rr(ctx, x, y, w, h, 5); ctx.fill();
      if (g.it.kind === 'chunk') { ctx.fillStyle = col; ctx.fillRect(x, y + 2, 3.5, h - 4); }
      ctx.save(); rr(ctx, x, y, w, h, 5); ctx.clip();
      ctx.fillStyle = g.it.kind === 'chunk' ? '#1d2230' : textOn(col);
      ctx.font = `600 12px ${FONT}`;
      const lines = Math.max(1, Math.floor((h - 18) / 15));
      const used = wrap(ctx, (done ? '✓ ' : '') + g.it.title, x + 8, y + 4, w - 12, 15, h < 34 ? 1 : lines);
      if (h >= 34 && used * 15 + 18 < h) {
        ctx.font = `11px ${FONT}`; ctx.globalAlpha = 0.8;
        ctx.fillText(`${T.fmtTime(g.it.start, tz, settings.h12)} – ${T.fmtTime(g.it.end, tz, settings.h12)}`, x + 8, y + 5 + used * 15);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
  });
  ctx.restore();
  if (summary) drawSummary(ctx, summary, 24, gridBottom + 18, W - 48);
  return cv;
}

// ---------- Time-used infographic at the bottom of each printed page ----------
const SUMMARY_H = 190;
const fmtH = T.fmtHours;
function drawSummary(ctx, s, x, y, w) {
  const h = SUMMARY_H - 24;
  ctx.fillStyle = '#f7f8fa'; rr(ctx, x, y, w, h, 12); ctx.fill();
  ctx.strokeStyle = C.line; rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 12); ctx.stroke();
  const px = x + 20, py = y + 16;
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.ink; ctx.font = `600 16px ${FONT}`;
  ctx.fillText('Where the time goes', px, py);
  ctx.fillStyle = C.muted; ctx.font = `12px ${FONT}`;
  ctx.fillText(`${fmtH(s.available)} ${s.scope}`, px + ctx.measureText('Where the time goes').width + 70, py + 3);
  // key figures
  const used = s.available - s.free - (s.gaps || 0);
  const tiles = [
    ['Occupied', fmtH(used), s.available ? `${Math.round((used / s.available) * 100)}% of ${fmtH(s.available)}` : ''],
    ['Free', fmtH(s.free), s.available ? `${Math.round((s.free / s.available) * 100)}%${s.gaps ? ` · ○ ${fmtH(s.gaps)} gaps` : ''}` : ''],
    ['Busiest day', s.busiest ? s.busiest.label : '—', s.busiest ? `${fmtH(s.busiest.m)} of ${fmtH(s.busiest.of)}` : ''],
    ['Task sessions', s.sessions.total ? `${s.sessions.done}/${s.sessions.total}` : '—', s.sessions.total ? 'done' : 'none planned'],
  ];
  const tw = 170;
  tiles.forEach(([l, v, sub], i) => {
    const tx = x + w - 20 - (tiles.length - i) * (tw + 10);
    ctx.fillStyle = C.muted; ctx.font = `600 11px ${FONT}`; ctx.fillText(l.toUpperCase(), tx, py);
    ctx.fillStyle = C.ink; ctx.font = `600 22px ${FONT}`; ellipsis(ctx, v, tx, py + 16, tw);
    ctx.fillStyle = C.muted; ctx.font = `12px ${FONT}`; ellipsis(ctx, sub, tx, py + 44, tw);
  });
  // stacked share bar
  const bx = px, by = py + 70, bw = w - 40, bh = 22;
  const total = Math.max(1, s.available);
  let cx = bx;
  ctx.save(); rr(ctx, bx, by, bw, bh, 6); ctx.clip();
  ctx.fillStyle = '#eceef2'; ctx.fillRect(bx, by, bw, bh);
  for (const g of s.groups) { const gw = (g.m / total) * bw; ctx.fillStyle = g.color; ctx.fillRect(cx, by, gw, bh); cx += gw; }
  if (s.gaps) { const gw = (s.gaps / total) * bw; ctx.fillStyle = '#d9dce3'; ctx.fillRect(cx, by, gw, bh); cx += gw; }
  ctx.restore();
  // legend
  let lx = bx, ly = by + bh + 12;
  ctx.font = `12px ${FONT}`;
  const entries = [...s.groups.map((g) => ({ ...g })), ...(s.gaps ? [{ label: 'Short gaps (≤ 10 min, not free)', gap: true, m: s.gaps }] : []), { label: 'Free', color: '#eceef2', m: s.free }];
  for (const g of entries) {
    const txt = `${g.label}  ${fmtH(g.m)} · ${Math.round((g.m / total) * 100)}%`;
    const tw2 = ctx.measureText(txt).width + 30;
    if (lx + tw2 > bx + bw) { lx = bx; ly += 20; if (ly > y + h - 18) break; }
    if (g.gap) { ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(lx + 6, ly + 7, 5, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    else { ctx.fillStyle = g.color; rr(ctx, lx, ly + 1, 12, 12, 3); ctx.fill(); }
    if (g.label === 'Free') { ctx.strokeStyle = '#c9ccd3'; rr(ctx, lx + 0.5, ly + 1.5, 11, 11, 3); ctx.stroke(); }
    ctx.fillStyle = C.ink; ctx.fillText(txt, lx + 18, ly);
    lx += tw2;
  }
}

export function renderMonth({ monthKey, gridStart, items, settings, title, scale = 2, summary = null }) {
  const tz = settings.tz;
  const W = 1600, gridH = 1130, H = gridH + (summary ? SUMMARY_H : 0), left = 24, topH = 100, cols = 7, rowsN = 6;
  const cw = (W - left * 2) / cols, ch = (gridH - topH - 24) / rowsN;
  const cv = document.createElement('canvas');
  cv.width = W * scale; cv.height = H * scale;
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  ctx.fillStyle = C.title; ctx.font = `600 26px ${FONT}`;
  ctx.fillText(title, left, 20);
  ctx.fillStyle = C.muted; ctx.font = `13px ${FONT}`;
  ctx.fillText(`Time zone: ${tz}`, W - left - ctx.measureText(`Time zone: ${tz}`).width, 30);
  const month = T.parseKey(monthKey).m;
  const todayK = T.dayKey(Date.now(), tz);
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = C.muted; ctx.font = `600 12px ${FONT}`;
    ctx.fillText(T.format(T.dayStart(T.addDays(gridStart, i), tz), tz, { weekday: 'short' }).toUpperCase(), left + i * cw + 10, 74);
  }
  for (let r = 0; r < rowsN; r++) for (let c = 0; c < cols; c++) {
    const k = T.addDays(gridStart, r * 7 + c);
    const x = left + c * cw, y = topH + r * ch;
    const out = T.parseKey(k).m !== month;
    ctx.fillStyle = out ? C.shade : C.bg; ctx.fillRect(x, y, cw, ch);
    ctx.strokeStyle = C.line; ctx.strokeRect(x + 0.5, y + 0.5, cw, ch);
    ctx.font = `600 14px ${FONT}`;
    if (k === todayK) {
      ctx.fillStyle = C.today; ctx.beginPath(); ctx.arc(x + 20, y + 17, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
    } else ctx.fillStyle = out ? C.muted : C.ink;
    const dn = String(T.parseKey(k).d);
    ctx.fillText(dn, x + 20 - ctx.measureText(dn).width / 2, y + 9);
    const ds = T.dayStart(k, tz), de = T.dayStart(T.addDays(k, 1), tz);
    const list = items.filter((it) => (it.allDay ? it.startKey <= k && it.endKey > k : it.end > ds && it.start < de))
      .sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
    const maxN = Math.floor((ch - 36) / 20);
    list.slice(0, list.length > maxN ? maxN - 1 : maxN).forEach((it, j) => {
      const yy = y + 34 + j * 20;
      ctx.font = `12px ${FONT}`;
      if (it.allDay) {
        ctx.fillStyle = it.color; rr(ctx, x + 4, yy, cw - 8, 18, 4); ctx.fill();
        ctx.fillStyle = textOn(it.color); ctx.font = `600 12px ${FONT}`;
        ellipsis(ctx, it.title, x + 10, yy + 3, cw - 18);
      } else {
        ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(x + 11, yy + 9, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.muted;
        const tm = T.fmtTime(it.start, tz, settings.h12);
        ctx.fillText(tm, x + 20, yy + 3);
        ctx.fillStyle = C.ink;
        ellipsis(ctx, (it.status === 'done' ? '✓ ' : '') + it.title, x + 24 + ctx.measureText(tm).width, yy + 3, cw - 30 - ctx.measureText(tm).width);
      }
    });
    if (list.length > maxN) {
      ctx.fillStyle = C.muted; ctx.font = `600 12px ${FONT}`;
      ctx.fillText(`+${list.length - maxN + 1} more`, x + 10, y + 34 + (maxN - 1) * 20 + 3);
    }
  }
  if (summary) drawSummary(ctx, summary, left, gridH - 6, W - left * 2);
  return cv;
}

// --- Minimal multi-page PDF with one embedded JPEG per page ---------------------------------
export async function canvasToPdf(canvas) { return canvasesToPdf([canvas]); }

export async function canvasesToPdf(canvases, onPage) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const N = canvases.length;
  // object numbers: 1 catalog, 2 pages, then per page i: page 3+3i, image 4+3i, content 5+3i
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${canvases.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${N} >>`);
  for (let i = 0; i < N; i++) {
    const canvas = canvases[i];
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const iw = canvas.width, ih = canvas.height;
    const land = iw >= ih;
    const PW = land ? 842 : 595, PH = land ? 595 : 842, M = 24;
    const sc = Math.min((PW - 2 * M) / iw, (PH - 2 * M) / ih);
    const dw = iw * sc, dh = ih * sc, dx = (PW - dw) / 2, dy = (PH - dh) / 2;
    const pn = 3 + 3 * i, im = pn + 1, cn = pn + 2;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im${i} ${im} 0 R >> >> /Contents ${cn} 0 R >>`);
    offsets[im] = len;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push('\nendstream\nendobj\n');
    const content = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${dx.toFixed(2)} ${dy.toFixed(2)} cm /Im${i} Do Q`;
    obj(cn, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    onPage?.(i + 1, N);
  }
  const total = 3 + 3 * N;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// --- Multi-page TIFF (RGB, LZW + horizontal predictor — opens in Windows Photos, macOS Preview, GIMP, Photoshop…) ---
// LZW encoder following libtiff's conventions (MSB-first codes, 9→12 bits, early change handled on the decoder side).
function lzwEncode(src) {
  let out = new Uint8Array(Math.max(1024, src.length >> 1));
  let o = 0, acc = 0, nacc = 0;
  const put = (code, bits) => {
    acc = (acc << bits) | code; nacc += bits;
    while (nacc >= 8) {
      if (o >= out.length - 4) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; }
      out[o++] = (acc >>> (nacc - 8)) & 255; nacc -= 8;
    }
    acc &= (1 << nacc) - 1;
  };
  const CLEAR = 256, EOI = 257;
  let dict = new Map(), next = 258, nbits = 9;
  put(CLEAR, 9);
  if (!src.length) { put(EOI, 9); return out.subarray(0, o); }
  let ent = src[0];
  for (let i = 1; i < src.length; i++) {
    const c = src[i];
    const key = (ent << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) { ent = hit; continue; }
    put(ent, nbits);
    dict.set(key, next++);
    if (next === 4094) { put(CLEAR, nbits); dict = new Map(); next = 258; nbits = 9; }
    else if (next > (1 << nbits) - 1) nbits++;
    ent = c;
  }
  put(ent, nbits);
  next++;
  if (next === 4094) { put(CLEAR, nbits); nbits = 9; } else if (next > (1 << nbits) - 1) nbits++;
  put(EOI, nbits);
  if (nacc) { out[o++] = (acc << (8 - nacc)) & 255; }
  return out.subarray(0, o);
}

export async function canvasesToTiff(canvases, onPage, dpi = 150) {
  const pages = [];
  for (let p = 0; p < canvases.length; p++) {
    const c = canvases[p];
    const w = c.width, h = c.height, rb = w * 3;
    const rgba = c.getContext('2d').getImageData(0, 0, w, h).data;
    const rowsPerStrip = Math.max(1, Math.floor(131072 / rb));
    const strips = [];
    for (let y0 = 0; y0 < h; y0 += rowsPerStrip) {
      const y1 = Math.min(h, y0 + rowsPerStrip);
      const raw = new Uint8Array((y1 - y0) * rb);
      for (let y = y0; y < y1; y++) {
        const base = (y - y0) * rb;
        for (let x = 0, k = y * w * 4; x < w; x++, k += 4) { raw[base + x * 3] = rgba[k]; raw[base + x * 3 + 1] = rgba[k + 1]; raw[base + x * 3 + 2] = rgba[k + 2]; }
        for (let i = rb - 1; i >= 3; i--) raw[base + i] = (raw[base + i] - raw[base + i - 3]) & 255; // horizontal predictor
      }
      strips.push(lzwEncode(raw));
    }
    const total = strips.reduce((a, s) => a + s.length, 0);
    const data = new Uint8Array(total);
    const stripOffsets = [], stripCounts = [];
    let o = 0;
    for (const s of strips) { stripOffsets.push(o); stripCounts.push(s.length); data.set(s, o); o += s.length; }
    pages.push({ w, h, data, stripOffsets, stripCounts, rowsPerStrip });
    onPage?.(p + 1, canvases.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  // Layout: header | for each page: [IFD][extra arrays][image data]
  const chunks = [];
  let pos = 8;
  const header = new Uint8Array(8);
  const hv = new DataView(header.buffer);
  header[0] = 0x49; header[1] = 0x49; hv.setUint16(2, 42, true); hv.setUint32(4, 8, true);
  chunks.push(header);
  pages.forEach((pg, idx) => {
    const NT = 14; // number of tags
    const ifdSize = 2 + NT * 12 + 4;
    const ns = pg.stripOffsets.length;
    const extraStart = pos + ifdSize;
    const bpsOff = extraStart;            // 3 × SHORT
    const xresOff = bpsOff + 6;           // RATIONAL
    const yresOff = xresOff + 8;          // RATIONAL
    const soOff = yresOff + 8;            // ns × LONG
    const scOff = soOff + ns * 4;         // ns × LONG
    const dataOff = scOff + ns * 4;
    const nextIfd = idx < pages.length - 1 ? dataOff + pg.data.length + (pg.data.length & 1) : 0;
    const buf = new Uint8Array(dataOff - pos);
    const v = new DataView(buf.buffer);
    let q = 0;
    v.setUint16(q, NT, true); q += 2;
    const tag = (id, type, count, value) => {
      v.setUint16(q, id, true); v.setUint16(q + 2, type, true); v.setUint32(q + 4, count, true);
      if (type === 3 && count === 1) v.setUint16(q + 8, value, true); else v.setUint32(q + 8, value, true);
      q += 12;
    };
    tag(254, 4, 1, 2);                         // NewSubfileType: page of multipage
    tag(256, 4, 1, pg.w);                      // ImageWidth
    tag(257, 4, 1, pg.h);                      // ImageLength
    tag(258, 3, 3, bpsOff);                    // BitsPerSample 8,8,8
    tag(259, 3, 1, 5);                         // Compression: LZW
    tag(262, 3, 1, 2);                         // Photometric: RGB
    tag(273, 4, ns, ns === 1 ? dataOff : soOff); // StripOffsets
    tag(277, 3, 1, 3);                         // SamplesPerPixel
    tag(278, 4, 1, pg.rowsPerStrip);           // RowsPerStrip
    tag(279, 4, ns, ns === 1 ? pg.stripCounts[0] : scOff); // StripByteCounts
    tag(282, 5, 1, xresOff);                   // XResolution
    tag(283, 5, 1, yresOff);                   // YResolution
    tag(296, 3, 1, 2);                         // ResolutionUnit: inch
    tag(317, 3, 1, 2);                         // Predictor: horizontal differencing
    v.setUint32(q, nextIfd, true); q += 4;
    const rel = (abs) => abs - pos;
    [8, 8, 8].forEach((b, i) => v.setUint16(rel(bpsOff) + i * 2, b, true));
    v.setUint32(rel(xresOff), dpi, true); v.setUint32(rel(xresOff) + 4, 1, true);
    v.setUint32(rel(yresOff), dpi, true); v.setUint32(rel(yresOff) + 4, 1, true);
    pg.stripOffsets.forEach((so, i) => v.setUint32(rel(soOff) + i * 4, dataOff + so, true));
    pg.stripCounts.forEach((sc, i) => v.setUint32(rel(scOff) + i * 4, sc, true));
    chunks.push(buf, pg.data);
    pos = dataOff + pg.data.length;
    if (pg.data.length & 1) { chunks.push(new Uint8Array(1)); pos++; }
  });
  return new Blob(chunks, { type: 'image/tiff' });
}

export async function canvasToBlob(canvas, type = 'image/png') {
  return await new Promise((r) => canvas.toBlob(r, type, 0.93));
}
