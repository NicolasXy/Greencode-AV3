// spiderman
import { Db } from "../db/prisma";

/** Persistencia das chaves de API dos parceiros. O segredo nunca e lido nem gravado: so o hash. */
export class ChaveApiRepository {
  constructor(private readonly db: Db) {}

  criar(d: { nome: string; prefixo: string; hashSegredo: string; organizacaoId: string; escopos: string[]; limitePorMinuto: number; segredoWebhook: string; expiraEm: Date | null; criadaPorId: string }) {
    return this.db.chaveApi.create({ data: d });
  }

  buscarPorPrefixo(prefixo: string) {
    return this.db.chaveApi.findUnique({ where: { prefixo }, include: { organizacao: { select: { cnpj: true, ativo: true } } } });
  }

  buscarPorId(id: string) {
    return this.db.chaveApi.findUnique({ where: { id } });
  }

  async listar(skip: number, take: number, f: { organizacaoId?: string; ativa?: boolean }) {
    const where = { ...(f.organizacaoId ? { organizacaoId: f.organizacaoId } : {}), ...(f.ativa === undefined ? {} : { ativa: f.ativa }) };
    const [itens, total] = await Promise.all([
      this.db.chaveApi.findMany({ where, orderBy: { criadoEm: "desc" }, skip, take }),
      this.db.chaveApi.count({ where }),
    ]);
    return { itens, total };
  }

  atualizar(id: string, d: { nome?: string; escopos?: string[]; limitePorMinuto?: number; expiraEm?: Date | null }) {
    return this.db.chaveApi.update({ where: { id }, data: d });
  }

  revogar(id: string, agora: Date) {
    return this.db.chaveApi.update({ where: { id }, data: { ativa: false, revogadaEm: agora } });
  }

  /** Atualiza o "ultimo uso" no maximo uma vez por minuto (evita uma escrita por requisicao). */
  async tocarUso(id: string, agora: Date): Promise<void> {
    await this.db.chaveApi.updateMany({
      where: { id, OR: [{ ultimoUsoEm: null }, { ultimoUsoEm: { lt: new Date(agora.getTime() - 60_000) } }] },
      data: { ultimoUsoEm: agora },
    });
  }
}
