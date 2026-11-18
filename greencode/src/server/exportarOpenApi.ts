// spiderman
import * as fs from "fs";
import * as path from "path";
import { criarApp } from "./app";
import { criarPrisma } from "./db/prisma";

/**
 * Gera docs/openapi.json (contrato da API) sem precisar de banco: o
 * PrismaClient so abre conexao quando a primeira consulta e feita.
 * Uso: npm run docs:openapi
 */
async function main(): Promise<void> {
  const prisma = criarPrisma("postgresql://x:x@localhost:5432/x");
  const app = await criarApp(
    {
      porta: 0, host: "127.0.0.1", databaseUrl: "", jwtSecret: "x".repeat(32), jwtExpiraEm: "30m",
      bcryptRounds: 4, corsOrigin: false, logLevel: "silent", encerramentoTimeoutMs: 1000,
    },
    prisma
  );
  await app.ready();
  const docs = path.join(__dirname, "..", "..", "docs");
  fs.writeFileSync(path.join(docs, "openapi.json"), JSON.stringify(app.swagger(), null, 2) + "\n");
  // A API publica tem contrato proprio (instancia de swagger separada), exposto em /docs/publico/json.
  const publico = await app.inject({ method: "GET", url: "/docs/publico/json" });
  fs.writeFileSync(path.join(docs, "openapi-publico.json"), JSON.stringify(JSON.parse(publico.body), null, 2) + "\n");
  console.log(`OpenAPI gravado em ${docs}`);
  await app.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
