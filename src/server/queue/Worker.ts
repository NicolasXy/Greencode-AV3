// spiderman
import { UnidadeDeTrabalho } from "../db/unidadeDeTrabalho";
import { TarefaReivindicada } from "../repositories/TarefaRepository";
import { entregarWebhook } from "./webhook";

export type Manipulador = (tarefa: TarefaReivindicada) => Promise<object>;

/** Erro que nao adianta repetir (parametro invalido, tipo desconhecido): a tarefa falha na hora, sem novas tentativas. */
export class ErroPermanente extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroPermanente";
  }
}

export interface OpcoesWorker {
  intervaloMs: number;
  backoffBaseMs: number;
  leaseMs: number;
  permitirWebhookRedePrivada: boolean;
}

export interface Logger {
  info(msg: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Worker da fila: a cada `intervaloMs` consome as tarefas prontas, uma por vez.
 * Politica de retry: ate `maxTentativas` (padrao 3) execucoes por tarefa, com
 * backoff exponencial (base * 2^(tentativa-1): 5s, 10s, 20s...). ErroPermanente
 * nao tenta de novo. Se o processo morrer no meio, o lease vence e a tarefa
 * volta para a fila (ver TarefaRepository.recuperarTravadas).
 */
export class Worker {
  private timer?: NodeJS.Timeout;
  private ocupado: Promise<void> = Promise.resolve();
  private rodando = false;

  constructor(
    private readonly uow: UnidadeDeTrabalho,
    private readonly manipuladores: Record<string, Manipulador>,
    private readonly opcoes: OpcoesWorker,
    private readonly log: Logger
  ) {}

  iniciar(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.rodando) return; // nunca dois ciclos sobrepostos no mesmo worker
      this.rodando = true;
      this.ocupado = this.esvaziarFila()
        .then(() => undefined)
        .catch((e) => this.log.error(e, "Falha no ciclo do worker"))
        .finally(() => (this.rodando = false));
    }, this.opcoes.intervaloMs);
    this.timer.unref();
  }

  /** Para de agendar ciclos e espera o ciclo em andamento terminar (encerramento gracioso). */
  async parar(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ocupado;
  }

  async esvaziarFila(): Promise<number> {
    let n = 0;
    while (await this.processarProxima()) n++;
    return n;
  }

  /** Processa UMA tarefa pronta. Devolve false se a fila estava vazia. */
  async processarProxima(): Promise<boolean> {
    const repo = this.uow.simples().tarefas;
    await repo.recuperarTravadas();
    const t = await repo.reivindicar(this.opcoes.leaseMs);
    if (!t) return false;

    try {
      const manipulador = this.manipuladores[t.tipo];
      if (!manipulador) throw new ErroPermanente(`Tipo de tarefa desconhecido: ${t.tipo}`);
      await repo.concluir(t.id, await manipulador(t));
      await this.notificar(t, "concluida");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const esgotou = e instanceof ErroPermanente || t.tentativas >= t.maxTentativas;
      if (esgotou) {
        await repo.falhar(t.id, msg);
        this.log.error(e, `Tarefa ${t.id} (${t.tipo}) falhou apos ${t.tentativas} tentativa(s)`);
        await this.notificar(t, "falha");
      } else {
        const espera = this.opcoes.backoffBaseMs * 2 ** (t.tentativas - 1);
        await repo.reagendar(t.id, new Date(Date.now() + espera), msg);
        this.log.info(`Tarefa ${t.id} (${t.tipo}) falhou (tentativa ${t.tentativas}/${t.maxTentativas}); nova tentativa em ${espera}ms: ${msg}`);
      }
    }
    return true;
  }

  /** Webhook e "melhor esforco": falha na entrega nao desfaz a tarefa (o parceiro ainda pode consultar por polling). */
  private async notificar(t: TarefaReivindicada, status: "concluida" | "falha"): Promise<void> {
    if (!t.webhookUrl || !t.chaveApiId) return;
    const repos = this.uow.simples();
    try {
      const chave = await repos.chavesApi.buscarPorId(t.chaveApiId);
      if (!chave) return;
      await entregarWebhook(
        t.webhookUrl,
        chave.segredoWebhook,
        { evento: status === "concluida" ? "relatorio.concluido" : "relatorio.falhou", tarefaId: t.id, status, resultadoUrl: status === "concluida" ? `/api/v1/public/tarefas/${t.id}/resultado` : null },
        this.opcoes.permitirWebhookRedePrivada
      );
      await repos.tarefas.registrarWebhook(t.id, "entregue");
    } catch (e) {
      await repos.tarefas.registrarWebhook(t.id, `falha: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
