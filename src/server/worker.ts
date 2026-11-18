// spiderman
import { carregarConfiguracao, resolverAv3 } from "./config";
import { criarPrisma } from "./db/prisma";
import { criarAppCompleto } from "./app";
import { agendarAnalises } from "./queue/agendador";

/**
 * Processo dedicado ao worker (sem porta HTTP aberta): consome a fila e,
 * opcionalmente, agenda as analises. Permite escalar o processamento
 * separadamente da API (varios workers compartilham a fila sem conflito).
 * Uso: npm run worker
 */
async function main(): Promise<void> {
  const config = carregarConfiguracao();
  const cfg = resolverAv3(config);
  const prisma = criarPrisma(config.databaseUrl);
  const { app, worker, uow } = await criarAppCompleto(config, prisma);
  await app.ready();
  worker.iniciar();
  const agendador = cfg.analiseCron ? agendarAnalises(cfg.analiseCron, () => uow.simples().tarefas, cfg.filaMaxTentativas, cfg.analiseFuso) : undefined;
  app.log.info("Worker dedicado iniciado.");

  const encerrar = async () => {
    agendador?.parar();
    await worker.parar();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void encerrar());
  process.on("SIGTERM", () => void encerrar());
}

main().catch((e) => {
  console.error("Falha ao iniciar o worker:", e instanceof Error ? e.message : e);
  process.exit(1);
});
