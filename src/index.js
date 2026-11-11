// SITE PÚBLICO DOS RESTAURANTES (só lógica). O desenho está em tema.js. Cloudflare Worker + Neon + R2.
// Aqui NÃO há painel de gestão: o gerente entra no Worker "painel", noutro endereço.
import { iconPng } from "./png.js";
import { siteHtml, acompanharHtml, avisoHtml } from "./tema.js";
const E = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const D = { nome: "O Meu Restaurante", descricao: "Cozinha com alma, feita para partilhar.", whatsapp: "", email_gestor: "", morada: "", horario: "", cor: "#c8a45c", logo: "", capa: "" };
const DAY = 864e5, TOL = 5, tcache = new Map(), enc = new TextEncoder();
const rid = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
const val = (f, k, n = 300) => String(f.get(k) ?? "").trim().slice(0, n);

// ---------- Base de dados (Neon por HTTP); tabelas criam-se sozinhas ----------
async function neon(env, body) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL não configurada");
  const r = await fetch(`https://${new URL(env.DATABASE_URL).host}/sql`, { method: "POST", headers: { "Content-Type": "application/json", "Neon-Connection-String": env.DATABASE_URL }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || "Erro na base de dados");
  return j;
}
const db = async (env, query, params = []) => (await neon(env, { query, params })).rows || [];
let ready;
const schema = env => (ready ||= neon(env, { queries: [
  `create table if not exists tenants(id serial primary key, host text unique not null, nome text, pais text, plano int not null default 1, email text, whatsapp text, expira_em timestamptz, bloqueado boolean not null default false, admin_hash text, criado_em timestamptz not null default now())`,
  `create table if not exists settings(tenant_id int not null, k text not null, v text, primary key(tenant_id,k))`,
  `create table if not exists menu(id serial primary key, tenant_id int not null, categoria text not null, nome text not null, descricao text, preco text, foto text, ativo boolean default true, criado_em timestamptz default now())`,
  `create table if not exists reservas(id serial primary key, tenant_id int not null, nome text, telefone text, email text, data text, hora text, pessoas int, notas text, criado_em timestamptz default now())`,
  `create table if not exists pedidos(id serial primary key, tenant_id int not null, nome text, telefone text, email text, tipo text, itens text, notas text, codigo text, estado text default 'Recebido', criado_em timestamptz default now())`,
  `create table if not exists eventos(id serial primary key, tenant_id int not null, tipo text not null, criado_em timestamptz default now())`,
  `create index if not exists ev_t on eventos(tenant_id,tipo,criado_em)`,
  `create index if not exists pe_t on pedidos(tenant_id,id)`,
  `create table if not exists contactos(id serial primary key, tenant_id int not null, nome text, email text, whatsapp text, origem text, consent boolean not null default true, token text not null, criado_em timestamptz default now(), unique(tenant_id,email), unique(tenant_id,whatsapp))`,
  `create table if not exists novidades(id serial primary key, tenant_id int not null, tipo text not null, titulo text not null, texto text, criado_em timestamptz default now())`,
].map(query => ({ query, params: [] })) }).catch(e => { ready = null; throw e; }));
async function cfg(env, lic) { const o = { ...D, nome: lic.nome || D.nome }; for (const r of await db(env, "select k,v from settings where tenant_id=$1", [lic.id])) if (r.k in D) o[r.k] = r.v; return o; }

// ---------- Empresa pelo endereço (só abre se o Super Admin criou a empresa) ----------
async function tenant(env, host) {
  const hit = tcache.get(host);
  if (hit && Date.now() - hit.at < 6e4) return hit.v;
  const r = (await db(env, "select id,nome,plano,bloqueado,admin_hash,(extract(epoch from expira_em)*1000)::bigint as exp from tenants where host=$1", [host]))[0];
  if (!r) { const v = { status: "inexistente" }; tcache.set(host, { at: Date.now(), v }); return v; }
  const status = r.exp == null ? "pendente" : (r.bloqueado || Math.ceil((Number(r.exp) - Date.now()) / DAY) <= -TOL) ? "bloqueado" : "ativo";
  const v = { id: r.id, nome: r.nome, plano: r.plano, status, hash: r.admin_hash };
  tcache.set(host, { at: Date.now(), v });
  return v;
}

const ht = (h, status = 200, headers = {}) => new Response(h, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
const go = (loc, headers = {}) => new Response(null, { status: 303, headers: { Location: loc, ...headers } });
const js = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...h } });
async function avisar(env, c, assunto, corpo) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM || !c.email_gestor) return;
  await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.RESEND_FROM, to: [c.email_gestor], subject: assunto, html: `<p>${corpo}</p>` }) }).catch(() => {});
}
async function guardarContacto(env, lic, f, origem) {
  if (!f.get("mkt")) return; // só com consentimento
  const email = val(f, "email", 120) || null, wa = val(f, "telefone", 40) || null;
  if (email || wa) await db(env, "insert into contactos(tenant_id,nome,email,whatsapp,origem,token) values($1,$2,$3,$4,$5,$6) on conflict do nothing", [lic.id, val(f, "nome", 100), email, wa, origem, rid(12)]).catch(() => {});
}

