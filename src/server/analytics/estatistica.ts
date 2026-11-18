// spiderman
import * as ss from "simple-statistics";

/**
 * Fronteira unica com a biblioteca estatistica (simple-statistics): todas as
 * analises passam por aqui, entao trocar de biblioteca (ex.: mathjs) mexe em
 * um arquivo so. As funcoes toleram amostras vazias/pequenas (devolvem null
 * em vez de lancar), pois dados de producao raramente chegam completos.
 */
export const arredondar = (n: number, casas = 2): number => Math.round(n * 10 ** casas) / 10 ** casas;

export interface Resumo {
  n: number;
  media: number;
  mediana: number;
  desvio: number;
}

export function resumir(valores: number[], casas = 2): Resumo | null {
  if (valores.length === 0) return null;
  return {
    n: valores.length,
    media: arredondar(ss.mean(valores), casas),
    mediana: arredondar(ss.median(valores), casas),
    desvio: valores.length > 1 ? arredondar(ss.standardDeviation(valores), casas) : 0,
  };
}

export interface RegressaoLinear {
  inclinacao: number;
  intercepto: number;
  r2: number;
}

/**
 * Minimos quadrados ordinarios (y = intercepto + inclinacao * x).
 * Devolve null se faltam pontos ou se todos os x sao iguais (reta indefinida).
 */
export function regressaoLinear(pontos: [number, number][], minimoPontos = 3): RegressaoLinear | null {
  if (pontos.length < minimoPontos) return null;
  if (new Set(pontos.map((p) => p[0])).size < 2) return null;
  const { m, b } = ss.linearRegression(pontos);
  const reta = ss.linearRegressionLine({ m, b });
  // Todos os y iguais: R2 indefinido; a reta horizontal explica 100% do que ha.
  const r2 = new Set(pontos.map((p) => p[1])).size < 2 ? 1 : ss.rSquared(pontos, reta);
  return { inclinacao: m, intercepto: b, r2 };
}
