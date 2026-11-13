// Ícone PNG da app (prato) na cor do restaurante, sem dependências.
const T = new Uint32Array(256).map((_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const o = new Uint8Array(12 + d.length), v = new DataView(o.buffer); v.setUint32(0, d.length); o.set([...t].map(c => c.charCodeAt(0)), 4); o.set(d, 8); v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length))); return o; };
export async function iconPng(size, hex) {
  const n = parseInt(String(hex).replace("#", ""), 16) || 0xc8a45c, bg = [n >> 16 & 255, n >> 8 & 255, n & 255];
  const fg = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) > 140 ? [20, 16, 12] : [255, 255, 255];
  const raw = new Uint8Array(size * (size * 4 + 1)), c = size / 2, cl = (x, a, b) => Math.max(a, Math.min(b, x));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) { const d = Math.hypot(x + .5 - c, y + .5 - c) / size, px = (aa => aa)(0);
      const ring = cl((.30 - d) * size + .5, 0, 1) * cl((d - .235) * size + .5, 0, 1), disc = cl((.15 - d) * size + .5, 0, 1), a = Math.max(ring, disc), o = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(bg[k] * (1 - a) + fg[k] * a); raw[o + 3] = 255; } }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ih = new Uint8Array(13), v = new DataView(ih.buffer); v.setUint32(0, size); v.setUint32(4, size); ih.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))], out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
