// PAINEL DO GERENTE (área escondida: endereço próprio, login por email, recuperação de senha por Resend).
// Mexe só nos dados da empresa do gerente que entrou. Cloudflare Worker + Neon + R2.
import { qrSvg } from "./qr.js";
const E = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const D = { nome: "O Meu Restaurante", descricao: "Cozinha com alma, feita para partilhar.", whatsapp: "", email_gestor: "", morada: "", horario: "", cor: "#c8a45c", logo: "", capa: "" };
const ESTADOS = ["Recebido", "Em preparação", "Pronto / a caminho", "Concluído"];
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
  `create schema if not exists rs`,
  `create table if not exists rs.tenants(id serial primary key, host text unique not null, nome text, pais text, plano int not null default 1, email text, whatsapp text, expira_em timestamptz, bloqueado boolean not null default false, admin_hash text, criado_em timestamptz not null default now())`,
  `create table if not exists rs.settings(tenant_id int not null, k text not null, v text, primary key(tenant_id,k))`,
  `create table if not exists rs.menu(id serial primary key, tenant_id int not null, categoria text not null, nome text not null, descricao text, preco text, foto text, ativo boolean default true, criado_em timestamptz default now())`,
  `create table if not exists rs.reservas(id serial primary key, tenant_id int not null, nome text, telefone text, email text, data text, hora text, pessoas int, notas text, criado_em timestamptz default now())`,
  `create table if not exists rs.pedidos(id serial primary key, tenant_id int not null, nome text, telefone text, email text, tipo text, itens text, notas text, codigo text, estado text default 'Recebido', criado_em timestamptz default now())`,
  `create table if not exists rs.eventos(id serial primary key, tenant_id int not null, tipo text not null, criado_em timestamptz default now())`,
  `create index if not exists ev_t on rs.eventos(tenant_id,tipo,criado_em)`,
  `create index if not exists pe_t on rs.pedidos(tenant_id,id)`,
  `create table if not exists rs.contactos(id serial primary key, tenant_id int not null, nome text, email text, whatsapp text, origem text, consent boolean not null default true, token text not null, criado_em timestamptz default now(), unique(tenant_id,email), unique(tenant_id,whatsapp))`,
  `create table if not exists rs.novidades(id serial primary key, tenant_id int not null, tipo text not null, titulo text not null, texto text, criado_em timestamptz default now())`,
  `create table if not exists rs.superadmin(id int primary key, admin_hash text)`,
  `create table if not exists rs.recuperacoes(id serial primary key, escopo text not null, tenant_id int, token_hash text not null, expira_em timestamptz not null, usado boolean not null default false, criado_em timestamptz default now())`,
].map(query => ({ query, params: [] })) }).catch(e => { ready = null; throw e; }));
async function cfg(env, lic) { const o = { ...D, nome: lic.nome || D.nome }; for (const r of await db(env, "select k,v from rs.settings where tenant_id=$1", [lic.id])) if (r.k in D) o[r.k] = r.v; return o; }

// ---------- Empresa pelo endereço (só abre se o Super Admin criou a empresa) ----------
async function tenant(env, host) {
  const hit = tcache.get(host);
  if (hit && Date.now() - hit.at < 6e4) return hit.v;
  const r = (await db(env, "select id,nome,plano,bloqueado,admin_hash,(extract(epoch from expira_em)*1000)::bigint as exp from rs.tenants where host=$1", [host]))[0];
  if (!r) { const v = { status: "inexistente" }; tcache.set(host, { at: Date.now(), v }); return v; }
  const status = r.exp == null ? "pendente" : (r.bloqueado || Math.ceil((Number(r.exp) - Date.now()) / DAY) <= -TOL) ? "bloqueado" : "ativo";
  const v = { id: r.id, nome: r.nome, plano: r.plano, status, hash: r.admin_hash };
  tcache.set(host, { at: Date.now(), v });
  return v;
}

// ---------- Sessão do painel ----------
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function pbkdf2(s, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(s), "PBKDF2", false, ["deriveBits"]);
  return [...new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, k, 256))].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function verificar(s, stored) { if (!stored) return false; const [salt, h] = stored.split(":"); return await pbkdf2(s, salt) === h; }
