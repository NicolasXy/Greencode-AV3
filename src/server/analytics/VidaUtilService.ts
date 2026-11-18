// spiderman
import { AnaliticaRepository, EquipamentoVida } from "../repositories/AnaliticaRepository";
import { arredondar, regressaoLinear } from "./estatistica";
import { ParametrosAnalise } from "./EficienciaService";

/** Nota do estado fisico (5 = novo ... 0 = sucata). A depreciacao e a queda dessa nota ao longo da idade. */
export const NOTA_ESTADO: Record<string, number> = { novo: 5, seminovo: 4, bom: 3, regular: 2, ruim: 1, sucata: 0 };
/** Abaixo desta nota o equipamento e considerado inservivel (entre "ruim"=1 e "sucata"=0). */
export const LIMIAR_INSERVIVEL = 0.5;
export const MINIMO_PONTOS = 5;
const DIA_MS = 86_400_000;
const DESTINOS_FINAIS = ["reciclagem", "descarte_seguro", "revenda"];

export interface ModeloVidaUtil {
  tipo: string;
  modelo: "ols";
  inclinacao: number;
  intercepto: number;
  r2: number;
  amostra: number;
  vidaTotalBrutaDias: number;
  ajusteDias: number;
  vidaTotalPrevistaDias: number;
  vidaRestanteMediaDias: number;
  equipamentosAtivos: number;
  dataPrevistaInservivel: string;
  falhas: { observadas: number; idadeMediaDias: number | null };
}

const norm = (s: string) => s.trim().toLowerCase();
const idadeDias = (de: Date, ate: Date) => Math.max(0, (ate.getTime() - de.getTime()) / DIA_MS);
const emUso = (e: EquipamentoVida) => !DESTINOS_FINAIS.includes(e.status) && e.estadoFisico !== "sucata";

/** Pontos (idade em dias, nota) de um equipamento: estado inicial, cada mudanca de estado e, se ainda em uso, hoje. */
export function pontosDoEquipamento(e: EquipamentoVida, agora: Date): [number, number][] {
  const pts: [number, number][] = [];
  const primeira = e.movimentacoes[0];
  pts.push([0, NOTA_ESTADO[primeira?.estadoDe ?? e.estadoFisico]]);
  for (const m of e.movimentacoes) pts.push([idadeDias(e.criadoEm, m.criadoEm), NOTA_ESTADO[m.estadoPara!]]);
  if (emUso(e)) pts.push([idadeDias(e.criadoEm, agora), NOTA_ESTADO[e.estadoFisico]]);
  return pts;
}

/**
 * Categoria 3 — vida util remanescente. Por tipo de equipamento, ajusta por
 * minimos quadrados a reta  nota = intercepto + inclinacao * idade(dias)  e
 * resolve para nota = LIMIAR: e a vida total esperada. A vida restante de
 * cada equipamento em uso e (vida total prevista - idade atual). Os
 * equipamentos que ja chegaram a "sucata" (falhas) entram como pontos com
 * nota 0 e tambem sao resumidos (quantidade e idade media da falha).
 * `ajustes` (dias, por tipo) e a calibracao aprendida comparando previsoes
 * antigas com a realidade (ver AnaliticaService.avaliarPrevisoes).
 */
export class VidaUtilService {
  constructor(private readonly repo: AnaliticaRepository) {}

  async executar(_p: ParametrosAnalise, agora = new Date()) {
    const equipamentos = await this.repo.equipamentosParaVidaUtil();
    // Calibracao: media dos erros (real - bruta) das ultimas previsoes ja avaliadas de cada tipo.
    const ajustes = new Map<string, number>();
    for (const tipo of new Set(equipamentos.map((e) => norm(e.tipo)))) {
      const erros = await this.repo.errosBrutosRecentes(tipo);
      if (erros.length) ajustes.set(tipo, erros.reduce((a, b) => a + b, 0) / erros.length);
    }
    return VidaUtilService.calcular(equipamentos, agora, ajustes);
  }

  static calcular(equipamentos: EquipamentoVida[], agora: Date, ajustes: Map<string, number>) {
    const porTipo = new Map<string, EquipamentoVida[]>();
    for (const e of equipamentos) porTipo.set(norm(e.tipo), [...(porTipo.get(norm(e.tipo)) ?? []), e]);

    const modelos: ModeloVidaUtil[] = [];
    const semModelo: { tipo: string; motivo: string }[] = [];
    for (const [tipo, lista] of porTipo) {
      const pontos = lista.flatMap((e) => pontosDoEquipamento(e, agora));
      const reg = regressaoLinear(pontos, MINIMO_PONTOS);
      if (!reg) {
        semModelo.push({ tipo, motivo: `dados insuficientes (minimo ${MINIMO_PONTOS} pontos em 2 ou mais idades diferentes)` });
        continue;
      }
      if (reg.inclinacao >= 0) {
        semModelo.push({ tipo, motivo: "sem depreciacao detectavel (a nota nao cai com a idade)" });
        continue;
      }
      const bruta = (LIMIAR_INSERVIVEL - reg.intercepto) / reg.inclinacao;
      const ajuste = ajustes.get(tipo) ?? 0;
      const prevista = Math.max(0, bruta + ajuste);
      const ativos = lista.filter(emUso);
      const restantes = ativos.map((e) => Math.max(0, prevista - idadeDias(e.criadoEm, agora)));
      const restanteMedia = restantes.length ? restantes.reduce((a, b) => a + b, 0) / restantes.length : 0;
      const falhas = lista.filter((e) => e.movimentacoes.some((m) => m.estadoPara === "sucata"));
      const idadesFalha = falhas.map((e) => idadeDias(e.criadoEm, e.movimentacoes.find((m) => m.estadoPara === "sucata")!.criadoEm));
      modelos.push({
        tipo,
        modelo: "ols",
        inclinacao: arredondar(reg.inclinacao, 6),
        intercepto: arredondar(reg.intercepto, 4),
        r2: arredondar(reg.r2, 4),
        amostra: pontos.length,
        vidaTotalBrutaDias: arredondar(bruta),
        ajusteDias: arredondar(ajuste),
        vidaTotalPrevistaDias: arredondar(prevista),
        vidaRestanteMediaDias: arredondar(restanteMedia),
        equipamentosAtivos: ativos.length,
        dataPrevistaInservivel: new Date(agora.getTime() + restanteMedia * DIA_MS).toISOString(),
        falhas: { observadas: falhas.length, idadeMediaDias: idadesFalha.length ? arredondar(idadesFalha.reduce((a, b) => a + b, 0) / idadesFalha.length) : null },
      });
    }
    return { modelos: modelos.sort((a, b) => a.tipo.localeCompare(b.tipo)), semModelo, amostra: equipamentos.length };
  }
}

/** Vida restante (dias) de UM equipamento segundo o modelo do seu tipo; null se o tipo nao tem modelo. */
export function vidaRestanteDe(e: { tipo: string; criadoEm: Date }, modelos: { tipo: string; vidaTotalPrevistaDias: number }[], agora: Date): number | null {
  const m = modelos.find((x) => x.tipo === norm(e.tipo));
  return m ? arredondar(Math.max(0, m.vidaTotalPrevistaDias - idadeDias(e.criadoEm, agora))) : null;
}
