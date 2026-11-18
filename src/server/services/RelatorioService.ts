// spiderman
import { UnidadeDeTrabalho } from "../db/unidadeDeTrabalho";
import { AnaliticaService } from "./AnaliticaService";
import { estimarValor, montarGrupos } from "../analytics/RentabilidadeService";
import { vidaRestanteDe } from "../analytics/VidaUtilService";
import { ModeloVidaUtil } from "../analytics/VidaUtilService";
import { arredondar } from "../analytics/estatistica";

/** Um modelo de vida util mais novo que isto e reaproveitado (nao recalcula a regressao a cada relatorio de parceiro). */
const IDADE_MAXIMA_MODELO_MS = 24 * 3_600_000;
const DIA_MS = 86_400_000;

export interface LinhaRelatorio {
  equipamentoId: string;
  codigoBarras: string;
  loteId: string;
  tipo: string;
  marca: string | null;
  modelo: string | null;
  estadoFisico: string;
  status: string;
  idadeDias: number;
  vidaRestanteDias: number | null;
  dataPrevistaInservivel: string | null;
  valorRecuperadoCentavos: number | null;
  valorEstimadoCentavos: number | null;
  fonteValorEstimado: string | null;
}

/**
 * Relatorio preditivo completo de uma organizacao (o "relatorio pesado" do
 * enunciado): para cada equipamento ativo, vida util remanescente (modelo
 * global do tipo) e valor de recuperacao (registrado ou estimado).
 */
export class RelatorioService {
  constructor(private readonly uow: UnidadeDeTrabalho, private readonly analitica: AnaliticaService) {}

  async gerarPreditivo(organizacaoId: string, agora = new Date()) {
    const repo = this.uow.simples().analitica;
    let base = await repo.ultimaExecucao("vida_util");
    if (!base || agora.getTime() - base.geradaEm.getTime() > IDADE_MAXIMA_MODELO_MS) base = await this.analitica.executar("vida_util", "tarefa", {}, undefined, agora);
    const modelos = (base.resultado as unknown as { modelos: ModeloVidaUtil[] }).modelos;
    const grupos = montarGrupos(await repo.equipamentosComValor());

    const equipamentos: LinhaRelatorio[] = (await repo.equipamentosDaOrganizacao(organizacaoId)).map((e) => {
      const restante = vidaRestanteDe(e, modelos, agora);
      const est = e.valorRecuperacaoCentavos === null ? estimarValor(e, grupos) : null;
      return {
        equipamentoId: e.id,
        codigoBarras: e.codigoBarrasInterno,
        loteId: e.loteId,
        tipo: e.tipo,
        marca: e.marca,
        modelo: e.modelo,
        estadoFisico: e.estadoFisico,
        status: e.status,
        idadeDias: arredondar((agora.getTime() - e.criadoEm.getTime()) / DIA_MS),
        vidaRestanteDias: restante,
        dataPrevistaInservivel: restante === null ? null : new Date(agora.getTime() + restante * DIA_MS).toISOString(),
        valorRecuperadoCentavos: e.valorRecuperacaoCentavos,
        valorEstimadoCentavos: est?.centavos ?? null,
        fonteValorEstimado: est?.fonte ?? null,
      };
    });
    const soma = (f: (l: LinhaRelatorio) => number | null) => equipamentos.reduce((a, l) => a + (f(l) ?? 0), 0);
    return {
      geradoEm: agora.toISOString(),
      organizacaoId,
      modeloVidaUtilGeradoEm: base.geradaEm.toISOString(),
      resumo: {
        equipamentos: equipamentos.length,
        comPrevisaoDeVidaUtil: equipamentos.filter((l) => l.vidaRestanteDias !== null).length,
        valorRecuperadoTotalCentavos: soma((l) => l.valorRecuperadoCentavos),
        valorEstimadoTotalCentavos: soma((l) => l.valorEstimadoCentavos),
      },
      equipamentos,
    };
  }
}

const COLUNAS_CSV: (keyof LinhaRelatorio)[] = [
  "equipamentoId", "codigoBarras", "loteId", "tipo", "marca", "modelo", "estadoFisico", "status", "idadeDias",
  "vidaRestanteDias", "dataPrevistaInservivel", "valorRecuperadoCentavos", "valorEstimadoCentavos", "fonteValorEstimado",
];

/** CSV (RFC 4180): campos entre aspas quando preciso; valores que comecam com = + - @ ganham apostrofo (anti CSV-injection em planilhas). */
export function relatorioParaCsv(rel: { equipamentos: LinhaRelatorio[] }): string {
  const campo = (v: unknown) => {
    let t = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(t) && typeof v === "string") t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [COLUNAS_CSV.join(","), ...rel.equipamentos.map((l) => COLUNAS_CSV.map((c) => campo(l[c])).join(","))].join("\r\n") + "\r\n";
}