async function chat(req, env, c, lic) {
  const sem = r => js({ reply: r });
  try {
    if (lic.plano !== 2 || !env.OPENROUTER_API_KEY) return sem("Assistente indisponível. Fale connosco por WhatsApp.");
    const n = (await db(env, "select count(*) as n from eventos where tenant_id=$1 and tipo='chat' and criado_em>=date_trunc('day',now())", [lic.id]))[0]?.n;
    if (Number(n) >= (Number(env.MAX_CHAT_DIA) || 300)) return sem("O assistente atingiu o limite de hoje. Fale connosco por WhatsApp.");
    const body = await req.json().catch(() => ({}));
    const msgs = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 500) }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return sem("");
    const itens = await db(env, "select categoria,nome,descricao,preco from menu where tenant_id=$1 and ativo order by categoria,id", [lic.id]);
    const sys = `És o assistente do restaurante "${c.nome}". Responde na língua do cliente, de forma curta e simpática. Fala só do restaurante. Usa apenas estas informações e não inventes pratos, preços ou horários.
Descrição: ${c.descricao}. Horário: ${c.horario || "não indicado"}. Morada: ${c.morada || "não indicada"}.
Menu: ${itens.map(i => `${i.categoria}: ${i.nome} (${i.preco || "preço não indicado"}) ${i.descricao || ""}`).join("; ") || "ainda sem menu"}.
Para reservar ou encomendar, indica o formulário da página ou o botão de WhatsApp. Nunca confirmes reservas nem encomendas tu próprio.`;
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini", max_tokens: 300, messages: [{ role: "system", content: sys }, ...msgs] }) });
    const j = await r.json();
    await db(env, "insert into eventos(tenant_id,tipo) values($1,'chat')", [lic.id]);
    return sem(j.choices?.[0]?.message?.content || "Não consegui responder agora. Fale connosco por WhatsApp.");
  } catch (e) { console.error("chat:", e.message); return sem("Erro temporário. Fale connosco por WhatsApp."); }
}

