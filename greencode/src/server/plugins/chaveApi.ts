// spiderman
import { FastifyInstance, FastifyRequest } from "fastify";
import { ErroPermissao } from "../../types";
import { ChaveApiService, ChaveAutenticada, Escopo, temEscopo } from "../services/ChaveApiService";

declare module "fastify" {
  interface FastifyRequest {
    /** Parceiro autenticado por chave de API (somente nas rotas /api/v1/public). */
    chaveApi: ChaveAutenticada;
  }
}

/** Hook de autenticacao da API publica: le `X-API-Key` e anexa o parceiro a requisicao (401 se invalida). */
export function registrarAutenticacaoPorChave(app: FastifyInstance, chaves: ChaveApiService): void {
  app.decorateRequest("chaveApi", undefined as unknown as ChaveAutenticada);
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const h = req.headers["x-api-key"];
    req.chaveApi = await chaves.autenticar(Array.isArray(h) ? h[0] : h);
  });
}

/** Libera a rota apenas para chaves que tenham o escopo (403 caso contrario). */
export function exigirEscopo(escopo: Escopo) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!temEscopo(req.chaveApi.escopos, escopo)) throw new ErroPermissao(`Esta chave nao possui o escopo '${escopo}'.`);
  };
}
