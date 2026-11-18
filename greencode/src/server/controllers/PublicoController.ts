// spiderman
import { FastifyReply, FastifyRequest } from "fastify";
import { PublicoService } from "../services/PublicoService";
import { StatusLote } from "../generated/prisma/enums";
import { EquipamentoService } from "../services/EquipamentoService";
import { LoteService } from "../services/LoteService";
import { TarefaService, tarefaDto } from "../services/TarefaService";
import { relatorioParaCsv } from "../services/RelatorioService";
import { ErroConflito, ErroNaoEncontrado } from "../errors";
import { Ator } from "../services/tipos";
import { lerPaginacao, paginado } from "./util";

type Pag = { pagina?: number; tamanhoPagina?: number };

/** Visoes publicas: so campos de negocio do parceiro (sem versao, ids de usuario ou dados internos). */
const equipamentoDto = (e: { id: string; codigoBarrasInterno: string; loteId: string; posicao: number; tipo: string; marca: string | null; modelo: string | null; estadoFisico: string; status: string; triagemCompleta: boolean; valorRecuperacaoCentavos: number | null; criadoEm: Date; atualizadoEm: Date }) => ({
  id: e.id, codigoBarras: e.codigoBarrasInterno, loteId: e.loteId, posicao: e.posicao, tipo: e.tipo, marca: e.marca, modelo: e.modelo,
  estadoFisico: e.estadoFisico, status: e.status, triagemCompleta: e.triagemCompleta, valorRecuperacaoCentavos: e.valorRecuperacaoCentavos,
  criadoEm: e.criadoEm, atualizadoEm: e.atualizadoEm,
});
const loteDto = (l: { id: string; nf: string; transportadora: string; dataEntrada: Date; status: string; criadoEm: Date; triagemConcluidaEm: Date | null; organizacao: { cnpj: string; razaoSocial: string } }) => ({
  id: l.id, nf: l.nf, transportadora: l.transportadora, dataEntrada: l.dataEntrada.toISOString().substring(0, 10), status: l.status,
  criadoEm: l.criadoEm, triagemConcluidaEm: l.triagemConcluidaEm, organizacao: { cnpj: l.organizacao.cnpj, razaoSocial: l.organizacao.razaoSocial },
});

/**
 * Endpoints da API publica (/api/v1/public). TODA consulta e restrita a
 * organizacao dona da chave: recurso de outra organizacao responde 404
 * (nunca 403), para nao revelar que ele existe.
 */
export class PublicoController {
  constructor(
    private readonly acesso: PublicoService,
    private readonly lotes: LoteService,
    private readonly equipamentos: EquipamentoService,
    private readonly tarefas: TarefaService
  ) {}

  /** Identidade sintetica das gravacoes via API: criada pelo admin que emitiu a chave, com papel de almoxarifado. */
  private ator(req: FastifyRequest): Ator {
    return { id: req.chaveApi.criadaPorId, username: `api:${req.chaveApi.nome}`, papel: "almoxarifado" };
  }

  private loteDaOrganizacao(req: FastifyRequest, loteId: string) {
    return this.acesso.loteDaOrganizacao(req.chaveApi, loteId);
  }

  eu = async (req: FastifyRequest) => {
    const c = req.chaveApi;
    return { nome: c.nome, organizacaoCnpj: c.organizacaoCnpj, escopos: c.escopos, limitePorMinuto: c.limitePorMinuto };
  };

  // ---------- rastreabilidade:ler ----------
  rastreioEquipamento = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const { equipamento, movimentacoes } = await this.equipamentos.rastreio(req.params.id);
    await this.loteDaOrganizacao(req, equipamento.loteId);
    return {
      equipamento: equipamentoDto(equipamento),
      movimentacoes: movimentacoes.map((m) => ({ id: m.id, statusDe: m.statusDe, statusPara: m.statusPara, estadoDe: m.estadoDe, estadoPara: m.estadoPara, justificativa: m.justificativa, criadoEm: m.criadoEm })),
    };
  };

  rastreioLote = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const l = await this.loteDaOrganizacao(req, req.params.id);
    return { ...loteDto(l), equipamentos: l.equipamentos.map(equipamentoDto) };
  };

  // ---------- lotes:ler / lotes:escrever ----------
  listarLotes = async (req: FastifyRequest<{ Querystring: Pag & { status?: StatusLote } }>) => {
    const p = lerPaginacao(req.query);
    const r = await this.lotes.listar(p, { status: req.query.status, cnpj: req.chaveApi.organizacaoCnpj });
    return paginado({ itens: r.itens.map((l) => ({ ...loteDto(l), totalEquipamentos: l._count.equipamentos })), total: r.total }, p);
  };

  obterLote = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const l = await this.loteDaOrganizacao(req, req.params.id);
    return { ...loteDto(l), equipamentos: l.equipamentos.map(equipamentoDto) };
  };

  criarLote = async (
    req: FastifyRequest<{ Body: { nf: string; transportadora: string; dataEntrada?: string; equipamentos?: { tipo: string; marca?: string; modelo?: string }[] } }>,
    reply: FastifyReply
  ) => {
    const { lote, equipamentos } = await this.lotes.criar(this.ator(req), { ...req.body, orgCnpj: req.chaveApi.organizacaoCnpj });
    await this.acesso.registrarLoteCriado(req.chaveApi, lote.id);
    return reply.status(201).send({ ...loteDto(lote), equipamentos: equipamentos.map(equipamentoDto) });
  };

  // ---------- relatorios:gerar ----------
  solicitarRelatorio = async (req: FastifyRequest<{ Body: { webhookUrl?: string } | undefined }>, reply: FastifyReply) => {
    const t = await this.tarefas.solicitarRelatorioPreditivo(req.chaveApi, req.body?.webhookUrl);
    return reply
      .status(202)
      .header("location", `/api/v1/public/tarefas/${t.id}`)
      .send({ tarefaId: t.id, status: t.status, statusUrl: `/api/v1/public/tarefas/${t.id}`, resultadoUrl: `/api/v1/public/tarefas/${t.id}/resultado` });
  };

  statusTarefa = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const t = await this.tarefas.obterDoParceiro(req.chaveApi, req.params.id);
    return { ...tarefaDto(t), resultadoUrl: t.status === "concluida" ? `/api/v1/public/tarefas/${t.id}/resultado` : null };
  };

  resultadoTarefa = async (req: FastifyRequest<{ Params: { id: string }; Querystring: { formato?: "json" | "csv" } }>, reply: FastifyReply) => {
    const t = await this.tarefas.obterDoParceiro(req.chaveApi, req.params.id);
    if (t.status === "falha") throw new ErroConflito(`O relatorio falhou: ${t.ultimoErro ?? "erro desconhecido"}.`);
    if (t.status !== "concluida") throw new ErroConflito(`O relatorio ainda nao esta pronto (status: ${t.status}). Consulte o status e tente novamente.`);
    const rel = t.resultado as unknown as { equipamentos: never[] };
    if (req.query.formato === "csv") {
      return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="relatorio-${t.id}.csv"`).send(relatorioParaCsv(rel));
    }
    return rel;
  };
}
