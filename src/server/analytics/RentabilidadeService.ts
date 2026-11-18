// spiderman
import { AnaliticaRepository } from "../repositories/AnaliticaRepository";
import { resumir } from "./estatistica";
import { ParametrosAnalise } from "./EficienciaService";

export interface GrupoValor {
  media: number;
  n: number;
}
export type ChaveGrupo = string;
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
export const chaveModelo = (e: { tipo: string; estadoFisico: string; marca?: string | null; modelo?: string | null }) =>
  `m|${norm(e.tipo)}|${e.estadoFisico}|${norm(e.marca)}|${norm(e.modelo)}`;
export const chaveMarca = (e: { tipo: string; estadoFisico: string; marca?: string | null }) => `b|${norm(e.tipo)}|${e.estadoFisico}|${norm(e.marca)}`;
export const chaveTipoEstado = (e: { tipo: string; estadoFisico: string }) => `s|${norm(e.tipo)}|${e.estadoFisico}`;
export const chaveTipo = (e: { tipo: string }) => `t|${norm(e.tipo)}`;

/**
 * Estima o valor de recuperacao de um equipamento ainda sem valor registrado,
 * do dado mais especifico para o mais geral: tipo+estado+marca+modelo ->
 * tipo+estado+marca -> tipo+estado -> tipo. Devolve null se o tipo nunca teve
 * valor registrado (sem historico nao se inventa preco).
 */
export function estimarValor(
  e: { tipo: string; estadoFisico: string; marca?: string | null; modelo?: string | null },
  grupos: Map<ChaveGrupo, GrupoValor>
): { centavos: number; fonte: "modelo" | "marca" | "tipo_estado" | "tipo" } | null {
  const tentativas: ["modelo" | "marca" | "tipo_estado" | "tipo", ChaveGrupo][] = [
    ["modelo", chaveModelo(e)],
    ["marca", chaveMarca(e)],
    ["tipo_estado", chaveTipoEstado(e)],
    ["tipo", chaveTipo(e)],
  ];
  for (const [fonte, chave] of tentativas) {
    const g = grupos.get(chave);
    if (g) return { centavos: Math.round(g.media), fonte };
  }
  return null;
}

/** Monta os grupos de media a partir dos equipamentos que tem valor recuperado registrado. */
export function montarGrupos(
  linhas: { tipo: string; estadoFisico: string; marca: string | null; modelo: string | null; valorRecuperacaoCentavos: number | null }[]
): Map<ChaveGrupo, GrupoValor> {
  const acum = new Map<ChaveGrupo, number[]>();
  for (const l of linhas) {
    if (l.valorRecuperacaoCentavos === null) continue;
    for (const k of [chaveModelo(l), chaveMarca(l), chaveTipoEstado(l), chaveTipo(l)]) acum.set(k, [...(acum.get(k) ?? []), l.valorRecuperacaoCentavos]);
  }
  return new Map([...acum].map(([k, v]) => [k, { media: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }]));
}

/**
 * Categoria 2 — rentabilidade por tipo de equipamento: valor medio de
 * recuperacao (em centavos) por tipo e por combinacao tipo/estado/marca/modelo,
 * com ranking para priorizar os equipamentos de maior retorno.
 */
export class RentabilidadeService {
  constructor(private readonly repo: AnaliticaRepository) {}

  async executar(p: ParametrosAnalise) {
    const linhas = await this.repo.equipamentosComValor(p.desde ? new Date(p.desde) : undefined);
    const por = <T extends string>(chave: (l: (typeof linhas)[number]) => T) => {
      const m = new Map<T, number[]>();
      for (const l of linhas) m.set(chave(l), [...(m.get(chave(l)) ?? []), l.valorRecuperacaoCentavos!]);
      return m;
    };
    const porTipo = [...por((l) => norm(l.tipo))]
      .map(([tipo, v]) => ({ tipo, ...este(resumir(v, 0)!) }))
      .sort((a, b) => b.mediaCentavos - a.mediaCentavos)
      .map((x, i) => ({ ranking: i + 1, ...x }));
    const porGrupo = [...por((l) => `${norm(l.tipo)}|${l.estadoFisico}|${norm(l.marca)}|${norm(l.modelo)}`)]
      .map(([k, v]) => {
        const [tipo, estadoFisico, marca, modelo] = k.split("|");
        return { tipo, estadoFisico, marca: marca || null, modelo: modelo || null, ...este(resumir(v, 0)!) };
      })
      .sort((a, b) => b.mediaCentavos - a.mediaCentavos);
    const todos = resumir(linhas.map((l) => l.valorRecuperacaoCentavos!), 0);
    return {
      resumo: todos && { equipamentosComValor: todos.n, mediaCentavos: todos.media, medianaCentavos: todos.mediana, totalCentavos: linhas.reduce((a, l) => a + l.valorRecuperacaoCentavos!, 0) },
      porTipo,
      porGrupo,
      amostra: linhas.length,
    };
  }
}

const este = (r: { n: number; media: number; mediana: number; desvio: number }) => ({ amostra: r.n, mediaCentavos: r.media, medianaCentavos: r.mediana, desvioCentavos: r.desvio });
