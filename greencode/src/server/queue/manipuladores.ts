// spiderman
import { AnaliticaService } from "../services/AnaliticaService";
import { RelatorioService } from "../services/RelatorioService";
import { ErroPermanente, Manipulador } from "./Worker";

export const TIPO_RELATORIO_PREDITIVO = "relatorio_preditivo";
export const TIPO_ANALISE_AGENDADA = "analise_agendada";

/** Registro tipo -> funcao. Adicionar um tipo novo de tarefa = acrescentar uma linha aqui. */
export function criarManipuladores(analitica: AnaliticaService, relatorios: RelatorioService): Record<string, Manipulador> {
  return {
    [TIPO_RELATORIO_PREDITIVO]: async (t) => {
      if (!t.organizacaoId) throw new ErroPermanente("Tarefa sem organizacao.");
      return relatorios.gerarPreditivo(t.organizacaoId);
    },
    [TIPO_ANALISE_AGENDADA]: async () => analitica.executarTodas("agendada"),
  };
}
