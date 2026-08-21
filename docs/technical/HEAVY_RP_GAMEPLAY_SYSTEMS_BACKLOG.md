# Backlog de Sistemas de Gameplay - Heavy RP

Data: 2026-07-11

Objetivo: congelar prioridades reais. Nao adicionar sistemas indefinidamente antes de provar a base tecnica SkyMP.

Filosofia do projeto: sistemas devem gerar cena, conflito, consequencia, dependencia entre jogadores e memoria do mundo. Evitar grind sem interacao, over-engineering e funcionalidades que dependam de confiar no cliente.

## Obrigatorio Para Concluir a Fase 0

Nada abaixo e feature RP nova. Sao provas tecnicas.

1. Confirmar versao exata do `SkyrimSE.exe`.
   - Status atual: confirmado como `1.6.1170.0`.
2. Instalar cliente correspondente a mesma build do servidor.
   - Status atual: artifact `dist/client` instalado para teste local.
3. Conectar primeiro cliente.
   - Status atual: aprovado no log local.
4. Registrar spawn e logs.
   - Status atual: spawn inicial ruim foi corrigido para interior seguro; logs registrados.
5. Conectar segundo cliente.
   - Status atual: aprovado por log local.
6. Testar visibilidade e movimento entre dois clientes.
   - Status atual: pendente de dois PCs ou dois ambientes graficos simultaneos.
7. Testar mudanca de celula.
   - Status atual: pendente.
8. Testar inventario e equipamento.
   - Status atual: pendente.
9. Testar morte e respawn.
   - Status atual: morte/respawn nativo aprovado por queda; falta teste controlado com dois clientes.
10. Testar persistencia apos restart.
   - Status atual: aprovado para carregamento basico de personagem; falta repetir apos inventario/equipamento.

## Prototipo da Fase 1

Somente depois da Fase 0 tecnica estar minimamente confiavel.

### 1. Chat Heavy RP Local

Comandos:

- `/me <acao>`: acao visivel por proximidade.
- `/do <descricao/situacao>`: descricao objetiva da cena por proximidade.
- `/ooc <mensagem>`: fora do personagem, local e limitado.
- `/s <mensagem>` ou `/sussurrar`: alcance curto.
- `/g <mensagem>` ou `/gritar`: alcance maior.
- `/roll [lados]`: rolagem gerada pelo servidor.
- `/report <motivo>`: canal para staff com log.

Regras tecnicas:

- Distancia e celula calculadas pelo servidor.
- Nome exibido vem do personagem aprovado.
- Logs para OOC, report e comandos staff.
- Anti-spam simples.

Status tecnico:

- Prototipo implementado em `skymp/gamemode/rp-chat-service.js`.
- Integrado ao handler CEF `cef::chat:send` via `skymp/gamemode/commands.js`.
- Comandos cobertos: `/me`, `/do`, `/ooc`, `/b`, `/s`, `/sussurrar`, `/g`, `/gritar`, `/roll`, `/try`, `/report`, `/rphelp` e chat local padrao.
- Teste unitario local: `npm test` em `skymp/gamemode`.
- Pendente: validar visualmente em jogo com dois clientes e registrar alcance/celula no log da Fase 0.

Decisao: ADOTADO como primeiro sistema RP, ainda sem promover para alfa.

### 2. Mural de Anuncios por Cidade

Ideia:

- Cada cidade/hold tem um mural IC.
- Jogadores podem publicar anuncios de compra, venda, servico, expedicao, escolta, recrutamento e eventos.
- Staff pode fixar, remover ou arquivar anuncios.
- Inspirado pela enfase publica do Keizaal Online em eventos comunitarios, economia entre jogadores e mundo player-driven. Nao copiar implementacao; adaptar como sistema simples e auditavel.

Escopo inicial:

- Criar anuncio com cidade, tipo, texto, autor IC, validade e status.
- Listar anuncios por cidade.
- Sem pagamento automatico no MVP.
- Sem economia complexa.
- Sem trade automatico no MVP; o mural gera encontro RP, nao substitui o trade seguro.

Server-authoritative:

- Criacao, edicao, expiracao e remocao no backend.
- Logs de staff e autor.
- Rate limit por personagem.

Decisao: ADOTAR na Fase 1, depois do chat local.

### 3. Identidade e Spawn por Personagem Aprovado

Escopo:

- Conta local/OAuth futura vinculada a personagem aprovado.
- Spawn controlado por personagem, nao por `profileId`.
- Nome IC persistente.
- Posicao persistente.
- Nametag social: personagem desconhecido aparece como `Desconhecido` ate apresentacao ou apelido.

Status tecnico:

- Base de identidade social implementada em `skymp/gamemode/identity-service.js`.
- Persistencia em `character_known_identities`.
- Chat local ja resolve nome por observador.
- Pendente: nametag visual e teste em jogo com dois clientes.

Decisao: ADOTAR na Fase 1, em paralelo ao chat local.

### 4. Consequencia Inicial de Morte/Ferimento

Escopo:

- Estados simples: vivo, ferido, morto/respawn.
- Sem loot total.
- Logs de causa quando possivel.
- Respawn controlado e seguro.

Decisao: ADAPTAR na Fase 1.

### 5. Uma Profissao Simples

Escolha sugerida:

- Madeireiro ou minerador.

Escopo:

- Acao canalizada.
- Ferramenta validada.
- Local/alcance validado.
- Recurso bruto concedido pelo servidor.
- Sem mercado complexo.

Decisao: ADOTAR depois de chat + identidade + spawn.

### 6. Persistencia de Estado de Celula (World Objects)

Promovido de Pos-Alfa em 21/08/2026, por decisao do dono do produto — antecipa
parte de "Containers, baus e corpos gerenciados" antes do resto da Fase 0
fechar. Registrado aqui em vez de silenciosamente, porque a versao anterior
deste documento (11/07/2026) tinha o motivo oposto por escrito: "depende de
estabilidade de rede, identidade, logs e inventario confiavel" — nenhuma
dessas dependencias mudou de status, a decisao foi aceitar o risco.

**Nao e a mesma coisa que "Manipulacao livre de props"**, que continua
rejeitada em Ideias Estacionadas / Sistemas Rejeitados. A diferenca:
manipulacao livre e o CLIENTE decidindo onde um objeto existe; isto aqui e o
SERVIDOR decidindo o que persiste, a partir de uma allowlist fixa em codigo —
o jogador aciona um drop/saque que ja existe (inventory-service), o servidor
decide se aquele item específico entra em `world_objects` ou nao. Nenhuma
posicao arbitraria de cliente e aceita sem validacao.

Escopo:

- `CellPersistenceService`: grava/reidrata objetos de mundo por celula.
- Allowlist server-side por categoria/valor — a maioria dos itens dropados
  (o "lixo" de inventario padrao) explicitamente NAO persiste, so expira.
- Spawn via `ObjectReference.PlaceAtMe` (ja aprovado em
  `PAPYRUS_USAGE_POLICY.md`, ja usado por `market-stalls-service.js` para o
  marcador visual da barraca) — nao e capacidade nova da engine, e reuso de
  um caminho ja no contrato.

Server-authoritative:

- Cliente nunca envia posicao de spawn; o servidor le a posicao de onde o
  drop/saque aconteceu, que ja vem do estado do lado servidor.
- Toda gravacao/reidratacao logada (mesmo padrao de audit_logs/gold_transactions).

Nao resolvido por este item, fica para quando "Containers, baus e corpos
gerenciados" for retomado por completo: baus fixos do mundo, corpos com loot
administrado, e a integracao com o Interaction Framework para saque via UI.

Decisao: ADOTAR agora, como `lab` atras de flag — ver o checklist abaixo.
**Nenhum item deste checklist esta satisfeito ainda** (Fase 0 §6/§7/§8 seguem
pendentes: dois clientes, mudanca de celula, inventario). Construir o codigo
agora e deliberado; LIGAR em producao antes desses testes passarem nao e.

## Pos-Alfa

Sistemas importantes, mas nao agora:

- VOIP por proximidade.
- Casas e propriedades.
- Containers, baus e corpos gerenciados (parcialmente promovido — ver item 6 do Prototipo da Fase 1: so a persistencia de world_objects avancou, baus/corpos administrados continuam aqui).
- Prisao, multas, fianca e ficha criminal.
- Faccao, territorio e cerco.
- Economia regional.
- Sistema de impostos.
- Comercio player-to-player com commit duplo.
- Craft expandido.
- Controle staff de mobs, vida e exp.
- NPCs seletivos por regiao/cidade.
- Sobrevivencia leve.

Motivo: todos dependem de estabilidade de rede, identidade, logs e inventario confiavel.

## Ideias Estacionadas

Nao desenvolver agora:

- Cavalos persistentes.
- Disfarces avancados.
- Magia licenciada complexa.
- Doencas persistentes detalhadas.
- Season pass/apoiador.
- UI rica antes do sistema estar seguro.
- Manipulacao livre de props.

## Sistemas Rejeitados ou Muito Adaptados

- Loot total do corpo: rejeitado para publico Heavy RP; gera frustracao e incentiva RDM.
- Economia totalmente dependente de players: rejeitada; o mundo precisa ter basico funcional quando profissionais estiverem offline.
- Prisao offline longa: rejeitada; punicao deve gerar RP, nao impedir o jogador de jogar.
- Banimento sem recurso: rejeitado; punicoes precisam de log e processo de recurso.
- Manipulacao livre de props pelo cliente: rejeitada para MVP e alfa.

## Checklist Para Qualquer Sistema Novo

- Funciona com dois clientes?
- O servidor recalcula tudo que importa?
- Existe log auditavel?
- Existe rollback ou correcao manual?
- Sobrevive a reconexao?
- Sobrevive a restart do servidor?
- O cliente consegue duplicar item ou dinheiro?
- Depende de `offlineMode`, hot reload ou admin por senha?
- Quebra com load order divergente?
- A regra publica explica o comportamento?