const SW = `self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(clients.claim()));
self.addEventListener("fetch",e=>{const r=e.request;if(r.mode!=="navigate")return;e.respondWith(fetch(r).then(x=>{if(x.ok&&new URL(r.url).pathname==="/"){const k=x.clone();caches.open("v1").then(c=>c.put("/",k))}return x}).catch(()=>caches.match("/").then(x=>x||new Response("Sem ligação à internet.",{status:503}))))});`;

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname, host = u.host.toLowerCase();
    try {
      if (!env.DATABASE_URL) return ht(avisoHtml("Configuração em falta", "Defina DATABASE_URL em Variables and Secrets e faça novo deploy."), 503);
      await schema(env);
      const lic = await tenant(env, host);
      if (p === "/health") return js({ ok: true, host, estado: lic.status, fotos: !!env.FOTOS });
      if (lic.status !== "ativo") return ht(lic.status === "inexistente" ? avisoHtml("Endereço não encontrado", "Este site não existe.") : avisoHtml("Serviço temporariamente indisponível", "Este site está suspenso. Contacte o responsável pelo restaurante."), lic.status === "inexistente" ? 404 : 402);
      if (p === "/sw.js") return new Response(SW, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-cache" } });
      if (p === "/manifest.webmanifest") { const c = await cfg(env, lic); return js({ name: c.nome, short_name: c.nome.slice(0, 12), start_url: "/", scope: "/", display: "standalone", background_color: "#0f0d0b", theme_color: "#0f0d0b", lang: "pt", icons: [192, 512].map(s => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "any maskable" })) }, 200, { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" }); }
      if (p === "/icon-192.png" || p === "/icon-512.png") { const c = await cfg(env, lic); return new Response(await iconPng(p === "/icon-192.png" ? 192 : 512, c.cor), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } }); }
      if (p.startsWith("/f/")) { // fotos: só as da própria empresa
        const [, , tid, nome] = p.split("/");
        if (!env.FOTOS || Number(tid) !== lic.id || !/^[a-f0-9]+\.(jpg|png|webp)$/.test(nome || "")) return new Response("não encontrado", { status: 404 });
        const o = await env.FOTOS.get(`${tid}/${nome}`); if (!o) return new Response("não encontrado", { status: 404 });
        return new Response(o.body, { headers: { "Content-Type": o.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
      }
      if (p === "/sair") { await db(env, "update contactos set consent=false where token=$1 and tenant_id=$2", [u.searchParams.get("c") || "", lic.id]); return ht(avisoHtml("Subscrição cancelada", "Não receberá mais emails de novidades.")); }
      if (p === "/ev" && req.method === "POST") {
        const ev = (await req.text()).slice(0, 12);
        if (["wa", "reservar", "encomendar"].includes(ev)) ctx.waitUntil(db(env, "insert into eventos(tenant_id,tipo) values($1,$2)", [lic.id, ev]).catch(() => {}));
        return new Response(null, { status: 204 });
      }
      if (p === "/api/chat" && req.method === "POST") return chat(req, env, await cfg(env, lic), lic);
      if (p === "/pedido" && u.searchParams.get("c")) return go("/pedido/" + encodeURIComponent(u.searchParams.get("c").trim().slice(0, 12)));
      if (p.startsWith("/pedido/") && lic.plano === 2) {
        const c = await cfg(env, lic), cod = decodeURIComponent(p.slice(8)).toUpperCase().slice(0, 12);
        const r = await db(env, "select tipo,itens,estado from pedidos where codigo=$1 and tenant_id=$2", [cod, lic.id]);
        return r.length ? ht(acompanharHtml({ c, codigo: cod, tipo: r[0].tipo, itens: r[0].itens, estado: r[0].estado })) : ht(avisoHtml("Encomenda não encontrada", "Confirme o código e tente de novo.", c.cor), 404);
      }
      if (p === "/reservar" || p === "/encomendar") {
        if (req.method !== "POST") return go("/");
        const f = await req.formData();
        if (val(f, "site")) return go("/?ok=1"); // anti-spam
        const c = await cfg(env, lic);
        let dest = "/?ok=1";
        if (p === "/reservar") {
          await db(env, "insert into reservas(tenant_id,nome,telefone,email,data,hora,pessoas,notas) values($1,$2,$3,$4,$5,$6,$7,$8)", [lic.id, val(f, "nome", 100), val(f, "telefone", 40), val(f, "email", 120), val(f, "data", 12), val(f, "hora", 8), Math.min(50, Math.max(1, Number(f.get("pessoas")) || 1)), val(f, "notas", 500)]);
          ctx.waitUntil(avisar(env, c, "Nova reserva", `${E(val(f, "nome"))} (${E(val(f, "telefone"))}) · ${E(val(f, "data"))} ${E(val(f, "hora"))} · ${E(val(f, "pessoas"))} pessoas`));
          await guardarContacto(env, lic, f, "reserva");
        } else {
          const cod = rid(3).toUpperCase(), mesa = val(f, "mesa", 10);
          await db(env, "insert into pedidos(tenant_id,nome,telefone,email,tipo,itens,notas,codigo) values($1,$2,$3,$4,$5,$6,$7,$8)", [lic.id, val(f, "nome", 100), val(f, "telefone", 40), val(f, "email", 120), val(f, "tipo", 20), val(f, "itens", 800), mesa ? "Mesa " + mesa : "", cod]);
          if (lic.plano === 2) dest = `/pedido/${cod}`;
          ctx.waitUntil(avisar(env, c, "Nova encomenda", `${E(val(f, "nome"))} (${E(val(f, "telefone"))}) · ${E(val(f, "tipo"))}${mesa ? " · Mesa " + E(mesa) : ""}: ${E(val(f, "itens"))}`));
          await guardarContacto(env, lic, f, "encomenda");
        }
        return go(dest);
      }
      if (p !== "/") return ht(avisoHtml("Página não encontrada", "Esta página não existe.", (await cfg(env, lic)).cor), 404);
      const nova = !/(^|; )sid=/.test(req.headers.get("Cookie") || ""), c = await cfg(env, lic);
      if (nova) ctx.waitUntil(db(env, "insert into eventos(tenant_id,tipo) values($1,'visita')", [lic.id]).catch(() => {}));
      const [itens, nv] = await Promise.all([db(env, "select categoria,nome,descricao,preco,foto from menu where tenant_id=$1 and ativo order by categoria,id", [lic.id]), db(env, "select tipo,titulo,texto from novidades where tenant_id=$1 order by id desc limit 6", [lic.id])]);
      const resp = ht(siteHtml({ c, plano: lic.plano, itens, nv, ok: !!u.searchParams.get("ok") }));
      if (nova) resp.headers.append("Set-Cookie", `sid=${rid(8)}; Path=/; HttpOnly; Secure; SameSite=Lax`); // cookie de sessão
      return resp;
    } catch (e) { console.error(e); return ht(avisoHtml("Erro temporário", "Tente de novo daqui a pouco."), 500); }
  },
};
