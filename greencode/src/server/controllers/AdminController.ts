// spiderman
import { FastifyReply, FastifyRequest } from "fastify";
import { StatusTarefa, TipoAnalise } from "../generated/prisma/enums";
import { AnaliticaService } from "../services/AnaliticaService";
import { ChaveApiService } from "../services/ChaveApiService";
import { TarefaService, tarefaDto } from "../services/TarefaService";
import { lerPaginacao, paginado } from "./util";

type Pag = { pagina?: number; tamanhoPagina?: number };

/** Tipos de analise como aparecem na URL (kebab-case) -> enum do banco. */
export const TIPOS_ANALISE_URL: Record<string, TipoAnalise> = {
  eficiencia: "eficiencia_operacional",
  rentabilidade: "rentabilidade",
  "vida-util": "vida_util",
};

/** Endpoints administrativos (/api/v1/admin): camada analitica, chaves de API e fila. */
export class AdminController {
  constructor(
    private readonly analitica: AnaliticaService,
    private readonly chaves: ChaveApiService,
    private readonly tarefas: TarefaService
  ) {}

  // ---------- Analises ----------
  executarAnalise = async (req: FastifyRequest<{ Params: { tipo: string }; Body: { desde?: string } | undefined }>, reply: FastifyReply) =>
    reply.status(201).send(await this.analitica.executar(TIPOS_ANALISE_URL[req.params.tipo], "manual", { desde: req.body?.desde }, req.ator.id));

  listarRelatorios = async (req: FastifyRequest<{ Querystring: Pag & { tipo?: string } }>) => {
    const p = lerPaginacao(req.query);
    return paginado(await this.analitica.listar(p, req.query.tipo ? TIPOS_ANALISE_URL[req.query.tipo] : undefined), p);
  };

  obterRelatorio = async (req: FastifyRequest<{ Params: { id: string } }>) => this.analitica.obter(req.params.id);

  ultimoRelatorio = async (req: FastifyRequest<{ Params: { tipo: string } }>) => this.analitica.ultimo(TIPOS_ANALISE_URL[req.params.tipo]);

  avaliarPrevisoes = async () => this.analitica.avaliarPrevisoes();

  listarPrevisoes = async (req: FastifyRequest<{ Querystring: Pag & { tipoEquipamento?: string; avaliadas?: boolean } }>) => {
    const p = lerPaginacao(req.query);
    return paginado(await this.analitica.listarPrevisoes(p, { tipoEquipamento: req.query.tipoEquipamento, avaliadas: req.query.avaliadas }), p);
  };

  acuracia = async () => ({ porTipo: await this.analitica.acuracia() });

  // ---------- Chaves de API ----------
  criarChave = async (
    req: FastifyRequest<{ Body: { nome: string; orgCnpj: string; escopos: string[]; limitePorMinuto?: number; expiraEm?: string } }>,
    reply: FastifyReply
  ) => reply.status(201).send(await this.chaves.criar(req.ator, req.body));

  listarChaves = async (req: FastifyRequest<{ Querystring: Pag & { organizacaoId?: string; ativa?: boolean } }>) => {
    const p = lerPaginacao(req.query);
    return paginado(await this.chaves.listar(p, { organizacaoId: req.query.organizacaoId, ativa: req.query.ativa }), p);
  };

  obterChave = async (req: FastifyRequest<{ Params: { id: string } }>) => this.chaves.obter(req.params.id);

  atualizarChave = async (req: FastifyRequest<{ Params: { id: string }; Body: { nome?: string; escopos?: string[]; limitePorMinuto?: number; expiraEm?: string | null } }>) =>
    this.chaves.atualizar(req.ator, req.params.id, req.body);

  revogarChave = async (req: FastifyRequest<{ Params: { id: string } }>) => this.chaves.revogar(req.ator, req.params.id);

  // ---------- Fila ----------
  listarTarefas = async (req: FastifyRequest<{ Querystring: Pag & { status?: StatusTarefa; tipo?: string } }>) => {
    const p = lerPaginacao(req.query);
    const r = await this.tarefas.listar(p, { status: req.query.status, tipo: req.query.tipo });
    return paginado({ itens: r.itens.map(tarefaDto), total: r.total }, p);
  };

  obterTarefa = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const t = await this.tarefas.obter(req.params.id);
    return { ...tarefaDto(t), parametros: t.parametros, resultado: t.resultado };
  };

  enfileirarAnalise = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = await this.tarefas.solicitarAnaliseCompleta(req.ator);
    return reply.status(202).send(tarefaDto(t));
  };
}
