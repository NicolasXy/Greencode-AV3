// spiderman
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Configuracao, resolverAv3 } from "./config";
import { PrismaClient } from "./db/prisma";
import { UnidadeDeTrabalho } from "./db/unidadeDeTrabalho";
import { registrarAutenticacao } from "./plugins/autenticacao";
import { registrarTratamentoDeErros } from "./plugins/erros";
import { registrarRotas } from "./routes/rotas";
import { registrarRotasAdmin } from "./routes/rotasAdmin";
import { registrarRotasPublicas } from "./routes/rotasPublicas";
import { ChaveApiService } from "./services/ChaveApiService";
import { AnaliticaService } from "./services/AnaliticaService";
import { RelatorioService } from "./services/RelatorioService";
import { TarefaService } from "./services/TarefaService";
import { AdminController } from "./controllers/AdminController";
import { PublicoController } from "./controllers/PublicoController";
import { PublicoService } from "./services/PublicoService";
import { criarManipuladores } from "./queue/manipuladores";
import { Worker } from "./queue/Worker";
import { AuthService } from "./services/AuthService";
import { OrganizacaoService } from "./services/OrganizacaoService";
import { ContratoService } from "./services/ContratoService";
import { EquipamentoService } from "./services/EquipamentoService";
import { LoteService } from "./services/LoteService";
import { AuditoriaService, ParametroService } from "./services/ParametroService";
import { AuthController } from "./controllers/AuthController";
import { ContratoController, OrganizacaoController } from "./controllers/OrganizacaoController";
import { AuditoriaController, EquipamentoController, LoteController, ParametroController } from "./controllers/LoteController";

/**
 * Monta a aplicacao Fastify (composition root): cria a unidade de trabalho,
 * os services, os controllers e registra plugins e rotas. Nao abre porta
 * nem le variaveis de ambiente: isso permite instanciar o app nos testes
 * (via app.inject) e no servidor real (server.ts) com a mesma configuracao.
 */
/** O app e o worker da fila, ja ligados aos mesmos servicos. server.ts inicia o worker; os testes o chamam direto. */
export interface AppCompleto {
  app: FastifyInstance;
  worker: Worker;
  analitica: AnaliticaService;
  tarefas: TarefaService;
  uow: UnidadeDeTrabalho;
}

export async function criarApp(config: Configuracao, prisma: PrismaClient): Promise<FastifyInstance> {
  return (await criarAppCompleto(config, prisma)).app;
}

