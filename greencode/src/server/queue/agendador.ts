// spiderman
import * as cron from "node-cron";
import { TarefaRepository } from "../repositories/TarefaRepository";
import { TIPO_ANALISE_AGENDADA } from "./manipuladores";

/**
 * Agendamento das analises (node-cron). O cron NAO calcula nada: apenas
 * enfileira a tarefa `analise_agendada`; quem calcula e o worker (retry,
 * lease e logs de graca). A `chaveUnica` (tipo + minuto) faz o INSERT ser
 * ignorado quando varias instancias disparam juntas: roda uma vez so.
 * Expressao cron padrao de 5 campos (ex.: "0 3 * * *" = todo dia as 03:00).
 */
export function agendarAnalises(expressao: string, enfileirar: () => TarefaRepository, maxTentativas: number, fusoHorario?: string): { parar: () => void } {
  if (!cron.validate(expressao)) throw new Error(`ANALISE_CRON invalida: "${expressao}"`);
  const tarefa = cron.schedule(
    expressao,
    () => {
      const minuto = new Date().toISOString().substring(0, 16);
      void enfileirar().enfileirar({ tipo: TIPO_ANALISE_AGENDADA, maxTentativas, chaveUnica: `${TIPO_ANALISE_AGENDADA}:${minuto}` }).catch(() => undefined);
    },
    fusoHorario ? { timezone: fusoHorario } : undefined
  );
  return { parar: () => void tarefa.stop() };
}
