// spiderman
import { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { exigirEscopo, registrarAutenticacaoPorChave } from "../plugins/chaveApi";
import { ChaveApiService } from "../services/ChaveApiService";
import { PublicoController } from "../controllers/PublicoController";
import { schemaId, schemaPaginacao } from "../controllers/util";

const erro = (descricao: string, exemplo: { erro: string; mensagem: string }) => ({
  description: descricao,
  type: "object",
  properties: { erro: { type: "string" }, mensagem: { type: "string" } },
  example: exemplo,
});
const E401 = erro("Chave ausente, invalida, expirada ou revogada.", { erro: "NaoAutenticado", mensagem: "Chave de API ausente, invalida, expirada ou revogada." });
const E403 = erro("A chave nao possui o escopo exigido.", { erro: "ErroPermissao", mensagem: "Esta chave nao possui o escopo 'lotes:escrever'." });
const E404 = erro("Recurso inexistente ou de outra organizacao.", { erro: "NaoEncontrado", mensagem: "Lote 5f0c... nao encontrado." });
const E409 = erro("Conflito de estado (duplicidade, relatorio ainda nao pronto...).", { erro: "Conflito", mensagem: "O relatorio ainda nao esta pronto (status: processando). Consulte o status e tente novamente." });
const E400 = erro("Parametros invalidos.", { erro: "ErroValidacao", mensagem: "body/nf must NOT have fewer than 1 characters" });
const E429 = erro("Limite de requisicoes por minuto excedido (veja o cabecalho Retry-After).", { erro: "LimiteExcedido", mensagem: "Limite de 60 requisicoes por minuto excedido. Tente novamente em 12 seconds." });
const comuns = { 401: E401, 429: E429 };
const aberto = { type: "object", additionalProperties: true };
const ok = (descricao: string, exemplo: unknown) => ({ description: descricao, ...aberto, example: exemplo });

const exEquip = {
  id: "9a3c1d1e-6a0b-4d52-9f55-2c1f0f4f1a11", codigoBarras: "9a3c1d1e-6a0b-4d52-9f55-2c1f0f4f1a11", loteId: "5f0c7c52-1e63-4f0e-8a7f-0d6d3d4a9e01", posicao: 1,
  tipo: "cpu", marca: "Dell", modelo: "OptiPlex 3080", estadoFisico: "regular", status: "reciclagem", triagemCompleta: true, valorRecuperacaoCentavos: 4500,
  criadoEm: "2026-10-01T12:00:00.000Z", atualizadoEm: "2026-10-20T15:30:00.000Z",
};
const exLote = { id: "5f0c7c52-1e63-4f0e-8a7f-0d6d3d4a9e01", nf: "NF-0001", transportadora: "TransVerde", dataEntrada: "2026-10-01", status: "triagem_completa", criadoEm: "2026-10-01T12:00:00.000Z", triagemConcluidaEm: "2026-10-04T18:10:00.000Z", organizacao: { cnpj: "11222333000181", razaoSocial: "Tech Solutions Ltda" } };

/**
 * API publica de parceiros (/api/v1/public), versionada na URL (v1).
 * Autenticacao por chave (`X-API-Key`), permissao por escopo e limite de
 * requisicoes POR CHAVE. A documentacao interativa propria fica em /docs/publico.
 *
 * Ordem dos hooks (importa): 1) autentica a chave, 2) rate limit usando a
 * chave ja autenticada, 3) escopo da rota.
 */
export async function registrarRotasPublicas(app: FastifyInstance, chaves: ChaveApiService, c: PublicoController): Promise<void> {
  await app.register(async (publico) => {
    registrarAutenticacaoPorChave(publico, chaves);
    await publico.register(rateLimit, {
      global: true,
      timeWindow: 60_000,
      max: (req) => req.chaveApi?.limitePorMinuto ?? 60,
      keyGenerator: (req) => req.chaveApi?.id ?? req.ip,
      errorResponseBuilder: (_req, ctx) => Object.assign(new Error(`Limite de ${ctx.max} requisicoes por minuto excedido. Tente novamente em ${ctx.after}.`), { statusCode: 429 }),
    });

    const seguranca = [{ apiKey: [] }];
    const pag = { type: "object", properties: { ...schemaPaginacao } };

    publico.get("/me", {
      schema: { tags: ["conta"], summary: "Identidade, escopos e limite da chave usada", security: seguranca, response: { 200: ok("Dados da chave.", { nome: "Cooperativa Verde", organizacaoCnpj: "11222333000181", escopos: ["rastreabilidade:ler"], limitePorMinuto: 60 }), ...comuns } },
      handler: c.eu,
    });

    // ----- rastreabilidade:ler -----
    publico.get("/rastreabilidade/equipamentos/:id", {
      onRequest: exigirEscopo("rastreabilidade:ler"),
      schema: {
        tags: ["rastreabilidade"],
        summary: "Historico de rastreabilidade de um equipamento",
        description: "Devolve o equipamento e todas as movimentacoes (status e estado fisico) em ordem cronologica. O `id` e o codigo de barras.",
        security: seguranca,
        params: schemaId,
        response: { 200: ok("Equipamento e historico.", { equipamento: exEquip, movimentacoes: [{ id: "c1", statusDe: "aguardando_triagem", statusPara: "em_triagem", estadoDe: null, estadoPara: null, justificativa: null, criadoEm: "2026-10-02T09:00:00.000Z" }] }), 400: E400, 403: E403, 404: E404, ...comuns },
      },
      handler: c.rastreioEquipamento,
    });
    publico.get("/rastreabilidade/lotes/:id", {
      onRequest: exigirEscopo("rastreabilidade:ler"),
      schema: {
        tags: ["rastreabilidade"],
        summary: "Situacao de um lote e de todos os seus equipamentos",
        security: seguranca,
        params: schemaId,
        response: { 200: ok("Lote com equipamentos.", { ...exLote, equipamentos: [exEquip] }), 400: E400, 403: E403, 404: E404, ...comuns },
      },
      handler: c.rastreioLote,
    });

    // ----- lotes -----
    publico.get("/lotes", {
      onRequest: exigirEscopo("lotes:ler"),
      schema: {
        tags: ["lotes"],
        summary: "Lista os lotes da sua organizacao",
        security: seguranca,
        querystring: { ...pag, properties: { ...schemaPaginacao, status: { type: "string", enum: ["recebido", "em_triagem", "triagem_completa", "encerrado"], description: "Filtra pelo status do lote." } } },
        response: { 200: ok("Pagina de lotes.", { itens: [{ ...exLote, totalEquipamentos: 5 }], total: 1, pagina: 1, tamanhoPagina: 20, totalPaginas: 1 }), 400: E400, 403: E403, ...comuns },
      },
      handler: c.listarLotes,
    });
    publico.get("/lotes/:id", {
      onRequest: exigirEscopo("lotes:ler"),
      schema: { tags: ["lotes"], summary: "Detalha um lote da sua organizacao", security: seguranca, params: schemaId, response: { 200: ok("Lote com equipamentos.", { ...exLote, equipamentos: [exEquip] }), 400: E400, 403: E403, 404: E404, ...comuns } },
      handler: c.obterLote,
    });
    publico.post("/lotes", {
      onRequest: exigirEscopo("lotes:escrever"),
      schema: {
        tags: ["lotes"],
        summary: "Cria um lote (e seus equipamentos) na sua organizacao",
        description: "Atomico: ou o lote nasce completo, ou nada e gravado. A organizacao e sempre a da chave. Exige contrato ativo. `dataEntrada` (YYYY-MM-DD) nao pode ser futura nem ter mais de 90 dias.",
        security: seguranca,
        body: {
          type: "object",
          required: ["nf", "transportadora"],
          additionalProperties: false,
          examples: [{ nf: "NF-0099", transportadora: "TransVerde", dataEntrada: "2026-11-10", equipamentos: [{ tipo: "CPU", marca: "Dell", modelo: "OptiPlex 3080" }, { tipo: "Monitor" }] }],
          properties: {
            nf: { type: "string", pattern: "\\S", description: "Nota fiscal (unica por organizacao)." },
            transportadora: { type: "string", pattern: "\\S", description: "Nome da transportadora (nao pode ser vazio)." },
            dataEntrada: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Data de entrada AAAA-MM-DD (padrao: hoje; nao pode ser futura nem ter mais de 90 dias)." },
            equipamentos: {
              type: "array",
              maxItems: 500,
              description: "Equipamentos do lote (ate 500); criados junto com o lote, de forma atomica.",
              items: {
                type: "object",
                required: ["tipo"],
                additionalProperties: false,
                properties: { tipo: { type: "string", pattern: "\\S", description: "Ex.: Terminal, CPU, Monitor, Servidor ou qualquer outro." }, marca: { type: "string", maxLength: 80 }, modelo: { type: "string", maxLength: 80 } },
              },
            },
          },
        },
        response: { 201: ok("Lote criado.", { ...exLote, status: "recebido", triagemConcluidaEm: null, equipamentos: [exEquip] }), 400: E400, 403: E403, 404: E404, 409: E409, ...comuns },
      },
      handler: c.criarLote,
    });

    // ----- relatorios:gerar (assincrono) -----
    publico.post("/relatorios/preditivo", {
      onRequest: exigirEscopo("relatorios:gerar"),
      schema: {
        tags: ["relatorios"],
        summary: "Solicita o relatorio preditivo de todos os seus equipamentos (assincrono)",
        description: "Responde 202 na hora com o `tarefaId`. Acompanhe por polling em `GET /tarefas/{id}` ou informe `webhookUrl` (recebe um POST assinado com HMAC-SHA256 no cabecalho `X-Greencode-Signature`). Quando `concluida`, baixe em `GET /tarefas/{id}/resultado` (json ou csv).",
        security: seguranca,
        body: { type: ["object", "null"], additionalProperties: false, examples: [{ webhookUrl: "https://parceiro.example/hooks/greencode" }], properties: { webhookUrl: { type: "string", maxLength: 500, description: "URL http(s) publica (nao pode apontar para rede privada)." } } },
        response: { 202: ok("Tarefa aceita.", { tarefaId: "0b9e6a3a-3d36-4f0f-8d0e-1a6a3d4a9e02", status: "pendente", statusUrl: "/api/v1/public/tarefas/0b9e6a3a-...", resultadoUrl: "/api/v1/public/tarefas/0b9e6a3a-.../resultado" }), 400: E400, 403: E403, 409: E409, ...comuns },
      },
      handler: c.solicitarRelatorio,
    });
    publico.get("/tarefas/:id", {
      onRequest: exigirEscopo("relatorios:gerar"),
      schema: {
        tags: ["relatorios"],
        summary: "Status da tarefa (polling)",
        description: "status: pendente -> processando -> concluida | falha. Falhas transitorias sao repetidas automaticamente (ate `maxTentativas`, com espera crescente).",
        security: seguranca,
        params: schemaId,
        response: { 200: ok("Status.", { id: "0b9e6a3a-3d36-4f0f-8d0e-1a6a3d4a9e02", tipo: "relatorio_preditivo", status: "concluida", tentativas: 1, maxTentativas: 3, criadoEm: "2026-11-10T10:00:00.000Z", iniciadoEm: "2026-11-10T10:00:02.000Z", concluidoEm: "2026-11-10T10:00:05.000Z", erro: null, webhookStatus: null, resultadoUrl: "/api/v1/public/tarefas/0b9e6a3a-.../resultado" }), 400: E400, 403: E403, 404: E404, ...comuns },
      },
      handler: c.statusTarefa,
    });
    publico.get("/tarefas/:id/resultado", {
      onRequest: exigirEscopo("relatorios:gerar"),
      schema: {
        tags: ["relatorios"],
        summary: "Baixa o relatorio pronto (JSON ou CSV)",
        security: seguranca,
        params: schemaId,
        querystring: { type: "object", properties: { formato: { type: "string", enum: ["json", "csv"], default: "json", description: "Formato do relatorio: json (padrao) ou csv (arquivo text/csv)." } } },
        response: { 200: ok("Relatorio (json) ou arquivo text/csv.", { geradoEm: "2026-11-10T10:00:05.000Z", resumo: { equipamentos: 5, comPrevisaoDeVidaUtil: 3, valorRecuperadoTotalCentavos: 4500, valorEstimadoTotalCentavos: 12000 }, equipamentos: [{ equipamentoId: "9a3c...", tipo: "cpu", vidaRestanteDias: 412.5, valorEstimadoCentavos: 4300, fonteValorEstimado: "tipo_estado" }] }), 400: E400, 403: E403, 404: E404, 409: E409, ...comuns },
      },
      handler: c.resultadoTarefa,
    });
  });
}
