# greencode

Plataforma de logística reversa de resíduos eletrônicos: cadastro de
organizações geradoras, contratos de coleta, controle de lotes recebidos,
rastreabilidade individual de equipamentos (da chegada até a destinação
final) e trilha de auditoria completa das operações. Desenvolvido em
**Node.js + TypeScript**, em duas frentes que compartilham o mesmo modelo
de domínio:

- **CLI (AV1)**: linha de comando com persistência em arquivos de texto
  cifrados (sem banco de dados relacional) e journaling write-ahead. É a
  parte descrita da seção "Executando o sistema" até "Estrutura do projeto".
- **API HTTP (AV2)**: servidor monolítico **Fastify + Prisma ORM +
  PostgreSQL**, com JWT, transações e versionamento otimista. Veja a seção
  [API HTTP (AV2)](#api-http-av2) e `docs/API.md`.
- **Plataforma analítica e API pública (AV3)**: camada de BI (eficiência
  operacional, rentabilidade e vida útil remanescente), chaves de API para
  parceiros, API pública documentada (Swagger), relatórios assíncronos com
  fila e agendamento das análises. Veja [API pública e analítica (AV3)](#api-pública-e-analítica-av3).

## Sumário

- [Requisitos](#requisitos)
- [Instalação](#instalação)
  - [Ubuntu 24.04 LTS ou superior (e derivadas)](#ubuntu-2404-lts-ou-superior-e-derivadas)
  - [Windows 10 ou superior](#windows-10-ou-superior)
- [Executando o sistema](#executando-o-sistema)
- [Primeiro uso (provisionamento)](#primeiro-uso-provisionamento)
- [Papéis e permissões](#papéis-e-permissões)
- [Comandos disponíveis](#comandos-disponíveis)
- [Exemplo de sessão completa](#exemplo-de-sessão-completa)
- [Testes automatizados](#testes-automatizados)
- [Estrutura do projeto](#estrutura-do-projeto)
- [API HTTP (AV2)](#api-http-av2)
- [API pública e analítica (AV3)](#api-pública-e-analítica-av3)
- [Documentação adicional](#documentação-adicional)

## Requisitos

- **Node.js 20.19 LTS ou superior** (ou 22.12+/24+; exigência do Prisma 7 usado pela API. O CLI isoladamente roda também em Node 18). Inclui o
  `npm`, usado para instalar dependências e compilar o projeto.
- Terminal com suporte a UTF-8 (padrão em Ubuntu; no Windows, o Windows
  Terminal ou o PowerShell moderno funcionam sem configuração adicional).

O **CLI** não depende de nenhum banco de dados externo, serviço de rede ou
biblioteca nativa compilada (a **API HTTP** requer PostgreSQL, veja
[API HTTP (AV2)](#api-http-av2)) — apenas o runtime do Node.js e pacotes puros
de JavaScript/TypeScript, o que garante portabilidade entre Windows e
Linux sem ajustes de código.

## Instalação

### Ubuntu 24.04 LTS ou superior (e derivadas)

```bash
# 1. Instale o Node.js 20.19+ (via NodeSource, se ainda não tiver):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Confirme a versão instalada:
node -v   # deve exibir v20.19 ou superior
npm -v

# 3. Extraia o projeto e instale as dependências:
cd greencode
npm install

# 4. Compile o TypeScript para JavaScript:
npm run build
```

### Windows 10 ou superior

1. Baixe e instale o Node.js LTS (20.19 ou superior) em
   https://nodejs.org — o instalador já inclui o `npm`.
2. Abra o **PowerShell** ou o **Prompt de Comando** na pasta do projeto
   (extraída do `.zip`).
3. Execute:

   ```powershell
   node -v
   npm -v

   npm install
   npm run build
   ```

> **Nota sobre permissões de arquivo no Windows:** o sistema tenta
> restringir as permissões do arquivo de configuração mestre (`chmod 600`),
> o que tem efeito limitado no Windows/NTFS. Em ambientes corporativos,
> recomenda-se restringir a pasta `data/` via ACL do Windows ao usuário de
> serviço que executa o `greencode`. Isso não impede o funcionamento do
> sistema — é apenas um reforço de segurança adicional, documentado em
> `docs/SECURITY.md`.

## Executando o sistema

Após compilar (`npm run build`), inicie a CLI com:

```bash
npm start
```

ou diretamente:

```bash
node dist/cli/index.js
```

Por padrão, os dados são gravados em uma pasta `data/` criada no diretório
onde o comando é executado. Para usar um diretório diferente (por exemplo,
para múltiplos ambientes de teste), defina a variável de ambiente
`GREENCODE_DATA_DIR`:

```bash
# Linux/macOS
GREENCODE_DATA_DIR=/caminho/para/dados node dist/cli/index.js

# Windows (PowerShell)
$env:GREENCODE_DATA_DIR="C:\caminho\para\dados"; node dist/cli/index.js
```

## Primeiro uso (provisionamento)

Na primeira execução (quando `data/master.config.json` ainda não existe),
o sistema entra automaticamente em **modo de provisionamento**:

```
========================================
 greencode - plataforma de logistica reversa
========================================
[AVISO] Arquivo de configuracao mestre nao encontrado.
[INFO] Entrando em modo de provisionamento inicial do sistema greencode.
Defina o nome de usuario do administrador: admin
Defina a senha do administrador (min. 8 caracteres, 1 maiuscula, 1 numero): ********
Confirme a senha: ********
[OK] Provisionamento concluido. Chave de criptografia mestra gerada automaticamente.
[OK] Administrador 'admin' criado. Faca login para continuar.
```

A chave de criptografia mestra (AES-256) é gerada automaticamente — não é
necessário (nem possível) informá-la manualmente. Em seguida, o sistema
solicita login com as credenciais recém-criadas.

## Papéis e permissões

| Papel | Pode fazer |
|---|---|
| `admin` | Gerenciar usuários (criar/desativar/listar), configurar parâmetros globais, aplicar política de retenção do journal, e tudo que os demais papéis fazem. |
| `cadastro` | Cadastrar organizações clientes e seus contratos de coleta; criar e consultar lotes. |
| `almoxarifado` | Cadastrar equipamentos (com alocação automática de código de barras interno); concluir triagem; movimentar status e estado físico; consultar lotes. |
| `auditor` | Apenas consultas: listar/ver organizações, contratos de coleta, lotes e equipamentos (incluindo cálculo de depreciação), além de rastreabilidade e journal. Nenhuma operação de escrita é permitida em nenhum recurso. |

O menu de comandos exibido por `ajuda` se adapta automaticamente ao papel
do usuário autenticado.

## Comandos disponíveis

```
login                     - inicia uma nova sessao (solicita usuario/senha)
logout                    - encerra a sessao atual
ajuda                     - lista os comandos disponiveis para o papel atual
sair                      - encerra o programa

usuario criar <user> --senha <senha> --papel <admin|cadastro|almoxarifado|auditor>
usuario desativar <user>
usuario renomear <user_atual> <novo_user>
usuario listar

org criar --cnpj <cnpj> --razao "<razao social>" [--contato <contato>]
org ver <cnpj>
org listar

contrato criar --org <cnpj> --inicio <AAAA-MM-DD> [--frequencia <dias>] [--condicoes "texto"]
contrato ver <id>
contrato listar [--org <cnpj>]
contrato encerrar <id>

lote criar --org <cnpj> --nf <numero> --transp <transportadora> [--data AAAA-MM-DD]
lote ver <id>
lote listar
lote status <id> --novo <recebido|em_triagem|triagem_completa|encerrado>

equipamento cadastrar --lote <id> [--codigo <codigo_barras>] --tipo <tipo>
equipamento triagem <id>
equipamento mover <id> --status <status>
equipamento estado <id> --novo <estado> [--justificativa "texto"]
equipamento ver <id>
equipamento listar [--lote <id>]
equipamento depreciacao <id> --meses <numero_de_meses_de_uso>

rastreio equipamento <id>
rastreio journal [--ultimas N]

config set <parametro> <valor>      (ex.: config set aliquota_icms 0.18)
config get [parametro]
config retencao                     (aplica a politica de retencao do journal)
```

Parâmetros posicionais e opcionais podem ser combinados livremente, por
exemplo:

```
lote criar --org BR001 --nf 123456 --transp TransRapida
equipamento estado 3e0c558e-... --novo sucata --justificativa "dano severo no transporte"
```

Valores com espaços devem ser colocados entre aspas (`"..."` ou `'...'`).

> **Contrato de coleta**: cada contrato é associado a uma organização já
> cadastrada (`--org <cnpj>`). O `--frequencia` (em dias) define a
> periodicidade das coletas e assume 30 dias (mensal) quando omitido.
> Encerrar um contrato (`contrato encerrar <id>`) apenas marca o registro
> como inativo — o histórico de contratos da organização nunca é apagado.

> **Alocação automática de código de barras**: em `equipamento cadastrar`,
> o `--codigo` é opcional. Se omitido, o sistema aloca automaticamente um
> código de barras interno único (formato `INT-<timestamp>-<sufixo>`) —
> a "alocação de códigos de barras internos" atribuída ao gestor de
> almoxarifado. Quando o equipamento já possui uma etiqueta de fábrica ou
> de outro sistema, o operador pode informá-la normalmente via `--codigo`.

> **Tipos de equipamento com subclasse especializada**: `terminal`, `cpu`,
> `monitor` e `servidor` (cada um com sua própria curva de depreciação).
> Qualquer outro valor informado em `--tipo` é aceito normalmente, caindo
> no tipo genérico de fallback (`EquipamentoGenerico`) — o cadastro nunca
> falha por causa de um tipo não mapeado ainda.

## Exemplo de sessão completa

```
greencode> usuario criar cad1 --senha CadSenha1 --papel cadastro
[OK] Usuario 'cad1' criado com papel 'cadastro'.

greencode> logout
[OK] Logout efetuado.
Usuario: cad1
Senha: ********
[OK] Login efetuado. Bem-vindo(a), cad1 (cadastro).

greencode> org criar --cnpj 11222333000181 --razao "Hospital Central"
[OK] Organizacao criada: Hospital Central (11.222.333/0001-81)

greencode> lote criar --org 11222333000181 --nf 123456 --transp TransRapida
[OK] Lote criado: bc8287c8-... | org=11222333000181 | nf=123456 | status=recebido
```

## Testes automatizados

O projeto inclui sete scripts de teste que dirigem a CLI real (como um
usuário faria), sem acessar o armazenamento diretamente, cobrindo desde o
provisionamento até a rastreabilidade final:

```bash
npm run build      # necessario antes de rodar os testes
npm test           # roda todas as suites (jornada + seguranca + dominio + conformidade + write-ahead + sessao + api + av3)

# ou individualmente:
npm run test:journey      # jornada completa: provisionamento -> 4 papeis -> rastreabilidade
npm run test:security     # cenarios de seguranca/permissao e tratamento de erros
npm run test:domain       # heranca/polimorfismo/fabricas do modelo de dominio (Equipamento e subclasses)
npm run test:compliance   # contrato de coleta e alocacao automatica de codigo de barras
npm run test:write-ahead  # ordem write-ahead do journal (log antes do estado) e cobertura de acoes
npm run test:session      # expiracao de sessao por inatividade (30 min), sem esperar 30 min de verdade
npm run test:api          # API HTTP da AV2 (exige PostgreSQL): 195 verificacoes
npm run test:av3          # AV3 (exige PostgreSQL): 157 verificacoes
```

O que cada suíte cobre:

- **`test:journey`** (24 verificações): provisionamento, criação de
  usuários pelo admin, validação de CNPJ (válido e inválido), criação de
  lote (válido e com data futura rejeitada), ciclo de vida completo de um
  equipamento (triagem obrigatória antes de desmonte, alteração de estado
  físico com e sem exigência de justificativa), consulta de
  rastreabilidade pelo auditor, bloqueio de escrita para o auditor, e
  verificação de que os arquivos em disco estão de fato cifrados.
- **`test:security`** (20 verificações): rejeição de senha fraca no
  provisionamento, rejeição de login com senha incorreta e usuário
  inexistente, bloqueio de login para usuário desativado, permissões
  cruzadas entre papéis (RBAC) — incluindo a confirmação de que o auditor
  consegue **consultar** organizações/contratos/lotes livremente mas é
  bloqueado de **qualquer** escrita, e que os recursos `usuario` e
  `config` permanecem inacessíveis a ele mesmo para leitura — e
  tratamento de comando desconhecido sem encerrar o processo.
- **`test:domain`** (14 verificações): a fábrica escolhe a subclasse
  correta por tipo (`terminal`, `cpu`, `monitor`, `servidor`) e recai no
  tipo genérico para valores não mapeados; o cálculo de depreciação
  **polimórfico** produz resultados diferentes por subclasse para os
  mesmos meses de uso; o teto de depreciação máxima do `Servidor` é
  respeitado; e o tipo concreto sobrevive a um ciclo completo de
  gravação/releitura do arquivo cifrado (reidratação polimórfica).
- **`test:compliance`** (11 verificações): contrato de coleta criado e
  associado a uma organização existente (rejeitado quando a organização
  não existe), consulta e listagem por organização, encerramento sem
  remoção do histórico; e alocação automática de código de barras interno
  ao cadastrar um equipamento sem `--codigo` (com unicidade garantida
  entre cadastros sucessivos), preservando a opção de informar um código
  manualmente quando o equipamento já possui etiqueta de fábrica.
- **`test:write-ahead`** (14 verificações): confirma que toda transação de
  escrita relevante (criação de usuário, organização, contrato, lote e
  cada transição de status/estado físico de um equipamento) gera uma
  entrada correspondente no journal, que os números de sequência são
  contínuos (sem lacunas) e que todos os checksums são íntegros — a prova
  automatizada de que o journal funciona como um log write-ahead de fato,
  e não apenas de nome.
- **`test:session`** (7 verificações): sessão recém-criada é válida;
  29 minutos de inatividade não expira; cada comando renova a janela
  (expiração deslizante); 31 minutos de inatividade expira com o erro
  apropriado; a sessão é efetivamente removida após expirar; um novo
  login volta a funcionar normalmente; e o evento fica registrado no
  journal com o tempo de inatividade observado. Testado manipulando o
  relógio da sessão diretamente (sem esperar 30 minutos reais).

Total: **96 verificações automatizadas do CLI** + **195 da API HTTP**
(`npm run test:api`, requer PostgreSQL; ver `docs/API.md`).

Os testes usam diretórios de dados temporários isolados
(`os.tmpdir()`), não interferindo com a pasta `data/` real.

## Estrutura do projeto

```
greencode/
├── prisma/                        # schema.prisma e migracoes SQL versionadas (AV2)
├── src/
│   ├── server/                    # API HTTP (AV2/AV3): routes, controllers, services, repositories, db, plugins, seed,
│   │                              #   analytics/ (BI) e queue/ (worker, agendador cron, webhook)

│   ├── types.ts                   # enums/tipos primitivos e classes de erro
│   ├── models/                     # ENTIDADES DE DOMINIO (classes reais, nao interfaces)
│   │   ├── Entidade.ts              # classe abstrata base (id, criadoEm)
│   │   ├── Organizacao.ts
│   │   ├── ContratoColeta.ts         # contrato de coleta associado a uma Organizacao
│   │   ├── Lote.ts
│   │   ├── Movimentacao.ts
│   │   ├── Equipamento.ts           # classe ABSTRATA: contrato polimorfico (calcularCoeficienteDepreciacao, etc.)
│   │   └── equipamentos/            # SUBCLASSES concretas (heranca + polimorfismo)
│   │       ├── Terminal.ts
│   │       ├── CPU.ts
│   │       ├── Monitor.ts
│   │       ├── Servidor.ts
│   │       └── EquipamentoGenerico.ts  # fallback para tipos nao mapeados (Open/Closed)
│   ├── validation/                 # classe abstrata Validador<T> + validadores concretos + interface IValidavel
│   ├── factories/                   # FABRICAS: criam/reidratam as entidades acima
│   │   ├── OrganizacaoFactory.ts
│   │   ├── ContratoColetaFactory.ts
│   │   ├── LoteFactory.ts
│   │   ├── EquipamentoFactory.ts     # Factory Method: escolhe a subclasse por tipo
│   │   └── MovimentacaoFactory.ts
│   ├── core/
│   │   ├── crypto.ts                # AES-256-GCM, hash SHA-256 iterado, scrypt
│   │   ├── storage.ts                # escrita/leitura atomica e cifrada em arquivo
│   │   ├── journal.ts                # journaling (write-ahead), rotacao, retencao
│   │   ├── auth.ts                   # provisionamento, login, sessao, RBAC
│   │   └── validators.ts             # implementacao das regras (CNPJ, datas, transicoes)
│   ├── repositories/                  # persistencia: orquestram fabricas + storage cifrado
│   ├── commands/                      # logica de cada comando + roteador com controle de acesso
│   └── cli/
│       ├── index.ts                   # entry point: readline, autocompletar, historico, loop de comandos
│       ├── parser.ts                  # parser de "recurso acao --flags"
│       └── contexto.ts                # agrega auth, journal e repositorios
├── tests/
│   ├── run-journey.js                 # teste de jornada completa (end-to-end via CLI)
│   ├── run-security.js                # teste de cenarios de seguranca e permissao
│   ├── run-domain.js                  # teste de heranca/polimorfismo/fabricas do modelo de dominio
│   ├── run-compliance.js              # teste de contrato de coleta e alocacao de codigo de barras
│   ├── run-write-ahead.js             # teste da ordem write-ahead do journal (log antes do estado)
│   ├── run-session-timeout.js         # teste funcional da expiracao de sessao (30 min)
│   └── run-all.js                     # roda as sete suites em sequencia
├── docs/
│   ├── SECURITY.md                    # justificativa da arquitetura de seguranca
│   └── FAILURE_SCENARIOS.md           # cenarios de falha testados e respostas do sistema
├── package.json
└── tsconfig.json
```

### Modelo de domínio (herança, interfaces, polimorfismo e fábricas)

O núcleo de domínio (`src/models/`) segue o modelo UML descrito na proposta:

- **Herança**: `Terminal`, `CPU`, `Monitor` e `Servidor` (em
  `src/models/equipamentos/`) estendem a classe **abstrata**
  `Equipamento`, que concentra o estado e comportamento comuns
  (código de barras, estado físico, status de triagem/desmontagem).
- **Interface**: `Equipamento` implementa `IValidavel`
  (`src/validation/IValidavel.ts`), contrato de auto-validação usado
  também pelas fábricas.
- **Classes abstratas de validação**: `Validador<T>`
  (`src/validation/Validador.ts`) é a base de `ValidadorCNPJ`,
  `ValidadorDataLote`, `ValidadorTransicaoStatus` e
  `ValidadorEstadoFisico`.
- **Polimorfismo**: cada subclasse de `Equipamento` implementa
  `calcularCoeficienteDepreciacao(meses)` e `vidaUtilEstimadaMeses()` de
  forma diferente (linear, acelerada nos primeiros meses, com teto
  máximo, etc.). O comando `equipamento depreciacao <id> --meses <n>`
  demonstra isso na prática: a mesma chamada, sobre a referência abstrata
  `Equipamento`, produz resultados diferentes conforme o tipo real do
  objeto em tempo de execução — verificado em `tests/run-domain.js`.
- **Fábricas**: `EquipamentoFactory` (Factory Method) escolhe a subclasse
  correta a partir do texto informado (`--tipo terminal|cpu|monitor|
  servidor`), com fallback para `EquipamentoGenerico` em tipos ainda não
  mapeados (princípio Open/Closed). `OrganizacaoFactory`, `LoteFactory` e
  `ContratoColetaFactory` aplicam as validações de negócio antes de
  construir os "objetos compostos" citados na atividade (um `Lote` ou um
  `ContratoColeta` dependem de uma `Organizacao` já existente).
- Os **repositórios** (`src/repositories/`) não constroem mais objetos
  literais: eles chamam as fábricas para criar novas entidades e para
  **reidratar** (reconstruir a subclasse polimórfica correta) os dados
  lidos do arquivo cifrado, e delegam as regras de transição de estado às
  próprias entidades (`equip.moverParaStatus(...)`,
  `equip.alterarEstadoFisico(...)`), em vez de manipular os dados de fora.


## API HTTP (AV2)

A evolução do greencode para servidor monolítico (Node.js + TypeScript,
**Fastify**, **Prisma ORM** e **PostgreSQL**) está em `src/server/`, com
arquitetura **Controller → Service → Repository**, autenticação **JWT**
stateless com **bcrypt**, transações atômicas (`$transaction`), controle
de concorrência por **versionamento otimista**, migrações versionadas,
restrições de unicidade/CHECK/triggers no banco, script de **seed** e
**graceful shutdown**. O CLI continua intacto.

```bash
cp .env.example .env     # ajuste DATABASE_URL e JWT_SECRET
npm install
npm run db:setup         # migra, compila e popula o banco (seed)
# o seed inclui marca, modelo e valor recuperado em equipamentos do lote 1, para as análises de rentabilidade terem dados desde o início
npm run serve            # http://localhost:3000  (docs em /docs)
```

Guia completo (instalação em Windows e Ubuntu, endpoints, matriz de
papéis, regras confirmadas pelo cliente, decisões arquiteturais e
trade-offs): [`docs/API.md`](docs/API.md).

## API pública e analítica (AV3)

Sobre a API da AV2, a AV3 acrescenta (tudo em `src/server/`):

| Novidade | Resumo |
|---|---|
| **Camada analítica** | três análises independentes (`analytics/`): **eficiência operacional** (tempo médio entrada → fim da triagem, operadores, períodos, gargalo), **rentabilidade** (valor médio de recuperação por tipo, estado físico, marca e modelo) e **vida útil remanescente** (regressão linear por tipo, com `simple-statistics`). Resultados guardados em `AnaliseExecucao` e `PrevisaoVidaUtil`; histórico consultável; previsões comparadas com a realidade para refinar o modelo |
| **Três prefixos** | `/api/v1/public` (parceiros, chave de API), `/api/v1/internal` (front-end, JWT) e `/api/v1/admin` (gestão, JWT). O prefixo antigo `/api/v1/...` continua funcionando |
| **Chaves de API** | uma por parceiro (organização), com escopos (`rastreabilidade:ler`, `lotes:ler`, `lotes:escrever`, `relatorios:gerar`) e limite de requisições por minuto; só o hash é guardado |
| **Swagger** | `/docs` (interna e administrativa) e `/docs/publico` (parceiros, com exemplos e códigos de erro) |
| **Fila e worker** | relatório preditivo assíncrono: `POST` devolve `202` + id da tarefa; consulta de status (polling) ou webhook assinado; download em JSON ou CSV. Fila no PostgreSQL, com retry e backoff |
| **Agendamento** | `node-cron` enfileira a análise completa (padrão: todo dia às 03:00) |

```bash
npm run serve        # API + worker + agendador no mesmo processo (http://localhost:3000)
npm run worker       # (opcional) processo só com o worker, para escalar separado (use WORKER_ATIVO=false na API)
npm run test:av3     # 157 verificações: analítica, chaves, API pública, fila, cron
```

Windows (PowerShell) e Ubuntu usam os mesmos comandos; o PostgreSQL pode vir do `docker-compose.yml`
(`docker compose up -d`). Nenhum Redis é necessário. As variáveis novas (`WORKER_ATIVO`, `FILA_MAX_TENTATIVAS`, `FILA_BACKOFF_MS`,
`ANALISE_CRON` etc.) estão comentadas no `.env.example`.

Fluxo mínimo de um parceiro (detalhes e respostas em [`docs/API_PUBLICA.md`](docs/API_PUBLICA.md)):

```bash
# 1) o admin emite a chave (guarde o campo "chave": ele só aparece uma vez)
curl -s -X POST localhost:3000/api/v1/admin/chaves-api -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"nome":"Cooperativa Verde","orgCnpj":"11222333000181","escopos":["rastreabilidade:ler","relatorios:gerar"]}'
# 2) o parceiro consulta e pede o relatório
curl -s localhost:3000/api/v1/public/me -H "X-API-Key: $K"
curl -s -X POST localhost:3000/api/v1/public/relatorios/preditivo -H "X-API-Key: $K"      # 202 { "tarefaId": ... }
curl -s localhost:3000/api/v1/public/tarefas/$ID/resultado?formato=csv -H "X-API-Key: $K"  # quando "concluida"
```

Para gerar um relatório de análise agora: `POST /api/v1/admin/analises/eficiencia/executar` (ou `rentabilidade`, `vida-util`),
com o token de admin. Relatório técnico com as justificativas das decisões:
[`docs/RELATORIO_TECNICO_AV3.md`](docs/RELATORIO_TECNICO_AV3.md).

## Documentação adicional

- [`docs/RELATORIO_TECNICO_AV3.md`](docs/RELATORIO_TECNICO_AV3.md) — AV3: por que `simple-statistics`, modelagem das tabelas
  analíticas, política de retry e evolução para centenas ou milhares de parceiros.
- [`docs/REQUISITOS_AV3.md`](docs/REQUISITOS_AV3.md) — AV3: cada item do checklist e do PDF do cliente, onde foi feito e qual teste comprova.
- [`docs/API_PUBLICA.md`](docs/API_PUBLICA.md) — AV3: guia da API pública para parceiros (chaves, escopos, limites, exemplos, erros, webhook).

- [`docs/SECURITY.md`](docs/SECURITY.md) — justificativa detalhada do uso
  de AES-256-GCM, do esquema de hash de senha (SHA-256 iterado + salt), da
  política de expiração de sessão, do RBAC e da integridade do journal,
  incluindo limitações conhecidas desta etapa e o caminho de evolução para
  as próximas (interface web e banco de dados relacional); a seção 8 cobre a
  segurança da API HTTP da AV2 (JWT, bcrypt, RBAC, banco de dados).
- [`docs/REQUISITOS_AV2.md`](docs/REQUISITOS_AV2.md) — matriz de rastreabilidade: cada requisito da AV2 e
  cada dúvida respondida pelo cliente, com onde foi implementado e qual teste comprova.
- [`docs/API.md`](docs/API.md) — API HTTP (AV2 e AV3): execução, camadas, modelo de
  dados, JWT, transações, concorrência, endpoints, camada analítica, fila e decisões arquiteturais.
- [`docs/FAILURE_SCENARIOS.md`](docs/FAILURE_SCENARIOS.md) — tabela
  completa de cenários de falha testados (validação de dados, autenticação,
  autorização, integridade/persistência) e a resposta observada do sistema
  em cada caso.
