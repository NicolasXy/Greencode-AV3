#!/usr/bin/env node
/**
 * Testes da AV3 do greencode: camada analitica (BI), chaves de API, API publica
 * (/api/v1/public), fila assincrona com retry, agendamento (node-cron) e webhook.
 *
 * Usa um banco temporario (mesma regra do run-api.js). Requer PostgreSQL.
 * Codigo de saida 3 = pulado (PostgreSQL indisponivel).
 * Uso: node tests/run-av3.js   (apos npm run build)
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { Client } = require("pg");

const RAIZ = path.join(__dirname, "..");
const DIST = path.join(RAIZ, "dist", "server");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL || "postgresql://greencode:greencode@localhost:5432/postgres";
const NOME_BANCO = `greencode_av3_${crypto.randomBytes(4).toString("hex")}`;
const URL_BANCO = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${NOME_BANCO}`;
  return u.toString();
})();
const SEGREDO = "segredo-de-teste-com-mais-de-trinta-e-dois-caracteres!";
const DIA = 86_400_000;

let falhas = 0;
let passos = 0;
function afirmar(cond, msg) {
  passos++;
  if (cond) console.log(`  [PASS] ${msg}`);
  else {
    falhas++;
    console.log(`  [FAIL] ${msg}`);
  }
}
const titulo = (t) => console.log(`\n${t}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

function cnpjValido(base12) {
  const dv = (dig, pesos) => {
    const s = dig.split("").reduce((a, d, i) => a + Number(d) * pesos[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}

async function aplicarMigracoes(client) {
  const dir = path.join(RAIZ, "prisma", "migrations");
  const pastas = fs.readdirSync(dir).filter((p) => fs.statSync(path.join(dir, p)).isDirectory()).sort();
  for (const p of pastas) await client.query(fs.readFileSync(path.join(dir, p, "migration.sql"), "utf8"));
  return pastas.length;
}

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    console.log(`PULADO: PostgreSQL indisponivel (${e.message}). Defina TEST_DATABASE_ADMIN_URL.`);
    process.exit(3);
  }
  await admin.query(`CREATE DATABASE "${NOME_BANCO}"`);
  const sql = new Client({ connectionString: URL_BANCO });
  await sql.connect();

  const { criarPrisma } = require(path.join(DIST, "db", "prisma"));
  const { criarAppCompleto } = require(path.join(DIST, "app"));
  const { Worker } = require(path.join(DIST, "queue", "Worker"));
  const { agendarAnalises } = require(path.join(DIST, "queue", "agendador"));
  const { carregarConfiguracao } = require(path.join(DIST, "config"));
  const { VidaUtilService } = require(path.join(DIST, "analytics", "VidaUtilService"));
  const { estimarValor, montarGrupos } = require(path.join(DIST, "analytics", "RentabilidadeService"));
  const { relatorioParaCsv } = require(path.join(DIST, "services", "RelatorioService"));
  const { validarUrlWebhook } = require(path.join(DIST, "queue", "webhook"));

  let prisma, completo, app, recebedor;
  const config = {
    porta: 0, host: "127.0.0.1", databaseUrl: URL_BANCO, jwtSecret: SEGREDO, jwtExpiraEm: "30m",
    bcryptRounds: 4, corsOrigin: false, logLevel: "silent", encerramentoTimeoutMs: 3000,
    webhookRedePrivada: true, filaBackoffMs: 20, filaMaxTentativas: 3,
  };

  try {
    titulo("1) Migracao AV3 e preparacao");
    const n = await aplicarMigracoes(sql);
    afirmar(n >= 5, `${n} migracoes aplicadas em banco limpo (inclui a da AV3)`);
    const tabelas = (await sql.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map((r) => r.table_name);
    afirmar(["ChaveApi", "TarefaAssincrona", "AnaliseExecucao", "PrevisaoVidaUtil"].every((t) => tabelas.includes(t)), "novas tabelas existem (ChaveApi, TarefaAssincrona, AnaliseExecucao, PrevisaoVidaUtil)");
    prisma = criarPrisma(URL_BANCO);
    completo = await criarAppCompleto(config, prisma);
    app = completo.app;
    await app.ready();

    const req = async (method, url, token, body, prefixo = "/api/v1/internal") => {
      const r = await app.inject({ method, url: `${prefixo}${url}`, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
      let json = null;
      try { json = r.json(); } catch {}
      return { status: r.statusCode, body: json, headers: r.headers, texto: r.body };
    };
    const adm = (m, u, t, b) => req(m, u, t, b, "/api/v1/admin");
    const pub = async (method, url, chave, body) => {
      const r = await app.inject({ method, url: `/api/v1/public${url}`, payload: body, headers: chave ? { "x-api-key": chave } : {} });
      let json = null;
      try { json = r.json(); } catch {}
      return { status: r.statusCode, body: json, headers: r.headers, texto: r.body };
    };

    // Usuarios
    let r = await req("POST", "/auth/provisionar", null, { username: "admin", senha: "SenhaForte1" });
    const login = async (u) => (await req("POST", "/auth/login", null, { username: u, senha: "SenhaForte1" })).body.token;
    const tAdmin = await login("admin");
    for (const [u, p] of [["cad1", "cadastro"], ["alm1", "almoxarifado"], ["alm2", "almoxarifado"], ["aud1", "auditor"]]) await req("POST", "/usuarios", tAdmin, { username: u, senha: "SenhaForte1", papel: p });
    const tCad = await login("cad1"), tAlm = await login("alm1"), tAlm2 = await login("alm2"), tAud = await login("aud1");
    const ids = {};
    for (const row of (await sql.query(`SELECT id, username FROM "Usuario"`)).rows) ids[row.username] = row.id;

    // Organizacoes e contratos
    const cnpjA = cnpjValido("112223330001"), cnpjB = cnpjValido("114447770001");
    for (const [c, nome] of [[cnpjA, "Alfa Ltda"], [cnpjB, "Beta SA"]]) {
      await req("POST", "/organizacoes", tAdmin, { cnpj: c, razaoSocial: nome });
      await req("POST", "/contratos", tAdmin, { orgCnpj: c, dataInicio: new Date(Date.now() - 20 * DIA).toISOString().substring(0, 10), frequenciaColetaDias: 30 });
    }
    const orgId = {};
    for (const row of (await sql.query(`SELECT id, cnpj FROM "Organizacao"`)).rows) orgId[row.cnpj] = row.id;

    titulo("2) Rotas separadas: internal, admin, public (e compatibilidade com /api/v1)");
    afirmar((await req("GET", "/auth/me", tAdmin, null, "/api/v1/internal")).status === 200, "/api/v1/internal/auth/me responde");
    afirmar((await req("GET", "/auth/me", tAdmin, null, "/api/v1")).status === 200, "prefixo antigo /api/v1/auth/me continua funcionando (compatibilidade)");
    afirmar((await adm("GET", "/chaves-api", tAdmin)).status === 200, "/api/v1/admin/chaves-api responde ao admin");
    afirmar((await pub("GET", "/me", null)).status === 401, "/api/v1/public exige chave de API (JWT nao serve)");
    const docI = (await app.inject({ method: "GET", url: "/docs/json" })).json();
    const docP = (await app.inject({ method: "GET", url: "/docs/publico/json" })).json();
    afirmar(Object.keys(docI.paths).every((p) => /^\/api\/v1\/(internal|admin)\//.test(p)) && Object.keys(docI.paths).length > 40, "/docs lista so rotas internal e admin");
    afirmar(Object.keys(docP.paths).length === 8 && Object.keys(docP.paths).every((p) => p.startsWith("/api/v1/public/")), "/docs/publico lista so as 8 rotas publicas, versionadas na URL (v1)");
    afirmar(!!docP.components.securitySchemes.apiKey && /X-API-Key/.test(JSON.stringify(docP.components.securitySchemes)), "Swagger publico declara o esquema X-API-Key");
    const respostas = Object.values(docP.paths).flatMap((p) => Object.values(p)).flatMap((o) => Object.keys(o.responses ?? {}));
    afirmar(["400", "401", "403", "404", "409", "429"].every((c) => respostas.includes(c)), "Swagger publico documenta os codigos de erro 400/401/403/404/409/429");
    afirmar(JSON.stringify(docP).includes('"example"'), "Swagger publico traz exemplos de requisicao e resposta");
    const ui = await app.inject({ method: "GET", url: "/docs/publico/" });
    afirmar(ui.statusCode === 200 && /swagger/i.test(ui.body), "interface Swagger interativa em /docs/publico");

    titulo("3) Lote e equipamento: marca, modelo, valor recuperado e fim da triagem");
    r = await req("POST", "/lotes", tAdmin, { orgCnpj: cnpjA, nf: "NF-A1", transportadora: "TV", equipamentos: [{ tipo: "CPU", marca: "Dell", modelo: "OptiPlex" }, { tipo: "Monitor", marca: "  ", modelo: "" }] });
    afirmar(r.status === 201 && r.body.equipamentos[0].marca === "Dell" && r.body.equipamentos[1].marca === null, "marca/modelo gravados na criacao do lote (vazio vira null)");
    const loteA1 = r.body.lote, [eCpu, eMon] = r.body.equipamentos;
    r = await req("POST", "/equipamentos", tAdmin, { loteId: loteA1.id, tipo: "CPU", marca: "x".repeat(81) });
    afirmar(r.status === 400, "marca com mais de 80 caracteres rejeitada");
    r = await req("PATCH", `/equipamentos/${eCpu.id}/dados-comerciais`, tAlm, { valorRecuperacaoCentavos: 500 });
    afirmar(r.status === 400, "valor recuperado recusado enquanto o equipamento aguarda triagem");
    r = await req("POST", `/equipamentos/${eCpu.id}/triagem`, tAlm);
    r = await req("PATCH", `/equipamentos/${eCpu.id}`, tAlm, { tipo: "CPU" });
    let l = (await sql.query(`SELECT "triagemConcluidaEm" FROM "Lote" WHERE id=$1`, [loteA1.id])).rows[0];
    afirmar(l.triagemConcluidaEm === null, "lote ainda sem triagem concluida (so 1 de 2 equipamentos triados)");
    await req("POST", `/equipamentos/${eMon.id}/triagem`, tAlm2);
    l = (await sql.query(`SELECT "triagemConcluidaEm", "triagemConcluidaPorId" FROM "Lote" WHERE id=$1`, [loteA1.id])).rows[0];
    afirmar(l.triagemConcluidaEm !== null && l.triagemConcluidaPorId === ids.alm2, "lote registra quando e por quem a triagem foi concluida (quem fechou o ultimo equipamento)");
    r = await req("PATCH", `/equipamentos/${eCpu.id}/status`, tAlm, { status: "reciclagem" });
    r = await req("PATCH", `/equipamentos/${eCpu.id}/dados-comerciais`, tAlm, { valorRecuperacaoCentavos: 4500, modelo: "OptiPlex 3080" });
    afirmar(r.status === 200 && r.body.valorRecuperacaoCentavos === 4500 && r.body.modelo === "OptiPlex 3080", "valor recuperado registrado com o equipamento em destino");
    afirmar((await req("PATCH", `/equipamentos/${eCpu.id}/dados-comerciais`, tAlm, { valorRecuperacaoCentavos: -1 })).status === 400, "valor negativo rejeitado");
    afirmar((await req("PATCH", `/equipamentos/${eCpu.id}/dados-comerciais`, tCad, { marca: "x" })).status === 403, "cadastro nao altera dados comerciais (403)");
    const ck = await sql.query(`UPDATE "Equipamento" SET "valorRecuperacaoCentavos" = -5 WHERE id=$1`, [eCpu.id]).then(() => null, (e) => e.message);
    afirmar(ck && /check/i.test(ck), "CHECK do banco impede valor recuperado negativo");

    // ---------------- Massa historica determinista (SQL) ----------------
    // Lotes concluidos em meses diferentes por 2 operadores, e equipamentos "cpu" que depreciam 0,01 nota/dia.
    const agora = Date.now();
    const ts = (diasAtras) => new Date(agora - diasAtras * DIA).toISOString();
    let nfSeq = 100;
    const novoLote = async (org, entradaDiasAtras, horasAteTriagem, operador) => {
      const entrada = new Date(agora - entradaDiasAtras * DIA);
      entrada.setUTCHours(0, 0, 0, 0);
      const fim = new Date(entrada.getTime() + horasAteTriagem * 3_600_000);
      const id = crypto.randomUUID();
      await sql.query(`INSERT INTO "Lote"(id,"organizacaoId",nf,transportadora,"dataEntrada",status,"criadoPorId","triagemConcluidaEm","triagemConcluidaPorId") VALUES ($1,$2,$3,'TV',$4,'triagem_completa',$5,$6,$7)`, [id, orgId[org], `NF-H${nfSeq++}`, entrada.toISOString().substring(0, 10), ids.admin, fim, ids[operador]]);
      return id;
    };
    let pos = {};
    const novoEquip = async (loteId, tipo, estado, status, criadoDiasAtras, extra = {}) => {
      const id = crypto.randomUUID();
      pos[loteId] = (pos[loteId] ?? 0) + 1;
      await sql.query(`INSERT INTO "Equipamento"(id,"loteId","codigoBarrasInterno",posicao,tipo,"estadoFisico",status,"triagemCompleta",marca,modelo,"valorRecuperacaoCentavos","criadoEm") VALUES ($1,$2,$11,$3,$4,$5,$6,true,$7,$8,$9,$10)`,
        [id, loteId, pos[loteId], tipo, estado, status, extra.marca ?? null, extra.modelo ?? null, extra.valor ?? null, ts(criadoDiasAtras), id]);
      return id;
    };
    const mov = (eq, usuario, d) => sql.query(`INSERT INTO "Movimentacao"(id,"equipamentoId","usuarioId","statusDe","statusPara","estadoDe","estadoPara","criadoEm") VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
      [eq, ids[usuario], d.sDe ?? null, d.sPara ?? null, d.eDe ?? null, d.ePara ?? null, ts(d.diasAtras)]);

    // Eficiencia: op alm1 (24h e 48h) e alm2 (96h e 120h), em meses diferentes.
    await novoLote("11222333000181" === "x" ? cnpjA : cnpjA, 70, 24, "alm1");
    await novoLote(cnpjA, 40, 48, "alm1");
    await novoLote(cnpjB, 35, 96, "alm2");
    await novoLote(cnpjB, 5, 120, "alm2");
    // Etapas: em_triagem -> triado demora (gargalo); aguardando -> em_triagem e rapido.
    const lE = await novoLote(cnpjA, 30, 10, "alm1");
    for (let i = 0; i < 3; i++) {
      const e = await novoEquip(lE, "terminal", "novo", "triado", 10);
      await mov(e, "alm1", { sDe: "aguardando_triagem", sPara: "em_triagem", diasAtras: 10 - 0.05 }); // ~1,2h depois da criacao
      await mov(e, "alm1", { sDe: "em_triagem", sPara: "triado", diasAtras: 8 }); // ~46h depois
    }

    // Rentabilidade
    const lR = await novoLote(cnpjA, 20, 5, "alm1");
    await novoEquip(lR, "notebook", "regular", "reciclagem", 50, { marca: "Dell", modelo: "L1", valor: 4000 });
    await novoEquip(lR, "notebook", "regular", "reciclagem", 50, { marca: "Dell", modelo: "L1", valor: 6000 });
    await novoEquip(lR, "notebook", "ruim", "reciclagem", 50, { marca: "HP", modelo: "P1", valor: 1000 });
    await novoEquip(lR, "tablet", "bom", "revenda", 50, { marca: "Acme", modelo: "T", valor: 2000 });

    // Vida util: 8 equipamentos "sensor" (tipo proprio, sem interferir nos demais) com nota = 5 - 0,01 * idade.
    const lV = await novoLote(cnpjA, 25, 5, "alm1");
    const passosEstado = [["novo", 0], ["seminovo", 100], ["bom", 200], ["regular", 300], ["ruim", 400]];
    for (let i = 0; i < 8; i++) {
      const idade = 500 + i;
      const e = await novoEquip(lV, "sensor", "ruim", "reciclagem", idade);
      for (let k = 1; k < passosEstado.length; k++) await mov(e, "alm1", { eDe: passosEstado[k - 1][0], ePara: passosEstado[k][0], diasAtras: idade - passosEstado[k][1] });
    }
    // Em uso (ativos) do mesmo tipo: dois sensores com 150 dias.
    const lAtivo = await novoLote(cnpjA, 12, 5, "alm1");
    const ativo1 = await novoEquip(lAtivo, "sensor", "seminovo", "triado", 150);
    await novoEquip(lAtivo, "sensor", "seminovo", "triado", 150);
    await mov(ativo1, "alm1", { eDe: "novo", ePara: "seminovo", diasAtras: 50 });

    titulo("4) Analise de eficiencia operacional");
    r = await adm("POST", "/analises/eficiencia/executar", tAdmin, {});
    const ef = r.body && r.body.resultado;
    afirmar(r.status === 201 && ef && ef.resumo.lotes >= 5, `executa por endpoint e devolve o relatorio (lotes analisados: ${ef && ef.resumo.lotes})`);
    const op = (u) => ef.porOperador.find((o) => o.username === u);
    afirmar(op("alm1") && op("alm2") && op("alm2").tempoMedioHoras > op("alm1").tempoMedioHoras, "compara operadores: alm2 (96h e 120h) mais lento que alm1");
    // alm2 tem 3 lotes: 96h, 120h e o lote real da secao 3 (concluido pela API, horas desde a data de entrada).
    const hReal = (await sql.query(`SELECT extract(epoch FROM ("triagemConcluidaEm" - "dataEntrada"))/3600 AS h FROM "Lote" WHERE id=$1`, [loteA1.id])).rows[0].h;
    afirmar(op("alm2").lotes === 3 && perto(op("alm2").tempoMedioHoras, (216 + Number(hReal)) / 3, 0.02), `tempo medio do operador alm2 = (96 + 120 + ${Number(hReal).toFixed(2)})/3 (${op("alm2").tempoMedioHoras})`);
    afirmar(ef.operadorMaisLento === "alm2", "aponta o operador mais lento");
    afirmar(ef.porPeriodo.length >= 2 && ef.porPeriodo.every((p) => /^\d{4}-\d{2}$/.test(p.periodo)), `agrupa por periodo (mes): ${ef.porPeriodo.map((p) => p.periodo).join(", ")}`);
    afirmar(ef.porMesDoAno.length >= 2 && ef.porMesDoAno.every((m) => m.mes >= 1 && m.mes <= 12) && ef.porMesDoAno.reduce((a, m) => a + m.lotes, 0) === ef.resumo.lotes, `sazonalidade por mes do ano (1-12): ${ef.porMesDoAno.length} meses`);
    afirmar(ef.gargalo && ef.gargalo.transicao === "em_triagem->triado" && ef.gargalo.tempoMedioHoras > 40, `identifica o gargalo: ${ef.gargalo && ef.gargalo.transicao} (${ef.gargalo && ef.gargalo.tempoMedioHoras}h)`);
    const execEf = (await sql.query(`SELECT tipo, origem, amostra FROM "AnaliseExecucao" WHERE id=$1`, [r.body.id])).rows[0];
    afirmar(execEf && execEf.tipo === "eficiencia_operacional" && execEf.origem === "manual", "resultado gravado na tabela AnaliseExecucao (origem manual)");

    titulo("5) Analise de rentabilidade por tipo de equipamento");
    r = await adm("POST", "/analises/rentabilidade/executar", tAdmin);
    const rent = r.body.resultado;
    const nb = rent.porTipo.find((t) => t.tipo === "notebook");
    afirmar(nb && nb.mediaCentavos === 3667 && nb.amostra === 3, `media do tipo notebook = 3667 centavos (${nb && nb.mediaCentavos})`);
    afirmar(rent.porTipo[0].ranking === 1 && rent.porTipo[0].mediaCentavos >= rent.porTipo[1].mediaCentavos, "ranking ordenado por retorno medio");
    const g = rent.porGrupo.find((x) => x.tipo === "notebook" && x.marca === "dell" && x.estadoFisico === "regular");
    afirmar(g && g.mediaCentavos === 5000 && g.modelo === "l1", "media por tipo + estado fisico + marca + modelo (notebook/regular/dell/l1 = 5000)");
    const grupos = montarGrupos([
      { tipo: "notebook", estadoFisico: "regular", marca: "Dell", modelo: "L1", valorRecuperacaoCentavos: 4000 },
      { tipo: "notebook", estadoFisico: "regular", marca: "Dell", modelo: "L1", valorRecuperacaoCentavos: 6000 },
      { tipo: "notebook", estadoFisico: "ruim", marca: "HP", modelo: "P1", valorRecuperacaoCentavos: 1000 },
    ]);
    afirmar(estimarValor({ tipo: "notebook", estadoFisico: "regular", marca: "Dell", modelo: "L1" }, grupos).fonte === "modelo", "estimativa usa o modelo quando ha historico dele");
    afirmar(estimarValor({ tipo: "notebook", estadoFisico: "regular", marca: "Dell", modelo: "L9" }, grupos).fonte === "marca", "sem o modelo, cai para a marca");
    afirmar(estimarValor({ tipo: "notebook", estadoFisico: "regular", marca: "Lenovo", modelo: "X" }, grupos).fonte === "tipo_estado", "sem a marca, cai para tipo + estado");
    afirmar(estimarValor({ tipo: "notebook", estadoFisico: "novo", marca: "Lenovo" }, grupos).fonte === "tipo", "sem o estado, cai para o tipo");
    afirmar(estimarValor({ tipo: "impressora", estadoFisico: "novo" }, grupos) === null, "tipo sem nenhum historico nao recebe valor inventado");

    titulo("6) Vida util remanescente (regressao linear) e historico de previsoes");
    r = await adm("POST", "/analises/vida-util/executar", tAdmin);
    const vu = r.body.resultado;
    const sensor = vu.modelos.find((m) => m.tipo === "sensor");
    afirmar(!!sensor && sensor.inclinacao < 0, `modelo do tipo 'sensor' tem inclinacao negativa (${sensor && sensor.inclinacao})`);
    afirmar(sensor.r2 > 0.9, `ajuste da reta com R2 alto (${sensor.r2})`);
    afirmar(sensor.vidaTotalBrutaDias > 430 && sensor.vidaTotalBrutaDias < 520, `vida total prevista ~ 450 dias (${sensor.vidaTotalBrutaDias})`);
    afirmar(sensor.equipamentosAtivos === 2 && perto(sensor.vidaRestanteMediaDias, sensor.vidaTotalPrevistaDias - 150, 1), `vida restante media dos 2 sensores ativos = vida total - 150 (${sensor.vidaRestanteMediaDias})`);
    afirmar(vu.semModelo.some((s) => s.tipo === "terminal") || vu.modelos.every((m) => m.tipo !== "terminal"), "tipos sem dados suficientes nao ganham modelo (sao listados em semModelo)");
    afirmar(Date.parse(sensor.dataPrevistaInservivel) > Date.now() && sensor.falhas.observadas === 0, "data prevista no futuro; sem falhas (sucata) observadas ainda");
    const prev0 = (await sql.query(`SELECT * FROM "PrevisaoVidaUtil" WHERE "tipoEquipamento"='sensor'`)).rows;
    afirmar(prev0.length === 1 && prev0[0].avaliadaEm === null && prev0[0].ajusteDias === 0, "previsao gravada em PrevisaoVidaUtil, ainda nao avaliada, sem ajuste");
    // Funcao pura: sem pontos suficientes ou sem depreciacao.
    const eq = (tipo, estado, idade, movs = []) => ({ id: crypto.randomUUID(), tipo, estadoFisico: estado, status: "triado", criadoEm: new Date(Date.now() - idade * DIA), movimentacoes: movs });
    const plano = VidaUtilService.calcular([eq("a", "novo", 10), eq("a", "novo", 20), eq("a", "novo", 30), eq("a", "novo", 40)], new Date(), new Map());
    afirmar(plano.modelos.length === 0 && /sem depreciacao/.test(plano.semModelo[0].motivo), "estado sempre 'novo' => sem depreciacao detectavel (sem modelo)");
    const poucos = VidaUtilService.calcular([eq("b", "bom", 10)], new Date(), new Map());
    afirmar(poucos.modelos.length === 0 && /insuficientes/.test(poucos.semModelo[0].motivo), "poucos dados => sem modelo");

    titulo("7) Historico, comparacao previsao x realidade e refino do modelo");
    r = await adm("GET", "/analises/relatorios?tipo=vida-util", tAud);
    afirmar(r.status === 200 && r.body.total === 1 && !r.body.itens[0].resultado, "historico lista relatorios (sem o corpo pesado) e o auditor pode ler");
    r = await adm("GET", `/analises/relatorios/${r.body.itens[0].id}`, tAud);
    afirmar(r.status === 200 && r.body.resultado.modelos.length >= 1, "relatorio anterior recuperavel por id (consulta historica)");
    afirmar((await adm("GET", "/analises/eficiencia/ultimo", tAud)).status === 200, "ultimo relatorio do tipo disponivel");
    afirmar((await adm("GET", "/analises/relatorios/00000000-0000-4000-8000-000000000000", tAud)).status === 404, "relatorio inexistente => 404");
    // Realidade: depois da previsao, um sensor vira sucata com 380 dias de vida.
    await new Promise((res) => setTimeout(res, 20));
    const lF = await novoLote(cnpjA, 3, 5, "alm1");
    const falho = await novoEquip(lF, "sensor", "sucata", "descarte_seguro", 380);
    await mov(falho, "alm1", { eDe: "ruim", ePara: "sucata", diasAtras: -0.01 }); // logo depois da previsao
    r = await adm("POST", "/analises/previsoes/avaliar", tAdmin);
    afirmar(r.status === 200 && r.body.avaliadas >= 1, `previsao pendente comparada com a realidade (${r.body.avaliadas} avaliada)`);
    const prev1 = (await sql.query(`SELECT * FROM "PrevisaoVidaUtil" WHERE "tipoEquipamento"='sensor' ORDER BY "geradaEm" LIMIT 1`)).rows[0];
    afirmar(prev1.avaliadaEm && perto(prev1.vidaTotalRealDias, 380, 0.1) && perto(prev1.erroDias, 380 - prev1.vidaTotalPrevistaDias, 0.02), `grava vida real (${prev1.vidaTotalRealDias}) e erro (${prev1.erroDias} dias)`);
    r = await adm("GET", "/analises/previsoes/acuracia", tAud);
    const ac = r.body.porTipo.find((x) => x.tipo === "sensor");
    afirmar(ac && ac.previsoesAvaliadas === 1 && perto(ac.erroAbsolutoMedioDias, Math.abs(prev1.erroDias), 0.02), "acuracia por tipo (erro absoluto medio) calculada");
    afirmar((await adm("GET", "/analises/previsoes?avaliadas=true", tAud)).body.total === 1, "previsoes avaliadas listaveis");
    r = await adm("POST", "/analises/vida-util/executar", tAdmin);
    const prev2 = (await sql.query(`SELECT * FROM "PrevisaoVidaUtil" WHERE "tipoEquipamento"='sensor' ORDER BY "geradaEm" DESC LIMIT 1`)).rows[0];
    afirmar(perto(prev2.ajusteDias, prev1.vidaTotalRealDias - prev1.vidaTotalBrutaDias, 0.05), `nova previsao aplica o ajuste aprendido (${prev2.ajusteDias} dias = real - bruta da anterior)`);
    afirmar(perto(prev2.vidaTotalPrevistaDias, Math.max(0, prev2.vidaTotalBrutaDias + prev2.ajusteDias), 0.05), "vida prevista = bruta + ajuste de calibracao");
    afirmar((await adm("POST", "/analises/vida-util/executar", tCad)).status === 403 && (await adm("POST", "/analises/vida-util/executar", tAud)).status === 403, "so o admin executa analises (cadastro e auditor => 403)");
    afirmar((await adm("POST", "/analises/vida-util/executar", tAdmin, { desde: "ontem" })).status === 400, "parametro 'desde' invalido => 400");

    titulo("8) Chaves de API: emissao, escopos e armazenamento seguro");
    const criarChave = (b) => adm("POST", "/chaves-api", tAdmin, b);
    r = await criarChave({ nome: "Cooperativa Verde", orgCnpj: cnpjA, escopos: ["rastreabilidade:ler", "lotes:escrever", "relatorios:gerar"], limitePorMinuto: 100 });
    afirmar(r.status === 201 && /^gck_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/.test(r.body.chave) && r.body.segredoWebhook.length === 64, "chave emitida no formato gck_<prefixo>_<segredo>, com segredo de webhook");
    const kA = r.body, chaveA = r.body.chave;
    const linhaK = (await sql.query(`SELECT * FROM "ChaveApi" WHERE id=$1`, [kA.id])).rows[0];
    afirmar(!JSON.stringify(linhaK).includes(chaveA.split("_")[2]) && linhaK.hashSegredo === crypto.createHash("sha256").update(chaveA).digest("hex"), "banco guarda so o SHA-256: o segredo da chave nao e armazenado");
    r = await adm("GET", "/chaves-api", tAud);
    afirmar(r.status === 200 && !JSON.stringify(r.body).includes(chaveA) && !JSON.stringify(r.body).includes("hashSegredo") && !JSON.stringify(r.body).includes("segredoWebhook"), "listagem nunca expoe chave, hash nem segredo de webhook");
    r = await criarChave({ nome: "Outra do mesmo parceiro", orgCnpj: cnpjA, escopos: ["lotes:ler"] });
    afirmar(r.status === 201 && r.body.chave !== chaveA && r.body.prefixo !== kA.prefixo, "cada chave e unica");
    afirmar((await criarChave({ nome: "x", orgCnpj: cnpjA, escopos: ["tudo"] })).status === 400, "escopo desconhecido rejeitado");
    afirmar((await criarChave({ nome: "x", orgCnpj: cnpjA, escopos: [] })).status === 400, "escopos vazios rejeitados");
    afirmar((await criarChave({ nome: "x", orgCnpj: cnpjValido("999888770001"), escopos: ["lotes:ler"] })).status === 404, "organizacao inexistente => 404");
    afirmar((await criarChave({ nome: "x", orgCnpj: cnpjA, escopos: ["lotes:ler"], limitePorMinuto: 0 })).status === 400, "limite invalido rejeitado");
    afirmar((await adm("POST", "/chaves-api", tCad, { nome: "x", orgCnpj: cnpjA, escopos: ["lotes:ler"] })).status === 403, "so admin emite chaves (cadastro => 403)");
    const ck2 = await sql.query(`UPDATE "ChaveApi" SET escopos = ARRAY['root'] WHERE id=$1`, [kA.id]).then(() => null, (e) => e.message);
    afirmar(ck2 && /check/i.test(ck2), "CHECK do banco impede escopo desconhecido");

    titulo("9) API publica: autenticacao, escopos e isolamento por organizacao");
    afirmar((await pub("GET", "/me", "gck_00000000_naoexiste")).status === 401, "chave inexistente => 401");
    afirmar((await pub("GET", "/me", "lixo")).status === 401, "chave malformada => 401");
    afirmar((await pub("GET", "/me", chaveA.slice(0, -1) + (chaveA.endsWith("A") ? "B" : "A"))).status === 401, "segredo errado => 401");
    r = await pub("GET", "/me", chaveA);
    afirmar(r.status === 200 && r.body.organizacaoCnpj === cnpjA && r.body.limitePorMinuto === 100, "chave valida identifica o parceiro");
    // chave somente leitura de rastreabilidade
    const rK = await criarChave({ nome: "Auditoria externa", orgCnpj: cnpjA, escopos: ["rastreabilidade:ler"] });

    const kRastro = rK.body;
    const kLer = (await criarChave({ nome: "Leitor de lotes", orgCnpj: cnpjA, escopos: ["lotes:ler"] })).body;
    const kB = (await criarChave({ nome: "Parceiro B", orgCnpj: cnpjB, escopos: ["rastreabilidade:ler", "lotes:escrever", "relatorios:gerar"] })).body;
    r = await pub("GET", `/rastreabilidade/equipamentos/${eCpu.id}`, kRastro.chave);
    if (r.status !== 200) console.log("   debug:", r.status, r.texto.slice(0, 200));
    afirmar(r.status === 200 && r.body.equipamento.id === eCpu.id && r.body.movimentacoes.length >= 2 && !JSON.stringify(r.body).includes("usuarioId") && !("versao" in r.body.equipamento), "rastreabilidade do equipamento: historico completo, sem campos internos");
    r = await pub("GET", `/rastreabilidade/lotes/${loteA1.id}`, kRastro.chave);
    if (r.status !== 200) console.log("   debug:", r.status, r.texto.slice(0, 200));
    afirmar(r.status === 200 && r.body.equipamentos.length === 2 && ["triagem_completa", "encerrado"].includes(r.body.status), "rastreabilidade do lote com seus equipamentos e status derivado");
    afirmar((await pub("GET", "/lotes", kRastro.chave)).status === 403, "chave so de rastreabilidade nao le lotes (403)");
    afirmar((await pub("POST", "/lotes", kLer.chave, { nf: "NF-X", transportadora: "T" })).status === 403, "chave 'lotes:ler' nao cria lote (403): somente leitura");
    afirmar((await pub("GET", "/lotes", kLer.chave)).status === 200, "chave 'lotes:ler' lista lotes");
    afirmar((await pub("POST", "/relatorios/preditivo", kLer.chave, {})).status === 403, "sem 'relatorios:gerar' nao pede relatorio (403)");
    r = await pub("GET", "/lotes?tamanhoPagina=100", kLer.chave);
    afirmar(r.body.itens.every((x) => x.organizacao.cnpj === cnpjA) && r.body.total >= 6, `lista so os lotes da propria organizacao (${r.body.total})`);
    const loteB = (await sql.query(`SELECT l.id, e.id AS eid FROM "Lote" l JOIN "Equipamento" e ON e."loteId"=l.id WHERE l."organizacaoId"=$1 LIMIT 1`, [orgId[cnpjB]])).rows[0];
    const loteBsemEq = (await sql.query(`SELECT id FROM "Lote" WHERE "organizacaoId"=$1 LIMIT 1`, [orgId[cnpjB]])).rows[0];
    afirmar((await pub("GET", `/lotes/${loteBsemEq.id}`, kLer.chave)).status === 404, "lote de outra organizacao => 404 (nao revela que existe)");
    afirmar((await pub("GET", `/rastreabilidade/lotes/${loteBsemEq.id}`, kRastro.chave)).status === 404, "rastreio de lote alheio => 404");
    if (loteB) afirmar((await pub("GET", `/rastreabilidade/equipamentos/${loteB.eid}`, kRastro.chave)).status === 404, "rastreio de equipamento alheio => 404");
    afirmar((await pub("GET", "/lotes/nao-e-uuid", kLer.chave)).status === 400, "id invalido => 400");

    titulo("10) API publica: escrita de lotes");
    r = await pub("POST", "/lotes", chaveA, { nf: "NF-API-1", transportadora: "TransVerde", equipamentos: [{ tipo: "CPU", marca: "Dell", modelo: "OptiPlex" }, { tipo: "Monitor" }] });
    afirmar(r.status === 201 && r.body.organizacao.cnpj === cnpjA && r.body.equipamentos.length === 2 && r.body.status === "recebido", "cria lote com equipamentos na organizacao da chave");
    const loteApi = r.body;
    afirmar((await pub("POST", "/lotes", chaveA, { nf: "NF-API-1", transportadora: "T" })).status === 409, "NF duplicada => 409");
    r = await pub("POST", "/lotes", chaveA, { nf: "NF-API-2", transportadora: "T", orgCnpj: cnpjB });
    afirmar(r.status === 201 && r.body.organizacao.cnpj === cnpjA, "orgCnpj enviado no corpo e ignorado: a organizacao vem sempre da chave");
    afirmar((await pub("POST", "/lotes", chaveA, { nf: "", transportadora: "T" })).status === 400, "NF vazia => 400");
    afirmar((await pub("POST", "/lotes", chaveA, { nf: "NF-API-3", transportadora: "T", dataEntrada: "2999-01-01" })).status === 400, "data de entrada futura => 400 (mesmas regras do sistema)");
    const aud = (await sql.query(`SELECT detalhes FROM "Auditoria" WHERE acao='API_LOTE_CRIADO'`)).rows;
    afirmar(aud.some((a) => a.detalhes.chaveApiId === kA.id && a.detalhes.loteId === loteApi.id), "criacao via API registrada na auditoria com a chave usada");
    afirmar((await pub("GET", `/lotes/${loteApi.id}`, kLer.chave)).body.equipamentos.length === 2, "lote criado pela API visivel por outra chave da mesma organizacao");

    titulo("11) Limite de requisicoes por chave (rate limit)");
    const kLim = (await criarChave({ nome: "Limitada", orgCnpj: cnpjA, escopos: ["lotes:ler"], limitePorMinuto: 3 })).body;
    const sts = [];
    let ultima;
    for (let i = 0; i < 5; i++) {
      ultima = await pub("GET", "/me", kLim.chave);
      sts.push(ultima.status);
    }
    afirmar(sts.join() === "200,200,200,429,429", `chave com limite 3/min: ${sts.join()}`);
    afirmar(ultima.body.erro === "LimiteExcedido" && ultima.headers["retry-after"] !== undefined && ultima.headers["x-ratelimit-limit"] === "3", "429 com corpo padronizado e cabecalhos Retry-After / X-RateLimit-Limit");
    afirmar((await pub("GET", "/me", kRastro.chave)).status === 200, "o limite e por chave: outra chave nao e afetada");
    r = await adm("PATCH", `/chaves-api/${kLim.id}`, tAdmin, { limitePorMinuto: 1000 });
    afirmar(r.status === 200 && r.body.limitePorMinuto === 1000, "admin altera o limite da chave");

    titulo("12) Revogacao, expiracao e inativacao");
    const kTmp = (await criarChave({ nome: "Temporaria", orgCnpj: cnpjA, escopos: ["lotes:ler"] })).body;
    afirmar((await pub("GET", "/me", kTmp.chave)).status === 200, "chave nova funciona");
    r = await adm("POST", `/chaves-api/${kTmp.id}/revogar`, tAdmin);
    afirmar(r.status === 200 && r.body.ativa === false && r.body.revogadaEm, "revogacao marca a chave como inativa");
    afirmar((await pub("GET", "/me", kTmp.chave)).status === 401, "chave revogada => 401 imediato");
    afirmar((await adm("POST", `/chaves-api/${kTmp.id}/revogar`, tAdmin)).status === 409, "revogar duas vezes => 409");
    afirmar((await adm("PATCH", `/chaves-api/${kTmp.id}`, tAdmin, { nome: "novo" })).status === 409, "chave revogada nao pode ser alterada");
    const kExp = (await criarChave({ nome: "Expira", orgCnpj: cnpjA, escopos: ["lotes:ler"], expiraEm: new Date(Date.now() + 3600_000).toISOString() })).body;
    await sql.query(`UPDATE "ChaveApi" SET "expiraEm" = now() - interval '1 minute' WHERE id=$1`, [kExp.id]);
    afirmar((await pub("GET", "/me", kExp.chave)).status === 401, "chave expirada => 401");
    afirmar((await criarChave({ nome: "x", orgCnpj: cnpjA, escopos: ["lotes:ler"], expiraEm: "2020-01-01T00:00:00Z" })).status === 400, "expiracao no passado rejeitada na criacao");
    afirmar((await sql.query(`SELECT "ultimoUsoEm" FROM "ChaveApi" WHERE id=$1`, [kA.id])).rows[0].ultimoUsoEm !== null, "ultimo uso da chave e registrado");

    titulo("13) Relatorio preditivo assincrono: fila, status, download e webhook");
    // Receptor de webhook local.
    const hooks = [];
    recebedor = http.createServer((q, s) => {
      let corpo = "";
      q.on("data", (c) => (corpo += c));
      q.on("end", () => { hooks.push({ corpo, assinatura: q.headers["x-greencode-signature"] }); s.statusCode = 204; s.end(); });
    });
    await new Promise((res) => recebedor.listen(0, "127.0.0.1", res));
    const urlHook = `http://127.0.0.1:${recebedor.address().port}/hook`;
    // Equipamento com marca maliciosa (CSV injection)
    await req("POST", "/equipamentos", tAdmin, { loteId: loteApi.id, tipo: "CPU", marca: "=HYPERLINK(\"http://x\")", modelo: "a,b\"c" });
    const t0 = Date.now();
    r = await pub("POST", "/relatorios/preditivo", chaveA, { webhookUrl: urlHook });
    const tempoResposta = Date.now() - t0;
    afirmar(r.status === 202 && /^[0-9a-f-]{36}$/.test(r.body.tarefaId) && r.body.status === "pendente" && r.headers.location === `/api/v1/public/tarefas/${r.body.tarefaId}`, `202 imediato (${tempoResposta}ms) com identificador unico da tarefa e Location`);
    const tarefaId = r.body.tarefaId;
    afirmar((await pub("GET", `/tarefas/${tarefaId}`, chaveA)).body.status === "pendente", "status consultavel por polling: pendente");
    r = await pub("GET", `/tarefas/${tarefaId}/resultado`, chaveA);
    afirmar(r.status === 409 && /nao esta pronto/.test(r.body.mensagem), "resultado antes da conclusao => 409");
    afirmar((await pub("GET", `/tarefas/${tarefaId}`, kB.chave)).status === 404, "tarefa de outra organizacao => 404");
    const processou = await completo.worker.processarProxima();
    afirmar(processou === true, "worker processa a tarefa em segundo plano");
    r = await pub("GET", `/tarefas/${tarefaId}`, chaveA);
    afirmar(r.body.status === "concluida" && r.body.tentativas === 1 && r.body.concluidoEm && r.body.resultadoUrl, "status vira 'concluida' e informa a URL do resultado");
    r = await pub("GET", `/tarefas/${tarefaId}/resultado`, chaveA);
    const rel = r.body;
    afirmar(r.status === 200 && rel.organizacaoId === orgId[cnpjA] && rel.equipamentos.length >= 5 && rel.resumo.equipamentos === rel.equipamentos.length, `relatorio JSON com ${rel.equipamentos.length} equipamentos da organizacao`);
    const doLote = new Set((await sql.query(`SELECT e.id FROM "Equipamento" e JOIN "Lote" l ON l.id=e."loteId" WHERE l."organizacaoId"=$1`, [orgId[cnpjA]])).rows.map((x) => x.id));
    afirmar(rel.equipamentos.every((e) => doLote.has(e.equipamentoId)), "relatorio so contem equipamentos da propria organizacao");
    const sens = rel.equipamentos.find((e) => e.equipamentoId === ativo1);
    afirmar(sens && sens.vidaRestanteDias > 0 && sens.dataPrevistaInservivel, `linha do equipamento traz vida restante prevista (${sens && sens.vidaRestanteDias} dias)`);
    const cpuRel = rel.equipamentos.find((e) => e.equipamentoId === eCpu.id);
    afirmar(cpuRel.valorRecuperadoCentavos === 4500 && cpuRel.valorEstimadoCentavos === null, "valor registrado aparece como recuperado (sem estimativa)");
    const monRel = rel.equipamentos.find((e) => e.equipamentoId === eMon.id);
    afirmar(monRel.valorRecuperadoCentavos === null && (monRel.valorEstimadoCentavos === null || monRel.fonteValorEstimado), "sem valor registrado: estimativa so com historico do tipo");
    r = await pub("GET", `/tarefas/${tarefaId}/resultado?formato=csv`, chaveA);
    const linhas = r.texto.split("\r\n");
    afirmar(r.status === 200 && /text\/csv/.test(r.headers["content-type"]) && /attachment/.test(r.headers["content-disposition"]) && linhas[0].startsWith("equipamentoId,codigoBarras,loteId,tipo") && linhas.length === rel.equipamentos.length + 2, "download em CSV (cabecalho + 1 linha por equipamento, CRLF)");
    afirmar(r.texto.includes(`'=HYPERLINK(""http://x"")`) || r.texto.includes(`"'=HYPERLINK(""http://x"")"`), "CSV neutraliza formulas (CSV injection) e escapa aspas");
    const csvDireto = relatorioParaCsv({ equipamentos: [{ equipamentoId: "1", marca: "+cmd", modelo: 'a,b"c' }] });
    afirmar(csvDireto.includes("'+cmd") && csvDireto.includes('"a,b""c"'), "relatorioParaCsv: apostrofo em formulas e RFC 4180 para virgula/aspas");
    await dormir(100);
    const taref = (await sql.query(`SELECT "webhookStatus" FROM "TarefaAssincrona" WHERE id=$1`, [tarefaId])).rows[0];
    afirmar(hooks.length === 1 && taref.webhookStatus === "entregue", "webhook entregue ao concluir");
    const hook = hooks[0];
    const esperado = "sha256=" + crypto.createHmac("sha256", kA.segredoWebhook).update(hook.corpo).digest("hex");
    afirmar(hook.assinatura === esperado, "webhook assinado com HMAC-SHA256 usando o segredo da chave");
    afirmar(JSON.parse(hook.corpo).tarefaId === tarefaId && JSON.parse(hook.corpo).evento === "relatorio.concluido", "corpo do webhook identifica a tarefa e o evento");

    // limite de relatorios em aberto
    const abertos = [];
    for (let i = 0; i < 5; i++) abertos.push((await pub("POST", "/relatorios/preditivo", kB.chave, {})).status);
    afirmar(abertos.every((s) => s === 202), "ate 5 relatorios em aberto por organizacao");
    afirmar((await pub("POST", "/relatorios/preditivo", kB.chave, {})).status === 409, "6o relatorio em aberto => 409 (protege a fila)");
    await completo.worker.esvaziarFila();
    afirmar((await pub("POST", "/relatorios/preditivo", kB.chave, {})).status === 202, "apos concluir, volta a aceitar");
    await completo.worker.esvaziarFila();

    // SSRF
    const app2 = (await criarAppCompleto({ ...config, webhookRedePrivada: false }, prisma)).app;
    await app2.ready();
    for (const u of ["http://127.0.0.1:9/x", "http://localhost/x", "http://10.0.0.5/x", "http://169.254.169.254/latest", "http://[::1]/x", "ftp://x.example/a", "http://u:p@x.example/"]) {
      const rr = await app2.inject({ method: "POST", url: "/api/v1/public/relatorios/preditivo", headers: { "x-api-key": kB.chave }, payload: { webhookUrl: u } });
      afirmar(rr.statusCode === 400, `webhook recusa destino inseguro ${u}`);
    }
    let ok = false;
    try { validarUrlWebhook("https://parceiro.example/h", false); ok = true; } catch {}
    afirmar(ok, "webhook https publico e aceito");
    await app2.close();

    titulo("14) Fila: retry com backoff, falha definitiva, lease e concorrencia");
    const log = { info() {}, error() {} };
    const opW = { intervaloMs: 50, backoffBaseMs: 40, leaseMs: 60_000, permitirWebhookRedePrivada: true };
    let chamadas = 0;
    const w = new Worker(completo.uow, {
      sempre_falha: async () => { chamadas++; throw new Error("boom"); },
      falha_uma_vez: async (t) => { if (t.tentativas === 1) throw new Error("transitorio"); return { ok: true }; },
    }, opW, log);
    const fila = completo.uow.simples().tarefas;
    const t1 = await fila.enfileirar({ tipo: "sempre_falha", maxTentativas: 3 });
    await w.processarProxima();
    let s = (await sql.query(`SELECT status, tentativas, "proximaExecucaoEm", "ultimoErro" FROM "TarefaAssincrona" WHERE id=$1`, [t1.id])).rows[0];
    afirmar(s.status === "pendente" && s.tentativas === 1 && s.ultimoErro === "boom" && s.proximaExecucaoEm.getTime() > Date.now() - 5, "1a falha: volta para a fila com nova data (backoff)");
    afirmar((await w.processarProxima()) === false, "antes do backoff vencer a tarefa nao e reexecutada");
    await dormir(60);
    await w.processarProxima();
    s = (await sql.query(`SELECT status, tentativas, "proximaExecucaoEm" FROM "TarefaAssincrona" WHERE id=$1`, [t1.id])).rows[0];
    const espera2 = s.proximaExecucaoEm.getTime() - Date.now();
    afirmar(s.status === "pendente" && s.tentativas === 2 && espera2 > 40 && espera2 <= 80, `2a falha: backoff dobra (~80ms, medido ${espera2}ms)`);
    await dormir(100);
    await w.processarProxima();
    s = (await sql.query(`SELECT status, tentativas, "ultimoErro", "concluidoEm" FROM "TarefaAssincrona" WHERE id=$1`, [t1.id])).rows[0];
    afirmar(s.status === "falha" && s.tentativas === 3 && chamadas === 3 && s.concluidoEm, "apos 3 tentativas a tarefa falha de vez (politica: max 3, backoff exponencial)");
    const t2 = await fila.enfileirar({ tipo: "falha_uma_vez", maxTentativas: 3 });
    await w.processarProxima();
    await dormir(60);
    await w.processarProxima();
    s = (await sql.query(`SELECT status, tentativas, resultado, "ultimoErro" FROM "TarefaAssincrona" WHERE id=$1`, [t2.id])).rows[0];
    afirmar(s.status === "concluida" && s.tentativas === 2 && s.resultado.ok === true && s.ultimoErro === null, "falha transitoria: a 2a tentativa conclui a tarefa");
    const t3 = await fila.enfileirar({ tipo: "tipo_inexistente", maxTentativas: 3 });
    await w.processarProxima();
    s = (await sql.query(`SELECT status, tentativas FROM "TarefaAssincrona" WHERE id=$1`, [t3.id])).rows[0];
    afirmar(s.status === "falha" && s.tentativas === 1, "erro permanente (tipo desconhecido) falha na hora, sem novas tentativas");
    // lease vencido
    const t4 = await fila.enfileirar({ tipo: "falha_uma_vez", maxTentativas: 3 });
    await sql.query(`UPDATE "TarefaAssincrona" SET status='processando', tentativas=1, "bloqueadaAte"=now() - interval '1 second' WHERE id=$1`, [t4.id]);
    await fila.recuperarTravadas();
    s = (await sql.query(`SELECT status FROM "TarefaAssincrona" WHERE id=$1`, [t4.id])).rows[0];
    afirmar(s.status === "pendente", "worker que morreu no meio: o lease vence e a tarefa volta para a fila");
    await sql.query(`UPDATE "TarefaAssincrona" SET status='processando', tentativas=3, "bloqueadaAte"=now() - interval '1 second' WHERE id=$1`, [t4.id]);
    await fila.recuperarTravadas();
    s = (await sql.query(`SELECT status FROM "TarefaAssincrona" WHERE id=$1`, [t4.id])).rows[0];
    afirmar(s.status === "falha", "lease vencido com tentativas esgotadas => falha");
    await completo.worker.esvaziarFila();
    // concorrencia
    await sql.query(`DELETE FROM "TarefaAssincrona" WHERE status IN ('pendente','processando')`);
    for (let i = 0; i < 6; i++) await fila.enfileirar({ tipo: "falha_uma_vez", maxTentativas: 3 });
    const pegas = await Promise.all(Array.from({ length: 10 }, () => completo.uow.simples().tarefas.reivindicar(60_000)));
    const idsPegos = pegas.filter(Boolean).map((x) => x.id);
    afirmar(idsPegos.length === 6 && new Set(idsPegos).size === 6, "10 workers disputando 6 tarefas: cada tarefa e entregue a um unico worker (SKIP LOCKED)");
    await sql.query(`DELETE FROM "TarefaAssincrona" WHERE status IN ('pendente','processando')`);
    // chave unica
    const u1 = await fila.enfileirar({ tipo: "analise_agendada", maxTentativas: 3, chaveUnica: "teste:1" });
    const u2 = await fila.enfileirar({ tipo: "analise_agendada", maxTentativas: 3, chaveUnica: "teste:1" });
    afirmar(u1 && u2 === null, "chaveUnica impede tarefa recorrente duplicada (varias instancias)");
    await sql.query(`DELETE FROM "TarefaAssincrona"`);
    // worker em loop
    const wLoop = new Worker(completo.uow, { falha_uma_vez: async () => ({ ok: 1 }) }, { ...opW, intervaloMs: 30 }, log);
    const t5 = await fila.enfileirar({ tipo: "falha_uma_vez", maxTentativas: 3 });
    wLoop.iniciar();
    await dormir(250);
    await wLoop.parar();
    afirmar((await sql.query(`SELECT status FROM "TarefaAssincrona" WHERE id=$1`, [t5.id])).rows[0].status === "concluida", "worker em segundo plano (setInterval) consome a fila sozinho e para com graciosidade");

    titulo("15) Agendamento das analises (node-cron)");
    let invalida = false;
    try { agendarAnalises("isso nao e cron", () => fila, 3); } catch { invalida = true; }
    afirmar(invalida, "expressao cron invalida e recusada");
    const ag = agendarAnalises("* * * * * *", () => completo.uow.simples().tarefas, 3);
    await dormir(2600);
    ag.parar();
    const agendadas = (await sql.query(`SELECT id FROM "TarefaAssincrona" WHERE tipo='analise_agendada'`)).rows;
    afirmar(agendadas.length === 1, `cron disparou varias vezes mas enfileirou 1 tarefa por minuto (${agendadas.length})`);
    const antes = (await sql.query(`SELECT count(*)::int AS n FROM "AnaliseExecucao" WHERE origem='agendada'`)).rows[0].n;
    await completo.worker.esvaziarFila();
    const depois = (await sql.query(`SELECT count(*)::int AS n FROM "AnaliseExecucao" WHERE origem='agendada'`)).rows[0].n;
    afirmar(depois - antes === 3, "worker executou as 3 analises em segundo plano (origem 'agendada') e as gravou no historico");
    r = await adm("POST", "/tarefas/analise", tAdmin);
    afirmar(r.status === 202 && r.body.status === "pendente", "admin tambem enfileira a analise completa por endpoint (202)");
    await completo.worker.esvaziarFila();
    r = await adm("GET", "/tarefas?status=concluida", tAud);
    afirmar(r.status === 200 && r.body.total >= 1 && !("resultado" in r.body.itens[0]), "admin/auditor acompanham a fila (lista sem o corpo do resultado)");
    afirmar((await adm("GET", `/tarefas/${agendadas[0].id}`, tAud)).body.resultado.execucoes.length === 3, "detalhe da tarefa traz o resultado");

    titulo("16) Varredura de autorizacao das rotas novas");
    const rotasAdmin = Object.entries(docI.paths).filter(([p]) => p.startsWith("/api/v1/admin/")).flatMap(([p, ops]) => Object.keys(ops).map((m) => ({ m: m.toUpperCase(), p })));
    const U = "00000000-0000-4000-8000-000000000000";
    const sub = (p) => p.replace("{id}", U).replace("{tipo}", "eficiencia");
    afirmar(rotasAdmin.length >= 15, `varredura admin cobre ${rotasAdmin.length} rotas`);
    const sem = [], cad = [], alm = [], audErr = [];
    for (const rt of rotasAdmin) {
      const body = rt.m === "GET" ? undefined : {};
      const call = (t) => app.inject({ method: rt.m, url: sub(rt.p), payload: body, headers: t ? { authorization: `Bearer ${t}` } : {} }).then((x) => x.statusCode);
      if ((await call(null)) !== 401) sem.push(`${rt.m} ${rt.p}`);
      if ((await call(tCad)) !== 403) cad.push(`${rt.m} ${rt.p}`);
      if ((await call(tAlm)) !== 403) alm.push(`${rt.m} ${rt.p}`);
      const sa = await call(tAud);
      if (rt.m === "GET" ? sa === 401 || sa === 403 : sa !== 403) audErr.push(`${rt.m} ${rt.p} ${sa}`);
    }
    afirmar(sem.length === 0, `admin: sem token => 401 em todas ${sem.slice(0, 2).join("; ")}`);
    afirmar(cad.length === 0 && alm.length === 0, `admin: cadastro e almoxarifado => 403 em todas ${[...cad, ...alm].slice(0, 2).join("; ")}`);
    afirmar(audErr.length === 0, `admin: auditor le (GET) e nao escreve ${audErr.slice(0, 2).join("; ")}`);
    const rotasPub = Object.entries(docP.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => ({ m: m.toUpperCase(), p })));
    const semChave = [];
    for (const rt of rotasPub) {
      const x = await app.inject({ method: rt.m, url: rt.p.replace("{id}", U), payload: rt.m === "GET" ? undefined : {}, headers: { authorization: `Bearer ${tAdmin}` } });
      if (x.statusCode !== 401) semChave.push(`${rt.m} ${rt.p}`);
    }
    afirmar(semChave.length === 0, `publicas: sem chave (mesmo com JWT de admin) => 401 em todas ${semChave.slice(0, 2).join("; ")}`);

    titulo("17) Configuracao e compatibilidade (Windows / Ubuntu)");
    const base = { DATABASE_URL: URL_BANCO, JWT_SECRET: SEGREDO };
    const cfg = carregarConfiguracao({ ...base, ANALISE_CRON: "*/5 * * * *", FILA_MAX_TENTATIVAS: "5", WORKER_ATIVO: "false" });
    afirmar(cfg.analiseCron === "*/5 * * * *" && cfg.filaMaxTentativas === 5 && cfg.workerAtivo === false, "variaveis da AV3 lidas (ANALISE_CRON, FILA_MAX_TENTATIVAS, WORKER_ATIVO)");
    let erroCfg = "";
    try { carregarConfiguracao({ ...base, FILA_MAX_TENTATIVAS: "0" }); } catch (e) { erroCfg = e.message; }
    afirmar(/FILA_MAX_TENTATIVAS/.test(erroCfg), "valor invalido de configuracao e recusado na inicializacao");
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8"));
    const scripts = Object.values(pkg.scripts).join("\n");
    afirmar(!/(^|\s)(rm|cp|mv|export|cat|grep|sed)\s|\$\{?[A-Z_]+\}?|\/tmp\//.test(scripts), "scripts do package.json sem comandos exclusivos de Linux (rodam no Windows 10+ e no Ubuntu)");
    const fontes = [];
    const varrer = (d) => fs.readdirSync(d).forEach((f) => { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== "generated") varrer(p); } else if (p.endsWith(".ts")) fontes.push(p); });
    varrer(path.join(RAIZ, "src"));
    const ruins = fontes.filter((f) => /["'`]\/(tmp|etc|var|home)\//.test(fs.readFileSync(f, "utf8")));
    afirmar(ruins.length === 0, `codigo-fonte sem caminhos absolutos de Linux (${fontes.length} arquivos verificados)`);
    afirmar(fs.existsSync(path.join(RAIZ, "docker-compose.yml")), "docker-compose.yml disponibiliza o PostgreSQL nas duas plataformas");
    afirmar(!!pkg.dependencies["simple-statistics"] && !!pkg.dependencies["node-cron"] && !!pkg.dependencies["@fastify/rate-limit"] && !!pkg.dependencies["@fastify/swagger"], "dependencias da AV3 (simple-statistics, node-cron, @fastify/rate-limit, @fastify/swagger) declaradas");
  } finally {
    try { if (recebedor) recebedor.close(); } catch {}
    try { if (app) await app.close(); } catch {}
    try { if (prisma) await prisma.$disconnect(); } catch {}
    await sql.end().catch(() => null);
    await admin.query(`DROP DATABASE IF EXISTS "${NOME_BANCO}" WITH (FORCE)`).catch(() => null);
    await admin.end().catch(() => null);
  }

  console.log(`\nResumo: ${passos - falhas}/${passos} verificacoes OK.`);
  if (falhas > 0) {
    console.log(`${falhas} falha(s).`);
    process.exit(1);
  }
  console.log("Todas as verificacoes passaram.");
}

main().catch((e) => {
  console.error("Erro inesperado no teste da AV3:", e);
  process.exit(1);
});
