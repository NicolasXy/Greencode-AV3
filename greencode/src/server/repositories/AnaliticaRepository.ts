// spiderman
import { Db, Prisma } from "../db/prisma";
import { OrigemAnalise, TipoAnalise } from "../generated/prisma/enums";

/** Equipamento com seus eventos de estado fisico: matéria-prima da regressao de vida util. */
export interface EquipamentoVida {
  id: string;
  tipo: string;
  estadoFisico: string;
  status: string;
  criadoEm: Date;
  movimentacoes: { estadoDe: string | null; estadoPara: string | null; criadoEm: Date }[];
}

/** Acesso a dados da camada analitica (leituras de agregacao e historico de relatorios/previsoes). */
export class AnaliticaRepository {
  constructor(private readonly db: Db) {}

  // ---------- Leituras para as analises ----------
  lotesComTriagemConcluida(desde?: Date) {
    return this.db.lote.findMany({
      where: { ativo: true, triagemConcluidaEm: { not: null, ...(desde ? { gte: desde } : {}) } },
      select: { dataEntrada: true, triagemConcluidaEm: true, triagemConcluidaPorId: true, triagemPor: { select: { username: true } } },
    });
  }

  async movimentacoesDeStatus(desde?: Date) {
    const linhas = await this.db.movimentacao.findMany({
      where: { statusDe: { not: null }, statusPara: { not: null }, equipamento: { lote: { ativo: true } }, ...(desde ? { criadoEm: { gte: desde } } : {}) },
      orderBy: { criadoEm: "asc" },
      select: { equipamentoId: true, statusDe: true, statusPara: true, criadoEm: true, equipamento: { select: { criadoEm: true } } },
    });
    return linhas.map((l) => ({ equipamentoId: l.equipamentoId, statusDe: l.statusDe!, statusPara: l.statusPara!, criadoEm: l.criadoEm, equipamentoCriadoEm: l.equipamento.criadoEm }));
  }

  equipamentosComValor(desde?: Date) {
    return this.db.equipamento.findMany({
      where: { valorRecuperacaoCentavos: { not: null }, lote: { ativo: true }, ...(desde ? { atualizadoEm: { gte: desde } } : {}) },
      select: { tipo: true, estadoFisico: true, marca: true, modelo: true, valorRecuperacaoCentavos: true },
    });
  }

  async equipamentosParaVidaUtil(): Promise<EquipamentoVida[]> {
    return this.db.equipamento.findMany({
      where: { lote: { ativo: true } },
      select: {
        id: true, tipo: true, estadoFisico: true, status: true, criadoEm: true,
        movimentacoes: { where: { estadoPara: { not: null } }, orderBy: { criadoEm: "asc" }, select: { estadoDe: true, estadoPara: true, criadoEm: true } },
      },
    });
  }

  /** Equipamentos da organizacao (relatorio preditivo do parceiro), com todos os campos usados no relatorio. */
  equipamentosDaOrganizacao(organizacaoId: string) {
    return this.db.equipamento.findMany({
      where: { lote: { organizacaoId, ativo: true } },
      orderBy: [{ loteId: "asc" }, { posicao: "asc" }],
      select: { id: true, codigoBarrasInterno: true, loteId: true, tipo: true, marca: true, modelo: true, estadoFisico: true, status: true, criadoEm: true, valorRecuperacaoCentavos: true },
    });
  }

  // ---------- Historico de relatorios ----------
  criarExecucao(d: { tipo: TipoAnalise; origem: OrigemAnalise; parametros: object; resultado: object; amostra: number; duracaoMs: number; geradaPorId?: string; geradaEm?: Date }) {
    return this.db.analiseExecucao.create({
      data: { ...d, parametros: d.parametros as Prisma.InputJsonValue, resultado: d.resultado as Prisma.InputJsonValue },
    });
  }

  async listarExecucoes(skip: number, take: number, tipo?: TipoAnalise) {
    const where = tipo ? { tipo } : {};
    const [itens, total] = await Promise.all([
      this.db.analiseExecucao.findMany({
        where, orderBy: { geradaEm: "desc" }, skip, take,
        select: { id: true, tipo: true, origem: true, amostra: true, duracaoMs: true, geradaEm: true, geradaPorId: true },
      }),
      this.db.analiseExecucao.count({ where }),
    ]);
    return { itens, total };
  }