async function hashSenha(s) { const salt = rid(8); return `${salt}:${await pbkdf2(s, salt)}`; }
// ---------- Aparência: escuro, elegante, fotos grandes, letra grande ----------
const lum = h => { const n = parseInt(String(h).replace("#", ""), 16) || 0; return (.299 * (n >> 16 & 255) + .587 * (n >> 8 & 255) + .114 * (n & 255)) / 255; };
const CSS = cor => `:root{--c:${E(cor)};--oc:${lum(cor) > .55 ? "#14100c" : "#fff"};--bg:#0f0d0b;--cd:#1a1613;--bd:#3a2f24;--tx:#f4efe8;--mu:#cbbfb0}*{box-sizing:border-box}[hidden]{display:none!important}
html{font-size:112.5%;scroll-behavior:smooth;scroll-padding-top:4.5rem}body{margin:0;font-family:"Atkinson Hyperlegible",system-ui,sans-serif;background:var(--bg);color:var(--tx);line-height:1.65;padding-bottom:env(safe-area-inset-bottom,0px)}
h1,h2,h3{font-family:"Playfair Display",Georgia,serif;font-weight:600;line-height:1.2;margin:.2rem 0 .7rem}h1{font-size:2.5rem}h2{font-size:1.7rem}h3{font-size:1.3rem;color:var(--c);margin-top:1.4rem}a{color:var(--c)}.mu{color:var(--mu)}.wrap{max-width:62rem;margin:auto;padding:0 1rem 6rem}
.hero{min-height:27rem;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:3.5rem 1.2rem;background:linear-gradient(#0008,#0f0d0bf0),var(--capa,radial-gradient(circle at 70% 15%,#3b2a17,#0f0d0b)) center/cover}
.hero p{max-width:34rem;font-size:1.15rem;color:#e7dfd3;margin:.2rem 0 1.2rem}.eb{color:var(--c);font-family:"Playfair Display",serif;font-style:italic;font-size:1.25rem}.lg{max-height:5rem;margin-bottom:.8rem;border-radius:12px}.mesa{margin-top:.8rem;border:1.5px solid var(--c);color:var(--c);padding:.3rem 1rem;border-radius:6px;font-weight:700}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:3.2rem;padding:0 1.5rem;border-radius:8px;border:1.5px solid var(--c);background:var(--c);color:var(--oc);font:700 .9rem "Atkinson Hyperlegible",sans-serif;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;cursor:pointer;margin:.3rem}.btn.o{background:transparent;color:var(--c)}.btn.s{min-height:2.6rem;font-size:.8rem;padding:0 1rem;margin:.2rem}.btn.f{width:100%;margin:1rem 0 0}
.chips,.tabs{display:flex;gap:.5rem;overflow-x:auto;padding:.7rem 1rem;border-bottom:1px solid var(--bd)}.chips{position:sticky;top:0;z-index:9;background:#0f0d0bf2;backdrop-filter:blur(6px)}.tabs{border:0;padding:.7rem 0}
.chip{min-height:2.7rem;padding:0 1.1rem;display:inline-flex;align-items:center;border:1.5px solid var(--bd);border-radius:6px;color:var(--tx);text-decoration:none;white-space:nowrap;font:700 1rem "Atkinson Hyperlegible",sans-serif;background:transparent;cursor:pointer}.chip.on,.chip:hover{border-color:var(--c);color:var(--c)}
.card{background:var(--cd);border:1px solid var(--bd);border-radius:14px;padding:1.3rem;margin:1.2rem 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:1rem}
.dish{background:#14100d;border:1px solid var(--bd);border-radius:14px;overflow:hidden}.im{aspect-ratio:4/3;width:100%;object-fit:cover;display:block;background:linear-gradient(135deg,#2a2018,#14100c)}.ph{display:grid;place-items:center}.bd{padding:1rem}.dish b{display:block;font-size:1.1rem}.dish small{display:block;color:var(--mu);margin:.2rem 0 .6rem;font-size:.95rem}.pr{color:var(--c);font-weight:700;font-size:1.15rem}.tag{display:inline-block;border:1px solid var(--c);color:var(--c);border-radius:4px;padding:0 .5rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.4rem}
label{display:block;font-weight:700;margin:.9rem 0 .25rem}input,select,textarea{width:100%;min-height:3.2rem;padding:.6rem .8rem;font:inherit;border:1.5px solid var(--bd);border-radius:8px;background:#100d0a;color:var(--tx)}input[type=color]{padding:.2rem}input[type=file]{padding:.7rem}:focus-visible{outline:3px solid var(--c);outline-offset:2px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
.chk{display:flex;gap:.7rem;align-items:flex-start;font-weight:400;margin-top:1rem}.chk input{width:1.6rem;height:1.6rem;min-height:0;margin-top:.2rem;accent-color:var(--c)}.ok{border:1.5px solid var(--c);border-radius:10px;padding:1rem;margin:.8rem 0}
.lv{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.7rem 0;border-bottom:1px solid var(--bd)}.lv:last-child{border:0}.bar{height:.9rem;background:var(--bd);border-radius:1rem;overflow:hidden}.bar i{display:block;height:100%;background:var(--c)}.foot{text-align:center;color:var(--mu);padding:2rem 0}
.fab{position:fixed;right:1rem;bottom:calc(env(safe-area-inset-bottom,0px) + 4.5rem);z-index:8}.fab .btn{margin:0;box-shadow:0 4px 16px #000a}.chat{display:none;width:min(22rem,92vw);background:var(--cd);border:1px solid var(--bd);border-radius:14px;margin-bottom:.6rem}.chat.on{display:block}
#cm{height:15rem;overflow:auto;padding:.8rem}#cm p{margin:.4rem 0;padding:.6rem .8rem;border-radius:10px;background:#100d0a}#cm p.u{background:var(--c);color:var(--oc);text-align:right}.chat form{display:flex;gap:.4rem;padding:.6rem}.chat input{min-height:3rem}
.steps{list-style:none;padding:0}.steps li{display:flex;align-items:center;gap:.9rem;padding:.8rem;border-radius:10px;margin:.4rem 0;border:1.5px solid var(--bd)}.steps b{width:2.3rem;height:2.3rem;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--bd)}.steps .d b{background:var(--c);color:var(--oc);border-color:var(--c)}.steps .cur{border-color:var(--c);color:var(--c);font-weight:700}
.ckb,.toast{position:fixed;left:1rem;right:1rem;margin:auto;max-width:34rem;background:var(--cd);border:1px solid var(--c);border-radius:14px;padding:1rem 1.2rem;z-index:30;box-shadow:0 6px 24px #000c}.ckb{bottom:calc(env(safe-area-inset-bottom,0px) + .8rem)}.toast{top:1rem}.toast span{display:block;color:var(--mu)}
.center{text-align:center;padding:4rem 1rem}@media(max-width:34rem){h1{font-size:2.1rem}.g2{grid-template-columns:1fr}}`;
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Playfair+Display:ital,wght@0,600;1,600&display=swap" rel="stylesheet">`;
const page = (title, cor, body, status = 200, head = "") => new Response(`<!doctype html><html lang="pt"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${E(title)}</title><meta name="theme-color" content="#0f0d0b"><meta name="robots" content="noindex,nofollow">${head}${FONTS}<style>${CSS(cor)}</style>${body}`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" } });
const go = (loc, headers = {}) => new Response(null, { status: 303, headers: { Location: loc, ...headers } });
const js = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...h } });

