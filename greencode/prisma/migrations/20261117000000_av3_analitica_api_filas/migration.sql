-- AV3: camada analitica, chaves de API (API publica) e fila de tarefas assincronas.

-- CreateEnum
CREATE TYPE "StatusTarefa" AS ENUM ('pendente', 'processando', 'concluida', 'falha');
CREATE TYPE "TipoAnalise" AS ENUM ('eficiencia_operacional', 'rentabilidade', 'vida_util');
CREATE TYPE "OrigemAnalise" AS ENUM ('manual', 'agendada', 'tarefa');

-- AlterTable: lote (conclusao da triagem) e equipamento (dados de rentabilidade)
ALTER TABLE "Lote" ADD COLUMN "triagemConcluidaEm" TIMESTAMPTZ(3), ADD COLUMN "triagemConcluidaPorId" UUID;
ALTER TABLE "Equipamento" ADD COLUMN "marca" TEXT, ADD COLUMN "modelo" TEXT, ADD COLUMN "valorRecuperacaoCentavos" INTEGER;

-- Preenche a conclusao da triagem dos lotes ja existentes a partir da trilha de auditoria (primeira vez que o lote virou triagem_completa).
UPDATE "Lote" l
SET "triagemConcluidaEm" = a."criadoEm",
    "triagemConcluidaPorId" = a."usuarioId"
FROM (
  SELECT DISTINCT ON ((detalhes->>'loteId')) (detalhes->>'loteId')::uuid AS "loteId", "criadoEm", "usuarioId"
  FROM "Auditoria"
  WHERE acao = 'LOTE_STATUS_ATUALIZADO' AND detalhes->>'para' = 'triagem_completa'
  ORDER BY (detalhes->>'loteId'), "criadoEm" DESC
) a
WHERE l.id = a."loteId";

