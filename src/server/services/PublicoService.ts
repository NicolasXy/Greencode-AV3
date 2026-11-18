// spiderman
import { UnidadeDeTrabalho } from "../db/unidadeDeTrabalho";
import { ErroNaoEncontrado } from "../errors";
import { ChaveAutenticada } from "./ChaveApiService";

/** Regras de acesso da API publica: tudo e restrito a organizacao dona da chave. */
export class PublicoService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  /** Lote ativo da organizacao da chave. De outra organizacao => 404 (nao revela que existe). */
  async loteDaOrganizacao(chave: ChaveAutenticada, loteId: string) {
    const lote = await this.uow.simples().lotes.buscarDetalhado(loteId);
    if (!lote || !lote.ativo || lote.organizacaoId !== chave.organizacaoId) throw new ErroNaoEncontrado(`Lote ${loteId} nao encontrado.`);
    return lote;
  }

  registrarLoteCriado(chave: ChaveAutenticada, loteId: string) {
    return this.uow.simples().auditoria.registrar(chave.criadaPorId, "API_LOTE_CRIADO", { chaveApiId: chave.id, loteId });
  }
}
