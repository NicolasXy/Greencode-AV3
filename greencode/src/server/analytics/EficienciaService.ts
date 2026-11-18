// spiderman
import { AnaliticaRepository } from "../repositories/AnaliticaRepository";
import { arredondar, resumir } from "./estatistica";

const HORA_MS = 3_600_000;

export interface ParametrosAnalise {
  /** Considera so dados a partir desta data (ISO). */
  desde?: string;
}

/**
 * Categoria 1 — eficiencia operacional. Tempo de processamento do lote =
 * da data de entrada ate a conclusao da triagem (Lote.triagemConcluidaEm).
 * Compara operadores (quem concluiu a triagem) e periodos (mes de conclusao)
 * e aponta o gargalo: a etapa (transicao de status dos equipamentos) cuja
 * duracao media e a maior.
 */
export class EficienciaService {
  constructor(private readonly repo: AnaliticaRepository) {}

  async executar(p: ParametrosAnalise) {
    const desde = p.desde ? new Date(p.desde) : undefined;
    const lotes = await this.repo.lotesComTriagemConcluida(desde);
    const horas = (l: (typeof lotes)[number]) => (l.triagemConcluidaEm!.getTime() - l.dataEntrada.getTime()) / HORA_MS;
    const geral = resumir(lotes.map(horas));

    const agrupar = <K extends string>(chave: (l: (typeof lotes)[number]) => K) => {
      const m = new Map<K, number[]>();
      for (const l of lotes) m.set(chave(l), [...(m.get(chave(l)) ?? []), horas(l)]);
      return m;
    };
    const vsGeral = (media: number) => (geral && geral.media > 0 ? arredondar(((media - geral.media) / geral.media) * 100, 1) : 0);

    const porOperador = [...agrupar((l) => l.triagemConcluidaPorId ?? "desconhecido")]
      .map(([id, v]) => {
        const r = resumir(v)!;
        const nome = lotes.find((l) => (l.triagemConcluidaPorId ?? "desconhecido") === id)?.triagemPor?.username ?? "desconhecido";
        return { usuarioId: id === "desconhecido" ? null : id, username: nome, lotes: r.n, tempoMedioHoras: r.media, medianaHoras: r.mediana, desvioHoras: r.desvio, diferencaVsMediaGeralPercent: vsGeral(r.media) };
      })
      .sort((a, b) => b.tempoMedioHoras - a.tempoMedioHoras);

    const porPeriodo = [...agrupar((l) => l.triagemConcluidaEm!.toISOString().substring(0, 7))]
      .map(([periodo, v]) => {
        const r = resumir(v)!;
        return { periodo, lotes: r.n, tempoMedioHoras: r.media, medianaHoras: r.mediana, diferencaVsMediaGeralPercent: vsGeral(r.media) };
      })
      .sort((a, b) => a.periodo.localeCompare(b.periodo));

    // Sazonalidade: mes do ano (1-12) agregando todos os anos, para ver os periodos mais lentos.
    const porMesDoAno = [...agrupar((l) => String(l.triagemConcluidaEm!.getUTCMonth() + 1) as string)]
      .map(([mes, v]) => {
        const r = resumir(v)!;
        return { mes: Number(mes), lotes: r.n, tempoMedioHoras: r.media, diferencaVsMediaGeralPercent: vsGeral(r.media) };
      })
      .sort((a, b) => a.mes - b.mes);

    // Etapas: tempo entre um evento do equipamento (criacao ou movimentacao) e o seguinte.
    const etapas = new Map<string, number[]>();
    for (const [, movs] of this.agruparPorEquipamento(await this.repo.movimentacoesDeStatus(desde))) {
      let anterior = movs[0].equipamentoCriadoEm;
      for (const m of movs) {
        const chave = `${m.statusDe}->${m.statusPara}`;
        etapas.set(chave, [...(etapas.get(chave) ?? []), (m.criadoEm.getTime() - anterior.getTime()) / HORA_MS]);
        anterior = m.criadoEm;
      }
    }
    const porEtapa = [...etapas]
      .map(([transicao, v]) => {
        const r = resumir(v)!;
        return { transicao, ocorrencias: r.n, tempoMedioHoras: r.media, medianaHoras: r.mediana };
      })
      .sort((a, b) => b.tempoMedioHoras - a.tempoMedioHoras);

    return {
      resumo: geral && { lotes: geral.n, tempoMedioHoras: geral.media, medianaHoras: geral.mediana, desvioHoras: geral.desvio },
      porOperador,
      porPeriodo,
      porMesDoAno,
      porEtapa,
      gargalo: porEtapa[0] ? { transicao: porEtapa[0].transicao, tempoMedioHoras: porEtapa[0].tempoMedioHoras } : null,
      operadorMaisLento: porOperador.length > 1 ? porOperador[0].username : null,
      amostra: lotes.length,
    };
  }

  private agruparPorEquipamento<T extends { equipamentoId: string }>(movs: T[]): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const x of movs) m.set(x.equipamentoId, [...(m.get(x.equipamentoId) ?? []), x]);
    return m;
  }
}