export async function criarAppCompleto(configEntrada: Configuracao, prisma: PrismaClient): Promise<AppCompleto> {
  const config = resolverAv3(configEntrada);
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    // Limite de corpo: evita payloads gigantes (500 equipamentos cabem com folga).
    bodyLimit: 1024 * 1024,
  });

  const uow = new UnidadeDeTrabalho(prisma);

  // Camada de servicos (regras de negocio).
  const auth = new AuthService(uow, config.bcryptRounds);
  const equipamentos = new EquipamentoService(uow);
  const lotes = new LoteService(uow, equipamentos);
  const organizacoes = new OrganizacaoService(uow);
  const contratos = new ContratoService(uow);
  const parametros = new ParametroService(uow);
  const auditoria = new AuditoriaService(uow);
  // AV3: camada analitica, chaves de API e fila.
  const analitica = new AnaliticaService(uow);
  const chaves = new ChaveApiService(uow);
  const relatorios = new RelatorioService(uow, analitica);
  const tarefas = new TarefaService(uow, { maxTentativas: config.filaMaxTentativas, webhookRedePrivada: config.webhookRedePrivada });
  const worker = new Worker(
    uow,
    criarManipuladores(analitica, relatorios),
    { intervaloMs: config.workerIntervaloMs, backoffBaseMs: config.filaBackoffMs, leaseMs: config.filaLeaseMs, permitirWebhookRedePrivada: config.webhookRedePrivada },
    { info: (m) => app.log.info(m), error: (o, m) => app.log.error(o as object, m) }
  );

  registrarTratamentoDeErros(app);
  await app.register(cors, { origin: config.corsOrigin });
  // Documentacao interna/administrativa (/docs). A API publica tem documentacao propria (/docs/publico)
  // e as rotas "legadas" sem prefixo (/api/v1/...) ficam escondidas: o contrato oficial e /api/v1/internal.
  await app.register(swagger, {
    openapi: {
      info: { title: "greencode API (interna e administrativa)", description: "Logistica reversa de residuos eletronicos. Rotas /api/v1/internal (front-end e operacao) e /api/v1/admin (gestao). A API de parceiros esta em /docs/publico.", version: "3.0.0" },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
      security: [{ bearerAuth: [] }],
    },
    transform: ({ schema, url }) => {
      const escondida = url.startsWith("/api/v1/public") || !/^\/api\/v1\/(internal|admin)\//.test(url);
      return { schema: escondida ? { ...(schema as object), hide: true } : schema, url } as { schema: typeof schema; url: string };
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await registrarAutenticacao(app, { jwtSecret: config.jwtSecret, jwtExpiraEm: config.jwtExpiraEm, carregarAtor: (id) => auth.obterAtor(id) });

  const controllers = {
    auth: new AuthController(auth, (p) => app.jwt.sign(p), config.jwtExpiraEm),
    organizacoes: new OrganizacaoController(organizacoes),
    contratos: new ContratoController(contratos),
    lotes: new LoteController(lotes),
    equipamentos: new EquipamentoController(equipamentos),
    auditoria: new AuditoriaController(auditoria),
    parametros: new ParametroController(parametros),
  };

  // Rotas internas (JWT): /api/v1/internal e, por compatibilidade com o front/CLI/testes da AV2,
  // o mesmo conjunto no prefixo antigo /api/v1 (sem aparecer na documentacao).
  await app.register((v1) => registrarRotas(v1, controllers), { prefix: "/api/v1/internal" });
  await app.register((v1) => registrarRotas(v1, controllers), { prefix: "/api/v1" });
  // Rotas administrativas (JWT admin/auditor): analises, chaves de API, fila.
  await app.register((v1) => registrarRotasAdmin(v1, new AdminController(analitica, chaves, tarefas)), { prefix: "/api/v1/admin" });
  // API publica (chave de API): /api/v1/public, com Swagger proprio em /docs/publico.
  await app.register(async (raiz) => {
    await raiz.register(swagger, {
      openapi: {
        openapi: "3.0.3",
        info: {
          title: "greencode API publica",
          version: "1.0.0",
          description:
            "API para parceiros: rastreabilidade, lotes e relatorios preditivos.\n\nAutenticacao: cabecalho `X-API-Key` (clique em Authorize). Cada chave tem escopos e limite de requisicoes por minuto; ao exceder, a resposta e 429 com `Retry-After`.\n\nVersionamento: a versao esta na URL (`/api/v1/public`). Mudancas incompativeis geram `/api/v2/public`, e a v1 segue ativa durante o periodo de depreciacao.\n\nErros: sempre `{ \"erro\": \"...\", \"mensagem\": \"...\" }` (400, 401, 403, 404, 409, 429).",
        },
        servers: [{ url: "/" }],
        components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } },
        tags: [
          { name: "conta", description: "Sobre a chave em uso" },
          { name: "rastreabilidade", description: "escopo rastreabilidade:ler" },
          { name: "lotes", description: "escopos lotes:ler / lotes:escrever" },
          { name: "relatorios", description: "escopo relatorios:gerar (processamento assincrono)" },
        ],
      },
    });
    await raiz.register(swaggerUi, { routePrefix: "/docs/publico" });
    await raiz.register((pub) => registrarRotasPublicas(pub, chaves, new PublicoController(new PublicoService(uow), lotes, equipamentos, tarefas)), { prefix: "/api/v1/public" });
  });

  return { app, worker, analitica, tarefas, uow };
}