// ---------- QR Codes (cada QR usa o endereço da própria empresa, nunca abre o de outra) ----------
function qrPage(c, origin, n) {
  const cards = [["Site", origin + "/"], ["Menu", origin + "/?ref=menu#menu"], ...Array.from({ length: n }, (_, i) => [`Mesa ${i + 1}`, `${origin}/?mesa=${i + 1}#menu`])];
  return new Response(`<!doctype html><html lang="pt"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR Codes</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:1rem;background:#fff;color:#000}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:1rem}.q{border:2px solid #000;border-radius:12px;padding:1rem;text-align:center;break-inside:avoid}.q svg{width:100%;max-width:13rem;height:auto}h2{margin:.2rem 0}.u{font-size:.7rem;word-break:break-all;color:#444}@media print{.np{display:none}body{padding:0}}</style><p class="np"><button onclick="print()" style="font-size:1.2rem;padding:.6rem 1.2rem">Imprimir</button> <a href="/admin?t=qr">Voltar</a></p><div class="g">${cards.map(([t, u]) => `<div class="q"><h2>${E(c.nome)}</h2><b style="font-size:1.4rem">${E(t)}</b>${qrSvg(u)}<div>Aponte a câmara do telemóvel</div><div class="u">${E(u)}</div></div>`).join("")}</div>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------- Painel do restaurante ----------
const UP_JS = `document.addEventListener("change",async function(e){var i=e.target;if(i.type!=="file"||!i.dataset.alvo||!i.files[0])return;var s=document.getElementById("st-"+i.dataset.alvo);s.textContent="A enviar…";
try{var img=await createImageBitmap(i.files[0]),k=Math.min(1,1600/img.width),c=document.createElement("canvas");c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext("2d").drawImage(img,0,0,c.width,c.height);
var b=await new Promise(function(r){c.toBlob(r,"image/jpeg",.82)}),fd=new FormData();fd.append("f",b,"foto.jpg");var r=await fetch("/admin/upload",{method:"POST",body:fd}),j=await r.json();
if(j.url){document.getElementById(i.dataset.alvo).value=j.url;s.innerHTML='<img src="'+j.url+'" style="height:4rem;border-radius:8px">'}else s.textContent=j.erro||"Erro no envio"}catch(x){s.textContent="Não foi possível enviar a foto."}});`;
const campo = (id, label, v = "", extra = "") => `<label>${label}<input id="${id}" name="${id}" value="${E(v)}" ${extra}></label>`;
const foto = (id, label, v) => `<label>${label}: colar link<input id="${id}" name="${id}" value="${E(v)}" placeholder="https://…"></label><label>ou enviar do telemóvel/computador<input type="file" accept="image/*" data-alvo="${id}"></label><div id="st-${id}" class="mu">${v ? `<img src="${E(v)}" style="height:4rem;border-radius:8px" alt="">` : ""}</div>`;
async function painel(env, u, lic) {
  const t = u.searchParams.get("t") || "resumo", c = await cfg(env, lic), tid = lic.id, p2 = lic.plano === 2, site = "https://" + lic.host;
  const L = [["resumo", "Resumo"], ["menu", "Menu"], ["novidades", "Novidades"], ["marketing", "Marketing"], ["qr", "QR Code"], ["config", "Configuração"], ...(p2 ? [["stats", "Estatísticas"]] : [])];
  let b = "";
  if (t === "menu") {
    const m = await db(env, "select id,categoria,nome,preco,foto from rs.menu where tenant_id=$1 order by categoria,id", [tid]);
    b = `<form class="card" method="post" action="/admin/menu"><h3>Adicionar prato</h3>${campo("categoria", "Categoria (ex.: Pratos)", "", "required")}${campo("nome", "Nome do prato", "", "required")}${campo("descricao", "Descrição")}${campo("preco", "Preço (ex.: 9 500 Kz)")}${foto("foto", "Foto do prato", "")}<button class="btn f">Adicionar</button></form>
<div class="card"><h3>Pratos (${m.length})</h3>${m.map(i => `<div class="lv"><span>${i.foto ? `<img src="${E(i.foto)}" style="height:3rem;border-radius:6px;vertical-align:middle" alt=""> ` : ""}<b>${E(i.nome)}</b> <span class="mu">${E(i.categoria)} · ${E(i.preco || "")}</span></span><form method="post" action="/admin/menu/apagar"><input type="hidden" name="id" value="${i.id}"><button class="btn s o">Apagar</button></form></div>`).join("") || "Ainda sem pratos."}</div>`;
  } else if (t === "novidades") {
    const n = await db(env, "select id,tipo,titulo from rs.novidades where tenant_id=$1 order by id desc limit 30", [tid]);
    b = `<form class="card" method="post" action="/admin/novidade"><h3>Nova novidade ou curiosidade</h3><p class="mu">Aparece numa secção do site e, de vez em quando, num aviso rápido para o cliente.</p><label>Tipo<select name="tipo"><option>Novidade</option><option>Curiosidade</option><option>Promoção</option></select></label>${campo("titulo", "Título", "", "required")}<label>Texto<textarea name="texto" rows="3"></textarea></label><button class="btn f">Publicar</button></form>
<div class="card">${n.map(i => `<div class="lv"><span><span class="tag">${E(i.tipo)}</span> ${E(i.titulo)}</span><form method="post" action="/admin/novidade/apagar"><input type="hidden" name="id" value="${i.id}"><button class="btn s o">Apagar</button></form></div>`).join("") || "Sem novidades."}</div>`;
  } else if (t === "marketing") {
    const s = (await db(env, "select count(*) filter (where consent and email is not null) as e, count(*) filter (where consent) as c from rs.contactos where tenant_id=$1", [tid]))[0] || {};
    if (!p2) b = `<div class="card center"><h2>Marketing faz parte do Plano 2</h2><p>Já recolheu <b>${s.c || 0}</b> contactos com consentimento. Passe ao Plano 2 para lhes enviar novidades e promoções.</p></div>`;
    else {
      const r = await db(env, "select nome,email,whatsapp,origem from rs.contactos where tenant_id=$1 and consent order by id desc limit 50", [tid]), res = u.searchParams.get("env");
      const msg = res == null ? "" : res > 0 ? `Enviado para ${res} contactos.` : res === "0" ? "Ainda não há contactos com email e consentimento." : res === "-1" ? "O envio de email ainda não está configurado (RESEND_API_KEY e RESEND_FROM)." : "Falha no envio. Tente mais tarde.";
      b = `${msg ? `<p class="ok">${E(msg)}</p>` : ""}<form class="card" method="post" action="/admin/campanha"><h3>Enviar email de novidades</h3><p class="mu">${s.e || 0} contactos com email e consentimento (cada envio vai até 100). Cada email leva um link para cancelar a subscrição.</p>${campo("assunto", "Assunto", "", "required")}<label>Mensagem<textarea name="texto" rows="5" required></textarea></label><button class="btn f">Enviar</button></form>
<div class="card"><h3>Contactos (${s.c || 0})</h3>${r.map(x => `<div class="lv"><span><b>${E(x.nome || "")}</b><br><span class="mu">${E(x.email || "")} ${E(x.whatsapp || "")} · ${E(x.origem || "")}</span></span>${x.whatsapp ? `<a class="btn s o" target="_blank" href="https://wa.me/${x.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(`Olá ${x.nome || ""}! Novidades de ${c.nome}: `)}">WhatsApp</a>` : ""}</div>`).join("") || "Ainda sem contactos."}</div>`;
    }
  } else if (t === "qr") {
    b = `<div class="card"><h3>QR Codes para imprimir</h3><p>Cada QR abre <b>sempre o site deste restaurante</b> (${E(lic.host)}). Os QR de mesa abrem o menu e marcam a mesa nas encomendas.</p><form method="get" action="/admin/qr" target="_blank">${campo("mesas", "Número de mesas", "10", 'type="number" min="0" max="100"')}<button class="btn f">Abrir página para imprimir</button></form></div><div class="grid"><div class="card" style="text-align:center"><b>Site</b>${qrSvg(site + "/", 220)}</div><div class="card" style="text-align:center"><b>Menu</b>${qrSvg(site + "/?ref=menu#menu", 220)}</div></div>`;
  } else if (t === "config") {
    b = `<form class="card" method="post" action="/admin/config"><h3>Configuração</h3>${campo("nome", "Nome", c.nome)}${campo("descricao", "Descrição", c.descricao)}${campo("whatsapp", "WhatsApp (com indicativo)", c.whatsapp)}${campo("email_gestor", "Email que recebe reservas e encomendas", c.email_gestor)}${campo("morada", "Morada", c.morada)}${campo("horario", "Horário", c.horario)}${campo("cor", "Cor de destaque", c.cor, 'type="color"')}${foto("logo", "Logo", c.logo)}${foto("capa", "Imagem de capa", c.capa)}<button class="btn f">Guardar</button></form>`;
  } else if (t === "stats" && p2) {
    const s = await db(env, "select tipo, count(*) filter (where criado_em > now() - interval '7 days') as s7, count(*) filter (where criado_em > now() - interval '30 days') as s30 from rs.eventos where tenant_id=$1 group by tipo", [tid]);
    const nm = { visita: "Visitas (sessões)", wa: "Cliques WhatsApp", reservar: "Cliques Reservar", encomendar: "Cliques Encomendar", chat: "Mensagens no chat" };
    b = `<div class="card"><h3>Atividade</h3>${Object.keys(nm).map(k => { const r = s.find(x => x.tipo === k); return `<div style="margin:.9rem 0"><div class="lv" style="border:0;padding:0"><b>${nm[k]}</b><span>7 dias: <b>${r?.s7 ?? 0}</b> · 30 dias: <b>${r?.s30 ?? 0}</b></span></div><div class="bar"><i style="width:${Math.min(100, (r?.s30 ?? 0) / 20)}%"></i></div></div>`; }).join("")}</div>`;
  } else {
    const rs = await db(env, "select nome,telefone,data,hora,pessoas from rs.reservas where tenant_id=$1 order by id desc limit 15", [tid]), ps = await db(env, "select id,nome,telefone,tipo,itens,notas,codigo,estado from rs.pedidos where tenant_id=$1 order by id desc limit 15", [tid]);
    b = `<div class="card"><h3>Reservas</h3>${rs.map(r => `<div class="lv"><span><b>${E(r.nome)}</b> ${E(r.telefone)}</span><span>${E(r.data)} ${E(r.hora)} · ${r.pessoas} pess.</span></div>`).join("") || "Sem reservas."}</div><div class="card"><h3>Encomendas</h3>${ps.map(r => `<div class="lv"><span><b>${E(r.nome)}</b> ${E(r.telefone)} · ${E(r.tipo)}${r.notas ? " · " + E(r.notas) : ""}<br>${E(r.itens)}${p2 ? `<br><small class="mu">Código ${E(r.codigo)}</small>` : ""}</span>${p2 ? `<form method="post" action="/admin/estado"><input type="hidden" name="id" value="${r.id}"><select name="estado">${ESTADOS.map(s => `<option${s === r.estado ? " selected" : ""}>${s}</option>`).join("")}</select><button class="btn s">OK</button></form>` : ""}</div>`).join("") || "Sem encomendas."}</div>`;
  }
  return page("Painel", c.cor, `<main class="wrap"><div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding-top:1rem"><h2>${E(c.nome)}</h2><span><a href="${site}" target="_blank">Ver site</a> · Plano ${lic.plano} <form method="post" action="/sair" style="display:inline"><button class="btn s o">Sair</button></form></span></div><nav class="tabs">${L.map(x => `<a class="chip${t === x[0] ? " on" : ""}" href="?t=${x[0]}">${x[1]}</a>`).join("")}</nav>${b}</main><script>${UP_JS}</script>`);
}
async function campanha(env, c, host, lic, f) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return -1;
  const rows = await db(env, "select email,token from rs.contactos where tenant_id=$1 and consent and email is not null order by id desc limit 100", [lic.id]);
  if (!rows.length) return 0;
  const assunto = val(f, "assunto", 120), txt = val(f, "texto", 2000);
  const body = rows.map(r => ({ from: env.RESEND_FROM, to: [r.email], subject: assunto, html: `<div style="font-family:sans-serif;max-width:34rem;margin:auto"><h2>${E(c.nome)}</h2><p>${E(txt).replace(/\n/g, "<br>")}</p><hr><small>Recebe este email porque aceitou receber novidades de ${E(c.nome)}. <a href="https://${host}/sair?c=${r.token}">Cancelar subscrição</a></small></div>` }));
  const r = await fetch("https://api.resend.com/emails/batch", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.ok ? rows.length : -2;
}

const sha = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
async function tenantById(env, id) {
  const r = (await db(env, "select id,host,nome,plano,email,bloqueado,admin_hash,(extract(epoch from expira_em)*1000)::bigint as exp from rs.tenants where id=$1", [id]))[0];
  if (!r) return null;
  const status = r.exp == null ? "pendente" : (r.bloqueado || Math.ceil((Number(r.exp) - Date.now()) / DAY) <= -TOL) ? "bloqueado" : "ativo";
  return { id: r.id, host: r.host, nome: r.nome, plano: r.plano, email: r.email, status, hash: r.admin_hash };
}
async function sessao(req, env) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|; )p=(\d+)\.(\d+)\.([0-9a-f]+)/);
  if (!m || +m[2] < Date.now()) return null;
  const t = await tenantById(env, +m[1]);
  return t && t.hash && m[3] === await hmac(t.hash, `p${m[1]}.${m[2]}`) ? t : null;
}
async function enviarEmail(env, para, assunto, corpo) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return false;
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.RESEND_FROM, to: [para], subject: assunto, html: corpo }) });
  return r.ok;
}
const entrada = (m = "") => page("Painel do restaurante", D.cor, `<main class="wrap"><h2 style="margin-top:2rem">Painel do restaurante</h2>${m ? `<p class="ok">${E(m)}</p>` : ""}<form class="card" method="post" action="/entrar"><label>Email<input type="email" name="email" required autocomplete="username" autofocus></label><label>Senha<input type="password" name="senha" required autocomplete="current-password"></label><button class="btn f">Entrar</button></form><p><a href="/esqueci">Esqueci a senha</a></p></main>`);
const MSG = { repor: "Senha alterada. Entre com a nova senha.", erro: "Email ou senha incorretos." };
const novaSenhaForm = tok => page("Nova senha", D.cor, `<main class="wrap"><h2 style="margin-top:2rem">Definir nova senha</h2><form class="card" method="post" action="/repor"><input type="hidden" name="t" value="${E(tok)}"><label>Nova senha (mínimo 8 caracteres)<input type="password" name="s1" minlength="8" required autocomplete="new-password"></label><label>Repetir a senha<input type="password" name="s2" minlength="8" required autocomplete="new-password"></label><button class="btn f">Guardar</button></form></main>`);
const tokenValido = async (env, tok) => (await db(env, "select id,tenant_id from rs.recuperacoes where escopo='painel' and token_hash=$1 and not usado and expira_em>now()", [await sha(tok || "")]))[0];

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname;
    try {
      if (!env.DATABASE_URL) return page("Configuração", D.cor, "<main class='wrap'><h3>Configuração em falta</h3><p>Defina DATABASE_URL em Variables and Secrets.</p></main>", 503);
      if (p === "/health") { try { await schema(env); return js({ ok: true, painel: true }); } catch (e) { return js({ ok: false, erro: String(e.message).slice(0, 300) }, 500); } }
      await schema(env);
      if (p === "/entrar" && req.method === "POST") {
        const f = await req.formData(), email = val(f, "email", 120).toLowerCase();
        const r = (await db(env, "select id from rs.tenants where lower(email)=$1 limit 1", [email]))[0], t = r && await tenantById(env, r.id);
        if (!t || !(await verificar(val(f, "senha", 200), t.hash))) return entrada(MSG.erro);
        const exp = Date.now() + 12 * 36e5;
        return go("/", { "Set-Cookie": `p=${t.id}.${exp}.${await hmac(t.hash, `p${t.id}.${exp}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` });
      }
      if (p === "/esqueci") {
        if (req.method === "POST") {
          const email = val(await req.formData(), "email", 120).toLowerCase();
          const r = (await db(env, "select id from rs.tenants where lower(email)=$1 limit 1", [email]))[0];
          if (r) {
            const n = (await db(env, "select count(*) as n from rs.recuperacoes where escopo='painel' and tenant_id=$1 and criado_em>now()-interval '1 hour'", [r.id]))[0].n;
            if (Number(n) < 3) {
              const tok = rid(32);
              await db(env, "insert into rs.recuperacoes(escopo,tenant_id,token_hash,expira_em) values('painel',$1,$2,now()+interval '30 minutes')", [r.id, await sha(tok)]);
              await enviarEmail(env, email, "Recuperar a senha do painel", `<p>Recebemos um pedido para recuperar a senha do seu painel.</p><p><a href="${u.origin}/repor?t=${tok}">Definir nova senha</a> (válido por 30 minutos).</p><p>Se não foi você, ignore este email.</p>`);
            }
          }
          return page("Recuperar senha", D.cor, "<main class='wrap'><h2 style='margin-top:2rem'>Verifique o seu email</h2><p>Se este email estiver registado, enviámos um link para definir uma nova senha. O link vale 30 minutos.</p><a href='/'>Voltar</a></main>");
        }
        return page("Recuperar senha", D.cor, `<main class="wrap"><h2 style="margin-top:2rem">Recuperar senha</h2><form class="card" method="post" action="/esqueci"><label>O seu email de gestor<input type="email" name="email" required autofocus></label><button class="btn f">Enviar link</button></form><a href="/">Voltar</a></main>`);
      }
      if (p === "/repor") {
        if (req.method === "POST") {
          const f = await req.formData(), tok = val(f, "t", 80), r = await tokenValido(env, tok);
          if (!r) return page("Link inválido", D.cor, "<main class='wrap'><h2>Link inválido ou expirado</h2><a href='/esqueci'>Pedir novo link</a></main>", 400);
          const s1 = String(f.get("s1") || ""), s2 = String(f.get("s2") || "");
          if (s1.length < 8 || s1 !== s2) return novaSenhaForm(tok);
          await db(env, "update rs.tenants set admin_hash=$1 where id=$2", [await hashSenha(s1.slice(0, 100)), r.tenant_id]);
          await db(env, "update rs.recuperacoes set usado=true where escopo='painel' and tenant_id=$1", [r.tenant_id]);
          return go("/?m=repor");
        }
        const tok = u.searchParams.get("t") || "";
        return (await tokenValido(env, tok)) ? novaSenhaForm(tok) : page("Link inválido", D.cor, "<main class='wrap'><h2>Link inválido ou expirado</h2><a href='/esqueci'>Pedir novo link</a></main>", 400);
      }
      if (p === "/sair") return go("/", { "Set-Cookie": "p=; Path=/; Max-Age=0" });
      const lic = await sessao(req, env);
      if (!lic) return req.method === "POST" || p !== "/" ? go("/") : entrada(MSG[u.searchParams.get("m")] || "");
      if (lic.status !== "ativo") return page("Licença", D.cor, `<main class="center"><h2>Licença expirada ou suspensa</h2><p>Contacte o fornecedor do serviço para a renovar.</p><form method="post" action="/sair"><button class="btn o">Sair</button></form></main>`, 402);
      const site = "https://" + lic.host;
      if (p.startsWith("/f/")) { // fotos: só as do próprio restaurante
        const [, , tid, nome] = p.split("/");
        if (!env.FOTOS || Number(tid) !== lic.id || !/^[a-f0-9]+\.(jpg|png|webp)$/.test(nome || "")) return new Response("não encontrado", { status: 404 });
        const o = await env.FOTOS.get(`${tid}/${nome}`); if (!o) return new Response("não encontrado", { status: 404 });
        return new Response(o.body, { headers: { "Content-Type": o.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
      }
      if (p === "/admin/qr") return qrPage(await cfg(env, lic), site, Math.min(100, Math.max(0, Number(u.searchParams.get("mesas")) || 0)));
        if (p === "/admin/upload" && req.method === "POST") {
          if (!env.FOTOS) return js({ erro: "Envio de fotos ainda não configurado. Cole um link da foto." }, 501);
          const f = (await req.formData()).get("f"), ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[f?.type];
          if (!ext || f.size > 4e6) return js({ erro: "Use uma foto JPG, PNG ou WebP até 4 MB." }, 400);
          const nome = `${rid(10)}.${ext}`; await env.FOTOS.put(`${lic.id}/${nome}`, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
          return js({ url: `/f/${lic.id}/${nome}` });
        }
        if (req.method === "POST") {
          const f = await req.formData(), id = Number(f.get("id")); let dest = "/admin?t=menu";
          if (p === "/admin/menu") await db(env, "insert into rs.menu(tenant_id,categoria,nome,descricao,preco,foto) values($1,$2,$3,$4,$5,$6)", [lic.id, val(f, "categoria", 60), val(f, "nome", 120), val(f, "descricao", 300), val(f, "preco", 40), val(f, "foto", 300)]);
          else if (p === "/admin/menu/apagar") await db(env, "delete from rs.menu where id=$1 and tenant_id=$2", [id, lic.id]);
          else if (p === "/admin/estado") { await db(env, "update rs.pedidos set estado=$1 where id=$2 and tenant_id=$3", [ESTADOS.includes(val(f, "estado")) ? val(f, "estado") : "Recebido", id, lic.id]); dest = "/admin"; }
          else if (p === "/admin/novidade") { await db(env, "insert into rs.novidades(tenant_id,tipo,titulo,texto) values($1,$2,$3,$4)", [lic.id, ["Novidade", "Curiosidade", "Promoção"].includes(val(f, "tipo")) ? val(f, "tipo") : "Novidade", val(f, "titulo", 120), val(f, "texto", 400)]); dest = "/admin?t=novidades"; }
          else if (p === "/admin/novidade/apagar") { await db(env, "delete from rs.novidades where id=$1 and tenant_id=$2", [id, lic.id]); dest = "/admin?t=novidades"; }
          else if (p === "/admin/campanha" && lic.plano === 2) dest = `/admin?t=marketing&env=${await campanha(env, await cfg(env, lic), lic.host, lic, f)}`;
          else if (p === "/admin/config") { await neon(env, { queries: Object.keys(D).map(k => ({ query: "insert into rs.settings(tenant_id,k,v) values($1,$2,$3) on conflict(tenant_id,k) do update set v=excluded.v", params: [lic.id, k, val(f, k, 400)] })) }); dest = "/admin?t=config"; }
          return go(dest);
        }
        
      if (p === "/" || p === "/admin") return painel(env, u, lic);
      return go("/");
    } catch (e) { console.error(e); return page("Erro", D.cor, `<main class='wrap'><h3>Erro temporário</h3><p>${E(e.message)}</p></main>`, 500); }
  },
};