ALTER TABLE "Lote" ADD CONSTRAINT "Lote_triagemConcluidaPorId_fkey" FOREIGN KEY ("triagemConcluidaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Lote_triagemConcluidaEm_idx" ON "Lote"("triagemConcluidaEm");
ALTER TABLE "Equipamento" ADD CONSTRAINT "Equipamento_valorRecuperacao_check" CHECK ("valorRecuperacaoCentavos" IS NULL OR "valorRecuperacaoCentavos" >= 0);

-- CreateTable
CREATE TABLE "ChaveApi" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "prefixo" TEXT NOT NULL,
    "hashSegredo" TEXT NOT NULL,
    "organizacaoId" UUID NOT NULL,
    "escopos" TEXT[],
    "limitePorMinuto" INTEGER NOT NULL DEFAULT 60,
    "segredoWebhook" TEXT NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "expiraEm" TIMESTAMPTZ(3),
    "revogadaEm" TIMESTAMPTZ(3),
    "ultimoUsoEm" TIMESTAMPTZ(3),
    "criadaPorId" UUID NOT NULL,
    "criadoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChaveApi_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TarefaAssincrona" (
    "id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "parametros" JSONB NOT NULL DEFAULT '{}',
    "status" "StatusTarefa" NOT NULL DEFAULT 'pendente',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "maxTentativas" INTEGER NOT NULL DEFAULT 3,
    "proximaExecucaoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bloqueadaAte" TIMESTAMPTZ(3),
    "ultimoErro" TEXT,
    "resultado" JSONB,
    "chaveUnica" TEXT,
    "webhookUrl" TEXT,
    "webhookStatus" TEXT,
    "organizacaoId" UUID,
    "chaveApiId" UUID,
    "criadoEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciadoEm" TIMESTAMPTZ(3),
    "concluidoEm" TIMESTAMPTZ(3),
    CONSTRAINT "TarefaAssincrona_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnaliseExecucao" (
    "id" UUID NOT NULL,
    "tipo" "TipoAnalise" NOT NULL,
    "origem" "OrigemAnalise" NOT NULL,
    "parametros" JSONB NOT NULL DEFAULT '{}',
    "resultado" JSONB NOT NULL,
    "amostra" INTEGER NOT NULL,
    "duracaoMs" INTEGER NOT NULL,
    "geradaEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geradaPorId" UUID,
    CONSTRAINT "AnaliseExecucao_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrevisaoVidaUtil" (
    "id" UUID NOT NULL,
    "execucaoId" UUID NOT NULL,
    "tipoEquipamento" TEXT NOT NULL,
    "modelo" TEXT NOT NULL DEFAULT 'ols',
    "inclinacao" DOUBLE PRECISION NOT NULL,
    "intercepto" DOUBLE PRECISION NOT NULL,
    "r2" DOUBLE PRECISION NOT NULL,
    "amostra" INTEGER NOT NULL,
    "vidaTotalBrutaDias" DOUBLE PRECISION NOT NULL,
    "ajusteDias" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vidaTotalPrevistaDias" DOUBLE PRECISION NOT NULL,
    "vidaRestanteMediaDias" DOUBLE PRECISION NOT NULL,
    "equipamentosAtivos" INTEGER NOT NULL,
    "geradaEm" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "avaliadaEm" TIMESTAMPTZ(3),
    "vidaTotalRealDias" DOUBLE PRECISION,
    "erroDias" DOUBLE PRECISION,
    "falhasObservadas" INTEGER,
    CONSTRAINT "PrevisaoVidaUtil_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChaveApi_prefixo_key" ON "ChaveApi"("prefixo");
CREATE INDEX "ChaveApi_organizacaoId_idx" ON "ChaveApi"("organizacaoId");
CREATE UNIQUE INDEX "TarefaAssincrona_chaveUnica_key" ON "TarefaAssincrona"("chaveUnica");
CREATE INDEX "TarefaAssincrona_status_proximaExecucaoEm_idx" ON "TarefaAssincrona"("status", "proximaExecucaoEm");
CREATE INDEX "TarefaAssincrona_chaveApiId_idx" ON "TarefaAssincrona"("chaveApiId");
CREATE INDEX "AnaliseExecucao_tipo_geradaEm_idx" ON "AnaliseExecucao"("tipo", "geradaEm");
CREATE INDEX "PrevisaoVidaUtil_tipoEquipamento_geradaEm_idx" ON "PrevisaoVidaUtil"("tipoEquipamento", "geradaEm");
CREATE INDEX "PrevisaoVidaUtil_avaliadaEm_idx" ON "PrevisaoVidaUtil"("avaliadaEm");

-- AddForeignKey
ALTER TABLE "ChaveApi" ADD CONSTRAINT "ChaveApi_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChaveApi" ADD CONSTRAINT "ChaveApi_criadaPorId_fkey" FOREIGN KEY ("criadaPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TarefaAssincrona" ADD CONSTRAINT "TarefaAssincrona_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TarefaAssincrona" ADD CONSTRAINT "TarefaAssincrona_chaveApiId_fkey" FOREIGN KEY ("chaveApiId") REFERENCES "ChaveApi"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnaliseExecucao" ADD CONSTRAINT "AnaliseExecucao_geradaPorId_fkey" FOREIGN KEY ("geradaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PrevisaoVidaUtil" ADD CONSTRAINT "PrevisaoVidaUtil_execucaoId_fkey" FOREIGN KEY ("execucaoId") REFERENCES "AnaliseExecucao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ultima barreira de integridade: somente escopos conhecidos, limite positivo, tentativas coerentes.
ALTER TABLE "ChaveApi" ADD CONSTRAINT "ChaveApi_escopos_check" CHECK (escopos <@ ARRAY['rastreabilidade:ler','lotes:ler','lotes:escrever','relatorios:gerar']::text[] AND cardinality(escopos) > 0);
ALTER TABLE "ChaveApi" ADD CONSTRAINT "ChaveApi_limite_check" CHECK ("limitePorMinuto" BETWEEN 1 AND 100000);
ALTER TABLE "TarefaAssincrona" ADD CONSTRAINT "TarefaAssincrona_tentativas_check" CHECK (tentativas >= 0 AND "maxTentativas" >= 1);
