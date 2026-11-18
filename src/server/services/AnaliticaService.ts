// spiderman
import { UnidadeDeTrabalho } from "../db/unidadeDeTrabalho";
import { OrigemAnalise, TipoAnalise } from "../generated/prisma/enums";
import { ErroValidacao } from "../../types";
import { ErroNaoEncontrado } from "../errors";
import { EficienciaService, ParametrosAnalise } from "../analytics/EficienciaService";
import { RentabilidadeService } from "../analytics/RentabilidadeService";
import { VidaUtilService } from "../analytics/VidaUtilService";
import { arredondar } from "../analytics/estatistica";
import { Paginacao, paraSkipTake } from "./tipos";

/**
 * Fachada da camada analitica: executa um dos tres servicos independentes,
 * grava o resultado no historico (AnaliseExecucao; as previsoes de vida util
 * tambem em PrevisaoVidaUtil) e oferece consulta historica, a comparacao
 * previsto x real e a acuracia por tipo. Usada pelos endpoints, pelo agendador
 * (cron) e pelos handlers da fila.
 */
export class AnaliticaService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  async executar(tipo: TipoAnalise, origem: OrigemAnalise, params: ParametrosAnalise = {}, geradaPorId?: string, agora = new Date()) {
    if (params.desde && Number.isNaN(new Date(params.desde).getTime())) throw new ErroValidacao("'desde' deve ser uma data ISO valida.");
    const repo = this.uow.simples().analitica;
    const t0 = Date.now();
    let resultado: { amostra: number };
    if (tipo === "eficiencia_operacional") resultado = await new EficienciaService(repo).executar(params);
    else if (tipo === "rentabilidade") resultado = await new RentabilidadeService(repo).executar(params);
    else resultado = await new VidaUtilService(repo).executar(params, agora);
    const duracaoMs = Date.now() - t0;

    return this.uow.transacao(async (r) => {
      const execucao = await r.analitica.criarExecucao({ tipo, origem, parametros: params, resultado, amostra: resultado.amostra, duracaoMs, geradaPorId, geradaEm: agora });
      if (tipo === "vida_util") await r.analitica.criarPrevisoes(execucao.id, agora, (resultado as Awaited<ReturnType<VidaUtilService["executar"]>>).modelos.map((m) => ({ ...m, tipo: m.tipo })));
      await r.auditoria.registrar(geradaPorId ?? null, "ANALISE_EXECUTADA", { execucaoId: execucao.id, tipo, origem });
      return execucao;
    });
  }

  /** Executa as tres analises e depois confronta previsoes antigas com a realidade (usado pelo agendador). */
  async executarTodas(origem: OrigemAnalise, geradaPorId?: string, agora = new Date()) {
    const execucoes = [];
    for (const t of ["eficiencia_operacional", "rentabilidade", "vida_util"] as TipoAnalise[]) execucoes.push(await this.executar(t, origem, {}, geradaPorId, agora));
    const avaliacao = await this.avaliarPrevisoes(agora);
    return { execucoes: execucoes.map((e) => ({ id: e.id, tipo: e.tipo, amostra: e.amostra })), previsoesAvaliadas: avaliacao.avaliadas };
  }

  listar(p: Paginacao, tipo?: TipoAnalise) {
    const { skip, take } = paraSkipTake(p);
    return this.uow.simples().analitica.listarExecucoes(skip, take, tipo);
  }

  async obter(id: string) {
    const e = await this.uow.simples().analitica.obterExecucao(id);
    if (!e) throw new ErroNaoEncontrado(`Relatorio ${id} nao encontrado.`);
    return e;
  }

  async ultimo(tipo: TipoAnalise) {
    const e = await this.uow.simples().analitica.ultimaExecucao(tipo);
    if (!e) throw new ErroNaoEncontrado(`Nenhum relatorio de '${tipo}' foi gerado ainda.`);
    return e;
  }

  /**
   * Compara previsoes pendentes com a realidade: se, depois da previsao,
   * equipamentos do tipo chegaram a "sucata", a vida real media deles (dias da
   * entrada ate a sucata) e gravada junto com o erro. Esses erros alimentam o
   * ajuste de calibracao das proximas previsoes (ver VidaUtilService).
   */
  async avaliarPrevisoes(agora = new Date()) {
    const repo = this.uow.simples().analitica;
    let avaliadas = 0;
    for (const prev of await repo.previsoesPendentes()) {
      const idades = await repo.falhasApos(prev.tipoEquipamento, prev.geradaEm);
      if (idades.length === 0) continue;
      const real = idades.reduce((a, b) => a + b, 0) / idades.length;
      await repo.avaliarPrevisao(prev.id, { avaliadaEm: agora, vidaTotalRealDias: arredondar(real), erroDias: arredondar(real - prev.vidaTotalPrevistaDias), falhasObservadas: idades.length });
      avaliadas++;
    }
    return { avaliadas, pendentes: (await repo.previsoesPendentes()).length };
  }

  listarPrevisoes(p: Paginacao, f: { tipoEquipamento?: string; avaliadas?: boolean }) {
    const { skip, take } = paraSkipTake(p);
    return this.uow.simples().analitica.listarPrevisoes(skip, take, f);
  }

  /** Acuracia por tipo: erro medio (vies), erro absoluto medio e percentual medio sobre as previsoes ja avaliadas. */
  async acuracia() {
    const linhas = await this.uow.simples().analitica.previsoesAvaliadas();
    const porTipo = new Map<string, typeof linhas>();
    for (const l of linhas) porTipo.set(l.tipoEquipamento, [...(porTipo.get(l.tipoEquipamento) ?? []), l]);
    return [...porTipo].map(([tipo, v]) => {
      const erros = v.map((x) => x.erroDias!);
      const media = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      return {
        tipo,
        previsoesAvaliadas: v.length,
        erroMedioDias: arredondar(media(erros)),
        erroAbsolutoMedioDias: arredondar(media(erros.map(Math.abs))),
        erroPercentualMedio: arredondar(media(v.map((x) => (x.vidaTotalRealDias! > 0 ? (Math.abs(x.erroDias!) / x.vidaTotalRealDias!) * 100 : 0))), 1),
      };
    });
  }
}
