// spiderman
import { UnidadeDeTrabalho } from "../db/unidadeDeTrabalho";
import { Prisma } from "../db/prisma";
import { StatusTarefa } from "../generated/prisma/enums";
import { ErroConflito, ErroNaoEncontrado } from "../errors";
import { TIPO_ANALISE_AGENDADA, TIPO_RELATORIO_PREDITIVO } from "../queue/manipuladores";
import { validarUrlWebhook } from "../queue/webhook";
import { ChaveAutenticada } from "./ChaveApiService";
import { Ator, Paginacao, paraSkipTake } from "./tipos";

/** Maximo de relatorios preditivos "em aberto" (pendentes ou processando) por organizacao. */
export const MAX_RELATORIOS_ABERTOS = 5;

type LinhaTarefa = Prisma.TarefaAssincronaGetPayload<object>;

/** Visao publica de uma tarefa (sem o resultado, que tem endpoint proprio, e sem dados internos). */
export function tarefaDto(t: Omit<LinhaTarefa, "resultado"> & { resultado?: unknown }) {
  return {
    id: t.id,
    tipo: t.tipo,
    status: t.status,
    tentativas: t.tentativas,
    maxTentativas: t.maxTentativas,
    criadoEm: t.criadoEm,
    iniciadoEm: t.iniciadoEm,
    concluidoEm: t.concluidoEm,
    erro: t.status === "falha" ? t.ultimoErro : null,
    webhookStatus: t.webhookStatus,
  };
}

export class TarefaService {
  constructor(private readonly uow: UnidadeDeTrabalho, private readonly opcoes: { maxTentativas: number; webhookRedePrivada: boolean }) {}

  /** Parceiro pede o relatorio preditivo: enfileira e devolve na hora o identificador (padrao assincrono). */
  async solicitarRelatorioPreditivo(chave: ChaveAutenticada, webhookUrl?: string) {
    if (webhookUrl) validarUrlWebhook(webhookUrl, this.opcoes.webhookRedePrivada);
    const repo = this.uow.simples().tarefas;
    if ((await repo.contarAtivas(chave.organizacaoId, TIPO_RELATORIO_PREDITIVO)) >= MAX_RELATORIOS_ABERTOS) {
      throw new ErroConflito(`Ja existem ${MAX_RELATORIOS_ABERTOS} relatorios em processamento para esta organizacao; aguarde a conclusao.`);
    }
    const t = await repo.enfileirar({ tipo: TIPO_RELATORIO_PREDITIVO, organizacaoId: chave.organizacaoId, chaveApiId: chave.id, webhookUrl, maxTentativas: this.opcoes.maxTentativas });
    return t!;
  }

  /** Enfileira a analise completa a pedido do admin (a mesma que o agendador dispara). */
  async solicitarAnaliseCompleta(ator: Ator) {
    const t = await this.uow.transacao(async (r) => {
      const nova = await r.tarefas.enfileirar({ tipo: TIPO_ANALISE_AGENDADA, maxTentativas: this.opcoes.maxTentativas });
      await r.auditoria.registrar(ator.id, "TAREFA_ANALISE_ENFILEIRADA", { tarefaId: nova!.id });
      return nova!;
    });
    return t;
  }

  /** Tarefa do parceiro (de qualquer chave da mesma organizacao). Outra organizacao => 404, sem revelar que existe. */
  async obterDoParceiro(chave: ChaveAutenticada, id: string) {
    const t = await this.uow.simples().tarefas.buscarPorId(id);
    if (!t || t.organizacaoId !== chave.organizacaoId || t.tipo !== TIPO_RELATORIO_PREDITIVO) throw new ErroNaoEncontrado(`Tarefa ${id} nao encontrada.`);
    return t;
  }

  async obter(id: string) {
    const t = await this.uow.simples().tarefas.buscarPorId(id);
    if (!t) throw new ErroNaoEncontrado(`Tarefa ${id} nao encontrada.`);
    return t;
  }

  listar(p: Paginacao, f: { status?: StatusTarefa; tipo?: string }) {
    const { skip, take } = paraSkipTake(p);
    return this.uow.simples().tarefas.listar(skip, take, f);
  }
}