  obterExecucao(id: string) {
    return this.db.analiseExecucao.findUnique({ where: { id } });
  }

  ultimaExecucao(tipo: TipoAnalise) {
    return this.db.analiseExecucao.findFirst({ where: { tipo }, orderBy: { geradaEm: "desc" } });
  }

  // ---------- Previsoes de vida util (comparacao previsto x real) ----------
  criarPrevisoes(execucaoId: string, geradaEm: Date, modelos: { tipo: string; inclinacao: number; intercepto: number; r2: number; amostra: number; vidaTotalBrutaDias: number; ajusteDias: number; vidaTotalPrevistaDias: number; vidaRestanteMediaDias: number; equipamentosAtivos: number }[]) {
    return this.db.previsaoVidaUtil.createMany({
      data: modelos.map((m) => ({
        execucaoId, geradaEm, tipoEquipamento: m.tipo, inclinacao: m.inclinacao, intercepto: m.intercepto, r2: m.r2, amostra: m.amostra,
        vidaTotalBrutaDias: m.vidaTotalBrutaDias, ajusteDias: m.ajusteDias, vidaTotalPrevistaDias: m.vidaTotalPrevistaDias,
        vidaRestanteMediaDias: m.vidaRestanteMediaDias, equipamentosAtivos: m.equipamentosAtivos,
      })),
    });
  }

  previsoesPendentes() {
    return this.db.previsaoVidaUtil.findMany({ where: { avaliadaEm: null }, orderBy: { geradaEm: "asc" } });
  }

  /** Equipamentos do tipo que viraram "sucata" depois de `desde`, com a idade (dias) na falha. */
  async falhasApos(tipo: string, desde: Date) {
    const movs = await this.db.movimentacao.findMany({
      where: { estadoPara: "sucata", criadoEm: { gt: desde }, equipamento: { tipo: { equals: tipo, mode: "insensitive" } } },
      select: { criadoEm: true, equipamento: { select: { criadoEm: true } } },
    });
    return movs.map((m) => (m.criadoEm.getTime() - m.equipamento.criadoEm.getTime()) / 86_400_000);
  }

  avaliarPrevisao(id: string, d: { avaliadaEm: Date; vidaTotalRealDias: number; erroDias: number; falhasObservadas: number }) {
    return this.db.previsaoVidaUtil.update({ where: { id }, data: d });
  }

  /** Erros "brutos" (real - bruta) das ultimas previsoes ja avaliadas do tipo: base do ajuste de calibracao. */
  async errosBrutosRecentes(tipo: string, limite = 5): Promise<number[]> {
    const l = await this.db.previsaoVidaUtil.findMany({
      where: { tipoEquipamento: tipo, avaliadaEm: { not: null } }, orderBy: { avaliadaEm: "desc" }, take: limite,
      select: { vidaTotalRealDias: true, vidaTotalBrutaDias: true },
    });
    return l.map((x) => x.vidaTotalRealDias! - x.vidaTotalBrutaDias);
  }

  async listarPrevisoes(skip: number, take: number, f: { tipoEquipamento?: string; avaliadas?: boolean }) {
    const where = {
      ...(f.tipoEquipamento ? { tipoEquipamento: f.tipoEquipamento.toLowerCase() } : {}),
      ...(f.avaliadas === undefined ? {} : { avaliadaEm: f.avaliadas ? { not: null } : null }),
    };
    const [itens, total] = await Promise.all([
      this.db.previsaoVidaUtil.findMany({ where, orderBy: { geradaEm: "desc" }, skip, take }),
      this.db.previsaoVidaUtil.count({ where }),
    ]);
    return { itens, total };
  }

  previsoesAvaliadas() {
    return this.db.previsaoVidaUtil.findMany({ where: { avaliadaEm: { not: null } }, select: { tipoEquipamento: true, erroDias: true, vidaTotalPrevistaDias: true, vidaTotalRealDias: true } });
  }
}
