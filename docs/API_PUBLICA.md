# API pública do greencode (v1) — guia para parceiros

Documentação interativa (Swagger): `http://SERVIDOR:3000/docs/publico` — clique em **Authorize**, cole a chave e
teste as rotas no navegador. O contrato em OpenAPI está em [`openapi-publico.json`](openapi-publico.json).
A visão de arquitetura está em [`RELATORIO_TECNICO_AV3.md`](RELATORIO_TECNICO_AV3.md).

## 1. Conceitos

| Item | Regra |
|---|---|
| Base | `/api/v1/public` (a versão está na URL; mudança incompatível vira `/api/v2/public`, e a v1 continua durante a depreciação) |
| Autenticação | cabeçalho `X-API-Key: gck_xxxxxxxx_...`. Cada parceiro recebe uma chave própria, emitida pelo administrador |
| Permissões (escopos) | `rastreabilidade:ler` · `lotes:ler` · `lotes:escrever` (inclui `lotes:ler`) · `relatorios:gerar`. Sem o escopo, a rota responde 403 |
| Isolamento | a chave só enxerga e grava dados da **própria organização**. Recurso de outra organização responde 404 |
| Limite | requisições por minuto, definidas por chave (padrão 60). Ao exceder: 429 com `Retry-After` e `X-RateLimit-*` |
| Erros | sempre `{ "erro": "...", "mensagem": "..." }` |

Códigos de erro: **400** parâmetro inválido · **401** chave ausente, inválida, expirada ou revogada · **403** chave sem o escopo ·
**404** recurso inexistente ou de outra organização · **409** conflito (NF duplicada, relatório ainda não pronto, limite de relatórios em aberto) ·
**429** limite de requisições · **500** erro interno.

## 2. Emitindo uma chave (administrador)

```bash
# 1) login do admin (guarde o token)
TOKEN=$(curl -s -X POST localhost:3000/api/v1/internal/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","senha":"Greencode#2026"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2) emite a chave do parceiro (a chave completa só aparece nesta resposta)
curl -s -X POST localhost:3000/api/v1/admin/chaves-api -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"nome":"Cooperativa Verde","orgCnpj":"11222333000181","escopos":["rastreabilidade:ler","lotes:escrever","relatorios:gerar"],"limitePorMinuto":120}'
```

Resposta `201`:

```json
{ "id": "…", "nome": "Cooperativa Verde", "prefixo": "820d8610", "escopos": ["rastreabilidade:ler","lotes:escrever","relatorios:gerar"],
  "limitePorMinuto": 120, "ativa": true,
  "chave": "gck_820d8610_ETaHolYc6yTVG2NeNB…", "segredoWebhook": "9f2c…(64 hex)" }
```

Guarde a `chave` e o `segredoWebhook` agora: depois disso o servidor só tem o hash da chave. Revogar:
`POST /api/v1/admin/chaves-api/{id}/revogar` (efeito imediato). Alterar escopos/limite: `PATCH /api/v1/admin/chaves-api/{id}`.

## 3. Rotas

Nos exemplos, `K` é a chave: `export K=gck_…`.

### `GET /me` — quem sou eu
```bash
curl -s localhost:3000/api/v1/public/me -H "X-API-Key: $K"
```
```json
{ "nome": "Cooperativa Verde", "organizacaoCnpj": "11222333000181", "escopos": ["rastreabilidade:ler"], "limitePorMinuto": 60 }
```

### Rastreabilidade (`rastreabilidade:ler`)
`GET /rastreabilidade/equipamentos/{id}` — o `id` é o código de barras.
```bash
curl -s localhost:3000/api/v1/public/rastreabilidade/equipamentos/9a3c1d1e-6a0b-4d52-9f55-2c1f0f4f1a11 -H "X-API-Key: $K"
```
```json
{ "equipamento": { "id": "9a3c…", "codigoBarras": "9a3c…", "loteId": "5f0c…", "posicao": 1, "tipo": "cpu", "marca": "Dell", "modelo": "OptiPlex 3080",
                   "estadoFisico": "regular", "status": "reciclagem", "triagemCompleta": true, "valorRecuperacaoCentavos": 4500,
                   "criadoEm": "2026-10-01T12:00:00.000Z", "atualizadoEm": "2026-10-20T15:30:00.000Z" },
  "movimentacoes": [ { "id": "c1…", "statusDe": "aguardando_triagem", "statusPara": "triado", "estadoDe": null, "estadoPara": null,
                       "justificativa": null, "criadoEm": "2026-10-02T09:00:00.000Z" } ] }
```
`GET /rastreabilidade/lotes/{id}` — o lote e todos os equipamentos, com o status derivado do lote.

