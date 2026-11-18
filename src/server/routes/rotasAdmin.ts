// spiderman
import { FastifyInstance } from "fastify";
import { permitir } from "../plugins/autenticacao";
import { schemaId, schemaPaginacao } from "../controllers/util";
import { AdminController } from "../controllers/AdminController";
import { ESCOPOS } from "../services/ChaveApiService";

const TIPOS = ["eficiencia", "rentabilidade", "vida-util"];
const leitura = permitir("admin", "auditor");
const escrita = permitir("admin");
const query = (extra: Record<string, unknown> = {}) => ({ type: "object", properties: { ...schemaPaginacao, ...extra } });
const paramTipo = { type: "object", required: ["tipo"], properties: { tipo: { type: "string", enum: TIPOS } } };

/**
 * Rotas administrativas (/api/v1/admin): so o JWT de admin/auditor. Reunem a
 * camada analitica, o gerenciamento das chaves de API dos parceiros e o
 * acompanhamento da fila. O auditor so le (o hook global ja bloqueia escrita).
 */
export async function registrarRotasAdmin(app: FastifyInstance, c: AdminController): Promise<void> {
  // ---------------- Analises (BI) ----------------
  app.post("/analises/:tipo/executar", {
    onRequest: escrita,
    schema: {
      tags: ["analises"],
      summary: "Executa uma analise agora (sincrono) e grava o relatorio no historico",
      description: "tipo: eficiencia (tempo de processamento, operadores, periodos, gargalo), rentabilidade (valor medio de recuperacao) ou vida-util (regressao linear por tipo; grava as previsoes).",
      params: paramTipo,
      body: { type: ["object", "null"], additionalProperties: false, properties: { desde: { type: "string", format: "date-time", description: "Considera so dados a partir deste instante (ISO 8601)." } } },
    },
    handler: c.executarAnalise,
  });
  app.get("/analises/relatorios", {
    onRequest: leitura,
    schema: { tags: ["analises"], summary: "Historico de relatorios gerados", querystring: query({ tipo: { type: "string", enum: TIPOS } }) },
    handler: c.listarRelatorios,
  });
  app.get("/analises/relatorios/:id", { onRequest: leitura, schema: { tags: ["analises"], summary: "Um relatorio do historico (com o resultado completo)", params: schemaId }, handler: c.obterRelatorio });
  app.get("/analises/:tipo/ultimo", { onRequest: leitura, schema: { tags: ["analises"], summary: "Relatorio mais recente do tipo", params: paramTipo }, handler: c.ultimoRelatorio });
  app.post("/analises/previsoes/avaliar", {
    onRequest: escrita,
    schema: { tags: ["analises"], summary: "Compara previsoes pendentes com a realidade (equipamentos que viraram sucata) e grava o erro" },
    handler: c.avaliarPrevisoes,
  });
  app.get("/analises/previsoes", {
    onRequest: leitura,
    schema: { tags: ["analises"], summary: "Previsoes de vida util (previsto x real)", querystring: query({ tipoEquipamento: { type: "string" }, avaliadas: { type: "boolean" } }) },
    handler: c.listarPrevisoes,
  });
  app.get("/analises/previsoes/acuracia", { onRequest: leitura, schema: { tags: ["analises"], summary: "Erro medio das previsoes ja avaliadas, por tipo" }, handler: c.acuracia });

  // ---------------- Chaves de API ----------------
  const escopos = { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...ESCOPOS] }, description: "rastreabilidade:ler | lotes:ler | lotes:escrever (inclui ler) | relatorios:gerar" };
  const limite = { type: "integer", minimum: 1, maximum: 100000, description: "Requisicoes por minuto desta chave (padrao 60)." };
  app.post("/chaves-api", {
    onRequest: escrita,
    schema: {
      tags: ["chaves-api"],
      summary: "Emite a chave de API de um parceiro (a chave completa so aparece nesta resposta)",
      body: {
        type: "object",
        required: ["nome", "orgCnpj", "escopos"],
        additionalProperties: false,
        properties: { nome: { type: "string", minLength: 1, maxLength: 100 }, orgCnpj: { type: "string" }, escopos, limitePorMinuto: limite, expiraEm: { type: "string", format: "date-time" } },
      },
    },
    handler: c.criarChave,
  });
  app.get("/chaves-api", {
    onRequest: leitura,
    schema: { tags: ["chaves-api"], summary: "Lista as chaves (nunca mostra o segredo)", querystring: query({ organizacaoId: { type: "string", format: "uuid" }, ativa: { type: "boolean" } }) },
    handler: c.listarChaves,
  });
  app.get("/chaves-api/:id", { onRequest: leitura, schema: { tags: ["chaves-api"], params: schemaId }, handler: c.obterChave });
  app.patch("/chaves-api/:id", {
    onRequest: escrita,
    schema: {
      tags: ["chaves-api"],
      summary: "Altera nome, escopos, limite ou validade (nao altera o segredo)",
      params: schemaId,
      body: { type: "object", additionalProperties: false, properties: { nome: { type: "string", minLength: 1, maxLength: 100 }, escopos, limitePorMinuto: limite, expiraEm: { type: ["string", "null"], format: "date-time" } } },
    },
    handler: c.atualizarChave,
  });
  app.post("/chaves-api/:id/revogar", { onRequest: escrita, schema: { tags: ["chaves-api"], summary: "Revoga a chave (irreversivel)", params: schemaId }, handler: c.revogarChave });

  // ---------------- Fila ----------------
  app.get("/tarefas", {
    onRequest: leitura,
    schema: { tags: ["tarefas"], summary: "Tarefas da fila", querystring: query({ status: { type: "string", enum: ["pendente", "processando", "concluida", "falha"] }, tipo: { type: "string" } }) },
    handler: c.listarTarefas,
  });
  app.get("/tarefas/:id", { onRequest: leitura, schema: { tags: ["tarefas"], params: schemaId }, handler: c.obterTarefa });
  app.post("/tarefas/analise", {
    onRequest: escrita,
    schema: { tags: ["tarefas"], summary: "Enfileira a analise completa (as 3 analises + avaliacao das previsoes) para o worker" },
    handler: c.enfileirarAnalise,
  });
}
