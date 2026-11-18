// spiderman
import "dotenv/config";

/**
 * Configuracao do servidor, lida UMA vez das variaveis de ambiente (ou do
 * arquivo .env). Centralizar aqui evita espalhar `process.env` pelo codigo
 * e permite validar os valores obrigatorios na inicializacao.
 */
export interface Configuracao {
  porta: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiraEm: string;
  bcryptRounds: number;
  corsOrigin: string | boolean;
  logLevel: string;
  encerramentoTimeoutMs: number;
  /** AV3 (opcionais: quem nao informar usa PADROES_AV3). */
  workerAtivo?: boolean;
  workerIntervaloMs?: number;
  filaMaxTentativas?: number;
  filaBackoffMs?: number;
  filaLeaseMs?: number;
  /** Expressao cron (5 campos) da analise agendada; vazio desativa o agendamento. */
  analiseCron?: string;
  analiseFuso?: string;
  /** Permite webhooks para rede privada/localhost (so para desenvolvimento e testes). */
  webhookRedePrivada?: boolean;
}

export const PADROES_AV3 = {
  workerAtivo: true,
  workerIntervaloMs: 2000,
  filaMaxTentativas: 3,
  filaBackoffMs: 5000,
  filaLeaseMs: 300_000,
  analiseCron: "0 3 * * *",
  analiseFuso: undefined as string | undefined,
  webhookRedePrivada: false,
};

/** Configuracao com os campos da AV3 preenchidos (padroes onde o chamador nao informou). */
export function resolverAv3(c: Configuracao): Configuracao & typeof PADROES_AV3 {
  return { ...PADROES_AV3, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)), } as Configuracao & typeof PADROES_AV3;
}

function inteiroPositivo(env: NodeJS.ProcessEnv, nome: string, padrao: number): number {
  const v = env[nome] === undefined || env[nome] === "" ? padrao : Number(env[nome]);
  if (!Number.isInteger(v) || v < 1) throw new Error(`${nome} deve ser um inteiro positivo.`);
  return v;
}

export function carregarConfiguracao(env: NodeJS.ProcessEnv = process.env): Configuracao {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL nao definida. Copie .env.example para .env e ajuste os valores.");
  }
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET deve ser definido com pelo menos 32 caracteres.");
  }
  const porta = Number(env.PORT ?? 3000);
  if (!Number.isInteger(porta) || porta < 0 || porta > 65535) {
    throw new Error(`PORT invalida: ${env.PORT}`);
  }
  const cors = env.CORS_ORIGIN;
  return {
    porta,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl,
    jwtSecret,
    jwtExpiraEm: env.JWT_EXPIRES_IN ?? "30m",
    // 12 rounds e o equilibrio usual; testes podem reduzir via BCRYPT_ROUNDS para acelerar.
    bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 12),
    corsOrigin: cors === undefined || cors === "" ? false : cors === "*" ? true : cors,
    logLevel: env.LOG_LEVEL ?? "info",
    encerramentoTimeoutMs: Number(env.SHUTDOWN_TIMEOUT_MS ?? 10000),
    workerAtivo: env.WORKER_ATIVO === undefined ? PADROES_AV3.workerAtivo : env.WORKER_ATIVO.toLowerCase() !== "false",
    workerIntervaloMs: inteiroPositivo(env, "WORKER_INTERVALO_MS", PADROES_AV3.workerIntervaloMs),
    filaMaxTentativas: inteiroPositivo(env, "FILA_MAX_TENTATIVAS", PADROES_AV3.filaMaxTentativas),
    filaBackoffMs: inteiroPositivo(env, "FILA_BACKOFF_MS", PADROES_AV3.filaBackoffMs),
    filaLeaseMs: inteiroPositivo(env, "FILA_LEASE_MS", PADROES_AV3.filaLeaseMs),
    analiseCron: env.ANALISE_CRON === undefined ? PADROES_AV3.analiseCron : env.ANALISE_CRON.trim(),
    analiseFuso: env.ANALISE_TZ || undefined,
    webhookRedePrivada: env.WEBHOOK_PERMITIR_REDE_PRIVADA?.toLowerCase() === "true",
  };
}
