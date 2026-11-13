// Gerador de QR Code (byte, correção M, versões 1-10) sem dependências. Devolve SVG.
const ECC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26], NB = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
const raw = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; } return r; };
function rs(data, n) {
  let d = Array(n).fill(0); d[n - 1] = 1; let root = 1;
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { d[j] = mul(d[j], root); if (j + 1 < n) d[j] ^= d[j + 1]; } root = mul(root, 2); }
  const r = Array(n).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); d.forEach((c, i) => { r[i] ^= mul(c, f); }); }
  return r;
}
export function qrSvg(text, px = 0) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1; for (; v <= 10; v++) if (raw(v) >> 3 - ECC[v - 1] * NB[v - 1] >= 0 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= ((raw(v) >> 3) - ECC[v - 1] * NB[v - 1]) * 8) break;
  if (v > 10) throw new Error("Texto demasiado longo para o QR");
  const cap = (raw(v) >> 3) - ECC[v - 1] * NB[v - 1], bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  for (let p = 0xec; bits.length < cap * 8; p ^= 0xec ^ 0x11) put(p, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  const nb = NB[v - 1], el = ECC[v - 1], rc = raw(v) >> 3, ns = nb - rc % nb, sl = Math.floor(rc / nb), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const dat = data.slice(k, k + sl - el + (i < ns ? 0 : 1)); k += dat.length; const e = rs(dat, el); if (i < ns) dat.push(0); blocks.push(dat.concat(e)); }
  const cw = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== sl - el || j >= ns) cw.push(b[i]); });
  const n = v * 4 + 17, M = Array.from({ length: n }, () => Array(n).fill(false)), F = Array.from({ length: n }, () => Array(n).fill(false));
  const set = (x, y, d) => { if (x >= 0 && y >= 0 && x < n && y < n) { M[y][x] = d; F[y][x] = true; } };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  if (v >= 2) { const na = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2, pos = [6]; for (let p = n - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
    pos.forEach((a, i) => pos.forEach((b, j) => { if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); })); }
  const fmt = mask => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = ((d << 10) | r) ^ 0x5412, g = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, g(i)); set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, g(i)); for (let i = 8; i < 15; i++) set(8, n - 15 + i, g(i)); set(8, n - 8, true); };
  fmt(0);
  if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = (v << 12) | r; for (let i = 0; i < 18; i++) { const c = ((b >>> i) & 1) === 1, a = n - 11 + i % 3, q = Math.floor(i / 3); set(a, q, c); set(q, a, c); } }
  for (let i = 0, x = n - 1; x >= 1; x -= 2) { if (x === 6) x = 5; for (let t = 0; t < n; t++) for (let j = 0; j < 2; j++) { const xx = x - j, up = ((x + 1) & 2) === 0, y = up ? n - 1 - t : t; if (!F[y][xx] && i < cw.length * 8) { M[y][xx] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; } } }
  const inv = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!F[y][x] && inv[m](x, y)) M[y][x] = !M[y][x]; };
  const pen = () => { let p = 0, dark = 0;
    for (let a = 0; a < n; a++) for (const hz of [1, 0]) { let run = 1; for (let b = 1; b < n; b++) { const c = hz ? M[a][b] === M[a][b - 1] : M[b][a] === M[b - 1][a]; if (c) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (M[y][x] === M[y][x + 1] && M[y][x] === M[y + 1][x] && M[y][x] === M[y + 1][x + 1]) p += 3;
    for (const r of M) for (const c of r) if (c) dark++; return p + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10; };
  let best = 0, bp = 1e9; for (let m = 0; m < 8; m++) { apply(m); const p = pen(); if (p < bp) { bp = p; best = m; } apply(m); }
  apply(best); fmt(best);
  let d = ""; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) { let e = x; while (e < n && M[y][e]) e++; d += `M${x + 4} ${y + 4}h${e - x}v1h-${e - x}z`; x = e; }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}"${px ? ` width="${px}" height="${px}"` : ""} shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
