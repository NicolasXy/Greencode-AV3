// spiderman
import { Db, PrismaClient } from "./prisma";
import { UsuarioRepository } from "../repositories/UsuarioRepository";
import { OrganizacaoRepository } from "../repositories/OrganizacaoRepository";
import { ContratoRepository } from "../repositories/ContratoRepository";
import { LoteRepository } from "../repositories/LoteRepository";
import { EquipamentoRepository } from "../repositories/EquipamentoRepository";
import { MovimentacaoRepository } from "../repositories/MovimentacaoRepository";
import { AuditoriaRepository } from "../repositories/AuditoriaRepository";
import { ParametroRepository } from "../repositories/ParametroRepository";
import { AnaliticaRepository } from "../repositories/AnaliticaRepository";
import { ChaveApiRepository } from "../repositories/ChaveApiRepository";
import { TarefaRepository } from "../repositories/TarefaRepository";

/** Conjunto de repositorios ligados a MESMA conexao/transacao. */
export interface Repositorios {
  usuarios: UsuarioRepository;
  organizacoes: OrganizacaoRepository;
  contratos: ContratoRepository;
  lotes: LoteRepository;
  equipamentos: EquipamentoRepository;
  movimentacoes: MovimentacaoRepository;
  auditoria: AuditoriaRepository;
  parametros: ParametroRepository;
  analitica: AnaliticaRepository;
  chavesApi: ChaveApiRepository;
  tarefas: TarefaRepository;
}

export function criarRepositorios(db: Db): Repositorios {
  return {
    usuarios: new UsuarioRepository(db),
    organizacoes: new OrganizacaoRepository(db),
    contratos: new ContratoRepository(db),
    lotes: new LoteRepository(db),
    equipamentos: new EquipamentoRepository(db),
    movimentacoes: new MovimentacaoRepository(db),
    auditoria: new AuditoriaRepository(db),
    parametros: new ParametroRepository(db),
    analitica: new AnaliticaRepository(db),
    chavesApi: new ChaveApiRepository(db),
    tarefas: new TarefaRepository(db),
  };
}

/**
 * Unidade de trabalho: oferece duas formas de executar codigo de servico.
 *  - `simples`: leitura/operacao unica, usando a conexao normal;
 *  - `transacao`: abre uma transacao interativa ($transaction) e entrega
 *    repositorios ligados a ela. Se a funcao lancar qualquer erro, TODAS as
 *    escritas feitas dentro dela sofrem rollback.
 */
export class UnidadeDeTrabalho {
  constructor(private readonly prisma: PrismaClient) {}

  simples(): Repositorios {
    return criarRepositorios(this.prisma);
  }

  transacao<T>(fn: (repos: Repositorios) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(criarRepositorios(tx)), {
      maxWait: 5000,
      timeout: 15000,
    });
  }
}
