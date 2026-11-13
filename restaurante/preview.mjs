// Gera pré-visualizações estáticas do desenho (sem base de dados): node preview.mjs
import { siteHtml, acompanharHtml, avisoHtml } from "./src/tema.js";
import fs from "node:fs";
const c = { nome: "Cantinho do Mussulo", descricao: "Cozinha angolana feita com calma, perto do mar de Luanda.", whatsapp: "+244923000111", morada: "Ilha do Mussulo, Luanda", horario: "Terça a domingo, 11h às 23h", cor: "#c8a45c", logo: "", capa: "" };
const itens = [["Pratos", "Muamba de galinha", "Com quiabo, dendê e funge", "9 500 Kz"], ["Pratos", "Calulu de peixe", "Peixe seco, vegetais e azeite de palma", "11 000 Kz"], ["Bebidas", "Cuca gelada", "Cerveja angolana, 33 cl", "1 500 Kz"], ["Sobremesas", "Pudim de coco", "Receita da casa", "3 000 Kz"]].map(([categoria, nome, descricao, preco]) => ({ categoria, nome, descricao, preco, foto: "" }));
const nv = [{ tipo: "Curiosidade", titulo: "Sabia que…", texto: "O nosso molho leva três dias a apurar." }, { tipo: "Promoção", titulo: "Sexta de marisco", texto: "Segunda travessa a metade do preço." }];
fs.mkdirSync("preview", { recursive: true });
fs.writeFileSync("preview/site-plano2.html", siteHtml({ c, plano: 2, itens, nv, ok: false }));
fs.writeFileSync("preview/site-plano1.html", siteHtml({ c, plano: 1, itens, nv: [], ok: false }));
fs.writeFileSync("preview/acompanhar.html", acompanharHtml({ c, codigo: "A1B2C3", tipo: "Takeaway", itens: "2 × Muamba de galinha", estado: "Em preparação" }));
fs.writeFileSync("preview/aviso.html", avisoHtml("Serviço temporariamente indisponível", "Este site está suspenso. Contacte o responsável pelo restaurante.", c.cor));
