// spiderman
import { Db, Prisma } from "../db/prisma";
import { StatusTarefa } from "../generated/prisma/enums";

/** Linha da fila como o worker a recebe (resultado do UPDATE ... RETURNING). */
export interface TarefaReivindicada {
  id: string;
  tipo: string;
  parametros: Record<string, unknown>;
  tentativas: number;
  maxTentativas: number;
  organizacaoId: string | null;
  chaveApiId: string | null;
  webhookUrl: string | null;
}

/**
 * Fila de tarefas no PostgreSQL. A reivindicacao usa FOR UPDATE SKIP LOCKED:
 * varios workers (processos/maquinas) podem consumir a mesma fila sem pegar a
 * mesma tarefa e sem se bloquear mutuamente.
 */
export class TarefaRepository {
  constructor(private readonly db: Db) {}

  /** Devolve null quando `chaveUnica` ja existe (tarefa recorrente ja enfileirada por outra instancia). */
  async enfileirar(d: { tipo: string; parametros?: object; organizacaoId?: string; chaveApiId?: string; webhookUrl?: string; maxTentativas: number; chaveUnica?: string }) {
    const data = { ...d, parametros: (d.parametros ?? {}) as Prisma.InputJsonValue };
    if (!d.chaveUnica) return this.db.tarefaAssincrona.create({ data });
    const r = await this.db.tarefaAssincrona.createManyAndReturn({ data: [data], skipDuplicates: true });
    return r[0] ?? null;
  }

  buscarPorId(id: string) {
    return this.db.tarefaAssincrona.findUnique({ where: { id } });
  }

  /** Quantas tarefas da organizacao ainda nao terminaram (limita o acumulo de relatorios pendentes por parceiro). */
  contarAtivas(organizacaoId: string, tipo: string) {
    return this.db.tarefaAssincrona.count({ where: { organizacaoId, tipo, status: { in: ["pendente", "processando"] } } });
  }

  async listar(skip: number, take: number, f: { status?: StatusTarefa; tipo?: string }) {
    const where = { ...(f.status ? { status: f.status } : {}), ...(f.tipo ? { tipo: f.tipo } : {}) };
    const [itens, total] = await Promise.all([
      this.db.tarefaAssincrona.findMany({ where, orderBy: { criadoEm: "desc" }, skip, take, omit: { resultado: true } }),
      this.db.tarefaAssincrona.count({ where }),
    ]);
    return { itens, total };
  }

  /** Tarefas "processando" cujo lease venceu (worker morreu): voltam para a fila, ou falham se esgotaram as tentativas. */
  async recuperarTravadas(): Promise<number> {
    return this.db.$executeRaw`
      UPDATE "TarefaAssincrona"
      SET status = CASE WHEN tentativas >= "maxTentativas" THEN 'falha'::"StatusTarefa" ELSE 'pendente'::"StatusTarefa" END,
          "ultimoErro" = 'Tempo de processamento excedido (worker interrompido).',
          "concluidoEm" = CASE WHEN tentativas >= "maxTentativas" THEN now() ELSE NULL END,
          "bloqueadaAte" = NULL
      WHERE status = 'processando'::"StatusTarefa" AND "bloqueadaAte" < now()`;
  }

  /** Pega a proxima tarefa pronta (atomico) e a marca como "processando" com um lease. */
  async reivindicar(leaseMs: number): Promise<TarefaReivindicada | null> {
    const linhas = await this.db.$queryRaw<TarefaReivindicada[]>`
      UPDATE "TarefaAssincrona"
      SET status = 'processando'::"StatusTarefa", tentativas = tentativas + 1, "iniciadoEm" = now(),
          "bloqueadaAte" = now() + (${leaseMs}::int * interval '1 millisecond')
      WHERE id = (
        SELECT id FROM "TarefaAssincrona"
        WHERE status = 'pendente'::"StatusTarefa" AND "proximaExecucaoEm" <= now()
        ORDER BY "proximaExecucaoEm", "criadoEm"
        FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, tipo, parametros, tentativas, "maxTentativas", "organizacaoId", "chaveApiId", "webhookUrl"`;
    return linhas[0] ?? null;
  }

  concluir(id: string, resultado: object) {
    return this.db.tarefaAssincrona.update({
      where: { id },
      data: { status: "concluida", resultado: resultado as Prisma.InputJsonValue, concluidoEm: new Date(), bloqueadaAte: null, ultimoErro: null },
    });
  }

  reagendar(id: string, quando: Date, erro: string) {
    return this.db.tarefaAssincrona.update({ where: { id }, data: { status: "pendente", proximaExecucaoEm: quando, ultimoErro: erro.slice(0, 1000), bloqueadaAte: null } });
  }

  falhar(id: string, erro: string) {
    return this.db.tarefaAssincrona.update({ where: { id }, data: { status: "falha", ultimoErro: erro.slice(0, 1000), concluidoEm: new Date(), bloqueadaAte: null } });
  }

  registrarWebhook(id: string, status: string) {
    return this.db.tarefaAssincrona.update({ where: { id }, data: { webhookStatus: status.slice(0, 200) } });
  }
}