### Lotes (`lotes:ler` / `lotes:escrever`)
- `GET /lotes?status=&pagina=&tamanhoPagina=` — lista paginada `{ itens, total, pagina, tamanhoPagina, totalPaginas }`.
- `GET /lotes/{id}` — detalhe com equipamentos.
- `POST /lotes` — cria o lote **e** os equipamentos de forma atômica. A organização é sempre a da chave (um `orgCnpj` enviado é ignorado).
  Exige contrato ativo; `dataEntrada` (AAAA-MM-DD) não pode ser futura nem ter mais de 90 dias.

```bash
curl -s -X POST localhost:3000/api/v1/public/lotes -H "X-API-Key: $K" -H 'content-type: application/json' \
  -d '{"nf":"NF-0099","transportadora":"TransVerde","dataEntrada":"2026-11-10","equipamentos":[{"tipo":"CPU","marca":"Dell","modelo":"OptiPlex 3080"},{"tipo":"Monitor"}]}'
```
`201` com o lote e os equipamentos criados. Erros típicos: `409` (NF já usada pela organização), `400` (data futura, NF vazia), `403` (chave sem `lotes:escrever`).

### Relatório preditivo, assíncrono (`relatorios:gerar`)

1. **Pedir** — `POST /relatorios/preditivo` (corpo opcional `{ "webhookUrl": "https://…" }`). Responde **202 na hora**:
```json
{ "tarefaId": "0b9e6a3a-3d36-4f0f-8d0e-1a6a3d4a9e02", "status": "pendente",
  "statusUrl": "/api/v1/public/tarefas/0b9e…", "resultadoUrl": "/api/v1/public/tarefas/0b9e…/resultado" }
```
2. **Acompanhar** — `GET /tarefas/{id}` (polling). `status`: `pendente` → `processando` → `concluida` | `falha`
(falhas transitórias são repetidas sozinhas: até 3 tentativas com espera crescente; em `falha` o campo `erro` traz o motivo).
```json
{ "id": "0b9e…", "tipo": "relatorio_preditivo", "status": "concluida", "tentativas": 1, "maxTentativas": 3,
  "criadoEm": "…", "iniciadoEm": "…", "concluidoEm": "…", "erro": null, "webhookStatus": "entregue", "resultadoUrl": "/api/v1/public/tarefas/0b9e…/resultado" }
```
3. **Baixar** — `GET /tarefas/{id}/resultado?formato=json` (padrão) ou `?formato=csv` (arquivo `text/csv`). Antes de concluir: `409`.
Cada linha traz, por equipamento: tipo, marca, modelo, estado, status, idade em dias, **vida restante prevista** (dias) e data prevista de inservível,
valor recuperado (se registrado) ou **valor estimado** com a fonte da estimativa (`modelo`, `marca`, `tipo_estado` ou `tipo`).

**Webhook (opcional).** Ao terminar (ou falhar), o servidor faz `POST` na sua URL com:
```json
{ "evento": "relatorio.concluido", "tarefaId": "0b9e…", "status": "concluida", "resultadoUrl": "/api/v1/public/tarefas/0b9e…/resultado" }
```
e o cabeçalho `X-Greencode-Signature: sha256=<HMAC-SHA256 do corpo, usando o segredoWebhook da sua chave>`. Valide a assinatura antes de confiar:
```js
const esperado = "sha256=" + crypto.createHmac("sha256", SEGREDO_WEBHOOK).update(corpoBruto).digest("hex");
```
A URL deve ser http(s) pública (localhost e redes privadas são recusados). A entrega é uma tentativa; se falhar, use o polling.
Limite: no máximo **5 relatórios em aberto** por organização (o 6º responde 409).

## 4. Boas práticas

- Respeite `Retry-After` quando receber 429.
- Prefira o webhook ao polling frequente (cada consulta conta no limite da chave).
- Não registre a chave em logs nem em repositórios; em caso de vazamento peça a revogação.
