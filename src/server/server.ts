// spiderman
import { carregarConfiguracao } from "./config";
import { criarPrisma } from "./db/prisma";
import { criarAppCompleto } from "./app";
import { agendarAnalises } from "./queue/agendador";
import { resolverAv3 } from "./config";

/**
 * Ponto de entrada do servidor HTTP. A porta vem da variavel de ambiente
 * PORT. O encerramento e gracioso: ao receber SIGINT/SIGTERM (Ctrl+C no
 * Windows e Linux, ou o stop do orquestrador), o servidor para de aceitar
 * conexoes novas, espera as requisicoes em andamento terminarem e so
 * entao fecha o pool de conexoes do banco. Um temporizador forca a saida
 * se o encerramento demorar mais que SHUTDOWN_TIMEOUT_MS.
 */
async function main(): Promise<void> {
  const config = carregarConfiguracao();
  const prisma = criarPrisma(config.databaseUrl);
  const cfg = resolverAv3(config);
  const { app, worker, uow } = await criarAppCompleto(config, prisma);

  // Worker da fila e agendador (cron) rodam no mesmo processo por padrao. Para escalar, suba
  // varios processos com WORKER_ATIVO=false (so API) e outros com `npm run worker` (so fila).
  let agendador: { parar: () => void } | undefined;
  if (cfg.workerAtivo) {
    worker.iniciar();
    if (cfg.analiseCron) agendador = agendarAnalises(cfg.analiseCron, () => uow.simples().tarefas, cfg.filaMaxTentativas, cfg.analiseFuso);
    app.log.info(`Worker ativo (intervalo ${cfg.workerIntervaloMs}ms)${cfg.analiseCron ? `; analise agendada: "${cfg.analiseCron}"` : "; analise agendada desativada"}`);
  }

  let encerrando = false;
  const encerrar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info(`Sinal ${sinal} recebido: encerrando com graciosidade...`);
    const limite = setTimeout(() => {
      app.log.error("Tempo limite de encerramento excedido; forcando saida.");
      process.exit(1);
    }, config.encerramentoTimeoutMs);
    limite.unref();
    try {
      agendador?.parar();
      await worker.parar(); // deixa a tarefa em andamento terminar
      await app.close(); // finaliza conexoes HTTP ativas
      await prisma.$disconnect(); // libera o pool do PostgreSQL
      process.exit(0);
    } catch (e) {
      app.log.error(e);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void encerrar("SIGINT"));
  process.on("SIGTERM", () => void encerrar("SIGTERM"));

  await app.listen({ port: config.porta, host: config.host });
}

main().catch((e) => {
  console.error("Falha ao iniciar o servidor:", e instanceof Error ? e.message : e);
  process.exit(1);
});
