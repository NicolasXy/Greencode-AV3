// spiderman
import * as crypto from "crypto";
import { UnidadeDeTrabalho } from "../db/unidadeDeTrabalho";
import { ValidadorCNPJ } from "../../validation/ValidadorCNPJ";
import { ErroValidacao } from "../../types";
import { ErroConflito, ErroNaoAutenticado, ErroNaoEncontrado } from "../errors";
import { Ator, Paginacao, paraSkipTake } from "./tipos";

/** Permissoes que uma chave pode ter. `lotes:escrever` inclui `lotes:ler`. */
export const ESCOPOS = ["rastreabilidade:ler", "lotes:ler", "lotes:escrever", "relatorios:gerar"] as const;
export type Escopo = (typeof ESCOPOS)[number];

/** Identidade de um parceiro autenticado pela chave (anexada a cada requisicao publica). */
export interface ChaveAutenticada {
  id: string;
  nome: string;
  organizacaoId: string;
  organizacaoCnpj: string;
  escopos: string[];
  limitePorMinuto: number;
  criadaPorId: string;
}

export function temEscopo(escopos: string[], exigido: Escopo): boolean {
  return escopos.includes(exigido) || (exigido === "lotes:ler" && escopos.includes("lotes:escrever"));
}

const sha256 = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const PREFIXO_CHAVE = "gck";
// Hash de uma chave inexistente: a comparacao roda mesmo sem a linha, para o tempo de resposta nao revelar prefixos validos.
const HASH_FALSO = sha256("chave-inexistente");

/** Remove o hash e o segredo de webhook: o que pode ser listado/mostrado depois da criacao. */
function publico<T extends { hashSegredo: string; segredoWebhook: string }>(c: T): Omit<T, "hashSegredo" | "segredoWebhook"> {
  const { hashSegredo: _h, segredoWebhook: _s, ...resto } = c;
  return resto;
}

/**
 * Modulo de chaves de API (parte do servico de autenticacao): gera uma chave
 * unica por parceiro, com escopos e limite de requisicoes proprios.
 * Formato: gck_<prefixo 8 hex>_<segredo base64url 32 chars>. O segredo tem
 * 192 bits aleatorios; por isso basta SHA-256 (bcrypt e para senhas humanas,
 * de baixa entropia) e a chave completa so aparece UMA vez, na criacao.
 */
export class ChaveApiService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  private validarEscopos(escopos: string[]): string[] {
    const unicos = [...new Set(escopos)];
    if (unicos.length === 0) throw new ErroValidacao("Informe ao menos um escopo.");
    const invalidos = unicos.filter((e) => !(ESCOPOS as readonly string[]).includes(e));
    if (invalidos.length) throw new ErroValidacao(`Escopo(s) invalido(s): ${invalidos.join(", ")}. Validos: ${ESCOPOS.join(", ")}.`);
    return unicos;
  }

  async criar(ator: Ator, d: { nome: string; orgCnpj: string; escopos: string[]; limitePorMinuto?: number; expiraEm?: string }) {
    const nome = d.nome?.trim();
    if (!nome) throw new ErroValidacao("O nome do parceiro/chave e obrigatorio.");
    const escopos = this.validarEscopos(d.escopos);
    const limite = d.limitePorMinuto ?? 60;
    if (!Number.isInteger(limite) || limite < 1 || limite > 100000) throw new ErroValidacao("limitePorMinuto deve ser inteiro entre 1 e 100000.");
    const expiraEm = d.expiraEm ? new Date(d.expiraEm) : null;
    if (expiraEm && (Number.isNaN(expiraEm.getTime()) || expiraEm.getTime() <= Date.now())) throw new ErroValidacao("expiraEm deve ser uma data futura valida.");
    const cnpj = new ValidadorCNPJ().normalizarEValidar(d.orgCnpj);

    const prefixo = crypto.randomBytes(4).toString("hex");
    const segredo = crypto.randomBytes(24).toString("base64url");
    const chave = `${PREFIXO_CHAVE}_${prefixo}_${segredo}`;
    const segredoWebhook = crypto.randomBytes(32).toString("hex");

    return this.uow.transacao(async (r) => {
      const org = await r.organizacoes.buscarPorCnpj(cnpj);
      if (!org) throw new ErroNaoEncontrado(`Organizacao com CNPJ ${cnpj} nao encontrada.`);
      if (!org.ativo) throw new ErroConflito("A organizacao esta inativa.");
      const criada = await r.chavesApi.criar({ nome, prefixo, hashSegredo: sha256(chave), organizacaoId: org.id, escopos, limitePorMinuto: limite, segredoWebhook, expiraEm, criadaPorId: ator.id });
      await r.auditoria.registrar(ator.id, "CHAVE_API_CRIADA", { chaveApiId: criada.id, nome, cnpj, escopos, limitePorMinuto: limite });
      // Unica resposta que contem a chave e o segredo do webhook.
      return { ...publico(criada), chave, segredoWebhook };
    });
  }

  async listar(p: Paginacao, f: { organizacaoId?: string; ativa?: boolean }) {
    const { skip, take } = paraSkipTake(p);
    const r = await this.uow.simples().chavesApi.listar(skip, take, f);
    return { itens: r.itens.map(publico), total: r.total };
  }

  async obter(id: string) {
    const c = await this.uow.simples().chavesApi.buscarPorId(id);
    if (!c) throw new ErroNaoEncontrado(`Chave de API ${id} nao encontrada.`);
    return publico(c);
  }

  async atualizar(ator: Ator, id: string, d: { nome?: string; escopos?: string[]; limitePorMinuto?: number; expiraEm?: string | null }) {
    const dados: { nome?: string; escopos?: string[]; limitePorMinuto?: number; expiraEm?: Date | null } = {};
    if (d.nome !== undefined) {
      if (!d.nome.trim()) throw new ErroValidacao("O nome nao pode ser vazio.");
      dados.nome = d.nome.trim();
    }
    if (d.escopos !== undefined) dados.escopos = this.validarEscopos(d.escopos);
    if (d.limitePorMinuto !== undefined) {
      if (!Number.isInteger(d.limitePorMinuto) || d.limitePorMinuto < 1 || d.limitePorMinuto > 100000) throw new ErroValidacao("limitePorMinuto deve ser inteiro entre 1 e 100000.");
      dados.limitePorMinuto = d.limitePorMinuto;
    }
    if (d.expiraEm !== undefined) dados.expiraEm = d.expiraEm === null ? null : new Date(d.expiraEm);
    return this.uow.transacao(async (r) => {
      const atual = await r.chavesApi.buscarPorId(id);
      if (!atual) throw new ErroNaoEncontrado(`Chave de API ${id} nao encontrada.`);
      if (!atual.ativa) throw new ErroConflito("A chave esta revogada e nao pode ser alterada.");
      const nova = await r.chavesApi.atualizar(id, dados);
      await r.auditoria.registrar(ator.id, "CHAVE_API_ATUALIZADA", { chaveApiId: id, ...d });
      return publico(nova);
    });
  }

  async revogar(ator: Ator, id: string) {
    return this.uow.transacao(async (r) => {
      const atual = await r.chavesApi.buscarPorId(id);
      if (!atual) throw new ErroNaoEncontrado(`Chave de API ${id} nao encontrada.`);
      if (!atual.ativa) throw new ErroConflito("A chave ja esta revogada.");
      const nova = await r.chavesApi.revogar(id, new Date());
      await r.auditoria.registrar(ator.id, "CHAVE_API_REVOGADA", { chaveApiId: id, nome: atual.nome });
      return publico(nova);
    });
  }

  /** Valida a chave recebida no cabecalho X-API-Key. Qualquer falha gera a mesma mensagem generica (401). */
  async autenticar(chave: string | undefined): Promise<ChaveAutenticada> {
    const negar = () => new ErroNaoAutenticado("Chave de API ausente, invalida, expirada ou revogada.");
    // O segredo e base64url e pode conter "_": so o prefixo (8 hex) e separado.
    const m = /^gck_([0-9a-f]{8})_[A-Za-z0-9_-]{16,64}$/.exec(chave ?? "");
    if (!m) throw negar();
    const repo = this.uow.simples().chavesApi;
    const linha = await repo.buscarPorPrefixo(m[1]);
    const recebido = Buffer.from(sha256(chave!), "hex");
    const esperado = Buffer.from(linha?.hashSegredo ?? HASH_FALSO, "hex");
    const confere = crypto.timingSafeEqual(recebido, esperado);
    const agora = new Date();
    if (!linha || !confere || !linha.ativa || linha.revogadaEm || (linha.expiraEm && linha.expiraEm <= agora) || !linha.organizacao.ativo) throw negar();
    await repo.tocarUso(linha.id, agora);
    return { id: linha.id, nome: linha.nome, organizacaoId: linha.organizacaoId, organizacaoCnpj: linha.organizacao.cnpj, escopos: linha.escopos, limitePorMinuto: linha.limitePorMinuto, criadaPorId: linha.criadaPorId };
  }
}
