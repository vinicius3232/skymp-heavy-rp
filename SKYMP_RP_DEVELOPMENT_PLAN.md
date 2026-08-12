# Servidor SkyMP Heavy RP Publico - Plano de Desenvolvimento

> **Status Atual (Ativo):** A Fase 0 de fundação técnica foi validada e expandida. Estamos atuando nas Fases 3, 4 e 5. Sistemas críticos como o Governance (prisões, multas, mandados, com checagem de alcance e serviço ativo), Market Stalls (barracas de jogadores) com integração total via UI CEF, o Painel do Jogador in-game (`/painel` — status, governança, economia, social, ver ARCHITECTURE.md 1.4.2) e o Launcher oficial em React/Electron já foram implementados e testados em laboratório. Morte agora tem peso mecânico real (`DOWNED` → `/socorrer` ou bleed-out com penalidade + evidência anti-RDM pra staff, ver ARCHITECTURE.md 1.4.3) e existe soft-delete de personagem (`/permakill`, staff admin/owner). Voz por proximidade (`/voz`, opt-in, ver ARCHITECTURE.md 1.4.4) agora está registrada e ativável — antes existia só no código, sem nada disparar a conexão. Economia Regional (NPCs), Profissões, Crafting, Sobrevivência, Facções, Propriedades e Disfarces seguem desenhados no código mas **PARKED** — nenhum está registrado em produção hoje (ver `phase0-basic.js`).

## 1. Visao

Criar um servidor publico de Skyrim Heavy RP usando SkyMP, com whitelist rigida, personagens persistentes, economia controlada, ferramentas de staff e modlist estavel gerenciada por launcher ou instalador guiado.

O projeto deve ser tratado como um servico vivo e como um mundo narrativo moderado. O objetivo nao e apenas rodar o SkyMP, mas operar um ambiente serio de roleplay com regras, moderacao, persistencia, disciplina de deploy e suporte aos jogadores.

## 2. Escopo do Produto

### Experiencia Alvo

- Servidor publico Heavy RP ambientado em Skyrim.
- Acesso apenas por whitelist rigida.
- Progressao persistente de personagem.
- Nomes, historias, faccoes, profissoes, leis e economia coerentes com a lore.
- Eventos supervisionados pela staff.
- Modlist controlada e compatibilidade de cliente.
- Logs fortes e trilha de auditoria administrativa.

### Principios de Heavy RP

- Acoes do personagem precisam ter motivacoes plausiveis dentro do mundo.
- Conhecimento do jogador e conhecimento do personagem sao coisas separadas.
- Consequencias devem persistir.
- A staff deve proteger a integridade da historia antes da conveniencia.
- Economia e progressao de poder devem ser lentas o suficiente para preservar o RP.
- Combate deve nascer de historia, nao de deathmatch casual.
- Comunicacao publica deve reforcar imersao, regras e padrao da comunidade.

### Meta Inicial de Capacidade

- Alfa fechada: 5-10 jogadores.
- Beta fechada: 20-40 jogadores.
- Beta publica: 50-100 jogadores.
- Fase de escala: 100+ jogadores apenas depois de dados reais de estabilidade.

## 3. Stack Tecnica

### Base

- Servidor SkyMP.
- Versao fixa do Skyrim Special Edition / Anniversary Edition.
- TypeScript para sistemas de gameplay quando suportado por SkyMP/SkyrimPlatform.
- Windows Server para hospedagem inicial.

### Persistencia

- Persistencia nativa SkyMP para mundo/jogadores: avaliar `file`, `zip`, `mongodb` e `migration`.
- MongoDB recomendado para estado nativo SkyMP em servidor publico, se os testes confirmarem compatibilidade com a build usada.
- MariaDB / MySQL recomendado para plataforma RP: whitelist, contas, personagens aprovados, staff, logs externos, economia RP, painel web e sistema VIP/Loja.
- Redis opcional para filas, cache de sessao, rate limit e estado temporario.
- Backups automaticos diarios.
- Controle de schema por arquivos `.sql` e migrations.

### Plataforma Web

- Aplicacao web para whitelist, regras, perfis de personagem, painel da staff, recursos de banimento e status do servidor.
- Stack recomendada:
  - Backend: Node.js/NestJS ou Fastify.
  - Frontend: Next.js ou React.
  - Autenticacao: Discord OAuth.
  - Banco: MariaDB / MySQL.

### Operacao

- Repositorio Git.
- Servidor de staging antes da producao.
- Logs estruturados.
- Relatorio de erros.
- Monitoramento de uptime.
- Verificacao automatica de backups.

## 4. Estrutura do Repositorio

Layout recomendado para monorepo:

```text
skymp-rp/
  apps/
    web/
    launcher/
    admin-panel/
  services/
    api/
    bot-discord/
    worker/
  skymp/
    server/
    gamemode/
    scripts/
    config/
    ui/
  packages/
    shared/
    database/
    rp-types/
  docs/
    rules/
    staff/
    technical/
    roadmap/
  infrastructure/
    docker/
    backups/
    monitoring/
```

## 5. Fases de Desenvolvimento

## Fase 0 - Pesquisa e Viabilidade

### Objetivo

Confirmar build atual do SkyMP, requisitos do cliente, limites de hospedagem e superficie de scripting antes de investir em sistemas grandes.

### Tarefas

- Baixar e rodar uma build atual do servidor SkyMP.
- Confirmar a versao suportada do Skyrim.
- Confirmar o caminho de instalacao do cliente.
- Confirmar portas usadas: porta principal UDP, porta da UI, dev server e DevTools.
- Confirmar `dataDir`, `loadOrder`, `archives`, `gamemodePath`, `startPoints` e `databaseDriver`.
- Testar driver nativo `file`; avaliar `mongodb` para producao.
- Testar conexao com dois jogadores.
- Testar transicao de celulas, combate, sincronizacao de movimento, coleta de item, inventario, morte, respawn e interacao basica.
- Identificar o que pode ser scriptado de forma confiavel.
- Documentar crashes e casos de dessync.
- Comparar comportamento com as referencias Red House e SkyMP atual.
- Criar/seguir checklist tecnico em `docs/technical/SKYMP_SERVER_SETUP.md`.
- Registrar decisoes de `server-options` em `docs/technical/SERVER_OPTIONS_SCHEMA.md`.

### Criterios de Pronto

- Servidor roda localmente.
- Pelo menos dois clientes conectam.
- Limitacoes conhecidas documentadas.
- Decisao tomada sobre versao do Skyrim e modlist base.
- Decisao tomada sobre driver de persistencia nativo do SkyMP.
- Decisao tomada sobre portas e firewall de staging.

## Fase 0.5 - Laboratorio Red House

### Objetivo

Usar o Red House Public apenas como referencia tecnica controlada, para entender fluxo de servidor, chat, UI, spawn, server-options e comandos sem transformar a build antiga em base de producao.

### Tarefas

- Estudar estrutura Red House: `client`, `front`, `server`, `server-build`, `modules`, `compiler` e `docs`.
- Comparar `server-settings.example.json` com o SkyMP atual.
- Extrair ideias de chat por proximidade/celula.
- Extrair ideias de spawn por profile id, mas adaptar para personagem aprovado.
- Extrair ideias de `server-options`, mas remover admin por senha e comandos perigosos.
- Documentar riscos encontrados.

### Criterios de Pronto

- Nenhum codigo Red House vira dependencia de producao sem revisao.
- Aprendizados uteis estao documentados em `docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md`.
- Decisoes aplicaveis foram migradas para documentos proprios do projeto.
- Riscos inseguros foram explicitamente bloqueados no plano.

## Fase 1 - Prototipo Tecnico Privado

### Objetivo

Criar uma sandbox RP controlada com prova de conceito de persistencia.

### Sistemas

- Identidade de conta.
- Criacao de personagem.
- Spawn de personagem.
- Persistencia de posicao.
- Persistencia basica de inventario, se for tecnicamente viavel.
- Admin basico com permissoes por cargo: teleporte, kick e ban.
- Logs do servidor.

### Tarefas

- Criar schema do banco para contas e personagens.
- Vincular identidade do jogador a Discord e Steam quando possivel.
- Implementar primeiro registro de personagem.
- Salvar/carregar estado do personagem.
- Adicionar configuracao basica do servidor.
- Criar primeiro conjunto de comandos da staff.
- Exigir motivo obrigatorio e audit log para comandos da staff.
- Escrever runbook de operacao.

### Criterios de Pronto

- 5 testers conseguem entrar repetidamente.
- Personagens persistem entre reinicios.
- Staff consegue remover jogadores problematicos.
- Logs identificam acoes de jogadores e da staff.
- Nenhum comando destrutivo funciona sem permissao e log.

## Fase 2 - Whitelist e Controle de Comunidade

### Objetivo

Impedir acesso aleatorio e estabelecer disciplina de servidor publico antes de sistemas complexos de RP.

### Sistemas

- Login via Discord OAuth.
- Formulario de whitelist.
- Fluxo de revisao pela staff.
- Status de aprovado, negado, banido e recurso.
- Sincronizacao de cargo no Discord.
- Aceite das regras.

### Tarefas

- Construir fluxo web de whitelist.
- Adicionar painel da staff para revisar aplicacoes.
- Criar integracao com bot do Discord.
- Adicionar log de auditoria para decisoes da staff.
- Adicionar checagem server-side de whitelist antes de permitir entrada.
- Controlar spawn por personagem aprovado, nao apenas por profile id.
- Publicar regras e politica de nomes.

### Criterios de Pronto

- Apenas jogadores aprovados conseguem entrar.
- Apenas personagens aprovados conseguem spawnar.
- Staff consegue aprovar/rejeitar aplicacoes.
- Todas as decisoes sao registradas.
- Jogadores aceitam as regras antes do acesso.

## Fase 3 - Core de Roleplay

### Objetivo

Fazer o servidor parecer um mundo de roleplay, nao apenas uma sandbox sincronizada de Skyrim.

### Sistemas

- Nomes de personagem.
- Historias de personagem.
- Chat local.
- Chat OOC.
- Chat da staff.
- Emotes.
- Descricao de personagem.
- Regras de morte e respawn.
- Regras de ferimento e recuperacao.
- Regras de consentimento/escalada para consequencias graves.
- Reports.
- Fluxo basico de prisao/punicao.

### Tarefas

- Implementar canais de chat IC local, sussurro, grito, OOC, staff e reports.
- Adicionar regras de proximidade/visibilidade local.
- Criar comandos `/me`, `/do`, `/ooc`, `/report` e comandos da staff.
- Adicionar campos de biografia e revisao da staff.
- Adicionar fila de reports.
- Adicionar tratamento de morte.
- Adicionar estado de ferimento, se for tecnicamente viavel.
- Criar cela administrativa ou area de contencao.
- Adicionar logs de moderacao.

### Criterios de Pronto

- Jogadores conseguem fazer RP sem depender de Discord voz/texto.
- Staff consegue lidar com reports in-game.
- Morte e punicoes sao aplicaveis.
- Identidade e historia do personagem sao revisaveis pela staff.
- Chat e registrado para moderacao.
- Chat IC usa distancia e celula como filtros minimos.

## Fase 4 - MVP de Economia

### Objetivo

Introduzir fluxo controlado de dinheiro e profissoes basicas sem criar inflacao ou exploits.

### Sistemas

- Moeda persistente.
- Pagamentos de trabalho.
- Lojas.
- Precificacao de itens.
- Salario/payday.
- Logs de transacao.

### Profissoes Iniciais

- Guarda.
- Cacador.
- Minerador.
- Ferreiro.
- Alquimista.
- Mercador.
- Curandeiro.
- Caminho ladino/criminoso apenas se houver staff suficiente.

### Tarefas

- Criar ledger de dinheiro.
- Implementar modelo basico de carteira/banco.
- Criar configuracao de lojas.
- Implementar validacao server-side de recompensas.
- Adicionar logs de transacao.
- Adicionar ferramentas admin para correcao da economia.

### Criterios de Pronto

- Dinheiro nao pode ser criado pelo cliente.
- Toda transacao e registrada.
- Staff consegue auditar jogadores suspeitos.
- Economia pode ser resetada ou ajustada durante a beta.

## Fase 5 - Faccoes e Lei

### Objetivo

Adicionar grupos estruturados e regras de conflito para RP sustentado.

### Sistemas

- Faccoes.
- Cargos.
- Permissoes.
- Sistema de guarda/lei.
- Registros criminais.
- Mandados.
- Sentencas de prisao.
- Bau de faccao, se viavel.

### Faccoes Iniciais

- Guarda de Whiterun.
- Estudiosos/magos ligados ao Colegio.
- Mercenarios estilo Companions.
- Guilda de mercadores.
- Curandeiros/templo.
- Grupo criminoso entra depois, nao no lancamento.

### Tarefas

- Adicionar tabelas de membros de faccao.
- Adicionar permissoes por cargo.
- Criar atribuicao de faccao controlada pela staff.
- Criar comandos de faccao.
- Adicionar registros criminais e fluxo de mandados.
- Adicionar timers de soltura da prisao.

### Criterios de Pronto

- Faccoes podem ser gerenciadas sem editar banco manualmente.
- Gameplay de guarda tem regras aplicaveis.
- Crime e punicao sao registrados.
- Staff consegue resolver abuso com evidencia.

## Fase 6 - Propriedades e Posse no Mundo

### Objetivo

Criar investimento de longo prazo para jogadores sem desestabilizar o mundo.

### Sistemas

- Casas.
- Aluguel/propriedade.
- Chaves/acesso.
- Armazenamento.
- Pontos comerciais.
- Taxa ou manutencao opcional.

### Tarefas

- Definir registro de propriedades.
- Criar registros de dono.
- Adicionar permissoes de acesso.
- Adicionar comandos da staff para atribuir propriedade.
- Adicionar licencas comerciais.
- Adicionar logs de acesso a armazenamento.

### Criterios de Pronto

- Staff consegue atribuir/revogar propriedade.
- Acesso do jogador persiste.
- Armazenamento nao duplica itens.
- Regras publicas explicam perda de propriedade e inatividade.

## Fase 7 - Launcher e Controle de Modlist

### Objetivo

Reduzir suporte fazendo a instalacao do cliente ser previsivel.

### Sistemas

- Launcher ou instalador.
- Manifesto de modlist.
- Checagem de versao.
- Checagem de integridade de arquivos.
- Fluxo de atualizacao.
- Noticias/changelog.
- Bloqueio de cliente incompativel antes de login/spawn.
- Politica de licenca e nao afiliacao publicada.

### Tarefas

- Definir politica legal de redistribuicao de mods.
- Seguir `docs/technical/LICENSE_AND_AFFILIATION_POLICY.md`.
- Usar apenas mods com permissao ou exigir download pelo jogador quando necessario.
- Criar formato de manifesto.
- Construir prototipo de launcher.
- Adicionar verificacao de instalacao/atualizacao.
- Adicionar checagem de compatibilidade com o servidor.

### Criterios de Pronto

- Jogador novo instala sem cacar arquivos manualmente.
- Servidor rejeita builds incompativeis.
- Staff consegue publicar atualizacoes de modlist.
- Permissoes dos mods estao documentadas.
- Aviso de nao afiliacao publicado no site/launcher/Discord quando aplicavel.

## Fase 8 - Beta Publica

### Objetivo

Abrir para um publico controlado com boa observabilidade e plano de rollback.

### Requisitos

- Whitelist ativa.
- Regras publicadas.
- Staff treinada.
- Backups automatizados.
- Relatorio de crashes ativo.
- Canais de suporte no Discord ativos.
- Lista de exploits conhecidos documentada.
- Politica de reset da economia publicada.
- `offlineMode`, hot reload e DevTools desativados em producao.
- Portas de producao revisadas e documentadas.

### Criterios de Pronto

- 50-100 jogadores aprovados conseguem jogar em janelas agendadas.
- Staff consegue lidar com reports.
- Problemas criticos sao triados em ate 24 horas.
- Estado do servidor pode ser restaurado por backup.

## Fase 9 - Operacao Ao Vivo

### Objetivo

Rodar o projeto de forma sustentavel.

### Trabalho Semanal

- Revisar bugs.
- Revisar logs da economia.
- Revisar logs de moderacao.
- Corrigir scripts.
- Publicar changelog.
- Fazer reuniao da staff.
- Revisar qualidade da whitelist.
- Testar restauracao de backup.

### Trabalho Mensal

- Balancear economia.
- Auditar acoes da staff.
- Revisar saude das faccoes.
- Revisar retencao de jogadores.
- Atualizar roadmap.
- Fazer teste de estresse.

## 6. Modelo Inicial de Banco

### Tabelas Principais

- `accounts`
- `discord_identities`
- `steam_identities`
- `whitelist_applications`
- `characters`
- `character_positions`
- `character_inventory`
- `wallets`
- `transactions`
- `factions`
- `faction_members`
- `properties`
- `property_access`
- `reports`
- `punishments`
- `audit_logs`
- `server_sessions`
- `staff_command_audit`
- `character_spawn_approvals`
- `modlist_versions`
- `client_integrity_checks`

### Regras Importantes

- Mudancas de moeda devem usar transacoes em estilo ledger.
- Acoes da staff devem gerar audit logs.
- Registros de banimento devem ser separados do status de whitelist.
- Delecao de personagem deve ser soft-delete por padrao.
- Escritas de inventario devem ser idempotentes quando possivel.
- Estado nativo SkyMP e estado da plataforma RP devem ter backups separados.
- Comandos da staff devem guardar cargo, alvo, motivo, ambiente e resultado.

## 7. Cargos da Staff

### Dono

- Autoridade final.
- Acesso a infraestrutura.
- Controle financeiro.
- Aprovacao de rollback emergencial.

### Desenvolvedor Lider

- Scripts SkyMP.
- Plataforma web.
- Migrations do banco.
- Processo de release.

### Administrador do Servidor

- Gestao da staff.
- Aplicacao de regras.
- Recursos de banimento.
- Aprovacao de eventos.

### Moderador

- Reports.
- Aplicacao de regras no chat.
- Disputas entre jogadores.
- Punicoes basicas.

### Helper

- Onboarding.
- Suporte de instalacao.
- Suporte de whitelist.
- Sem permissoes destrutivas.

## 8. Regras Publicas Necessarias Antes do Lancamento

- Documento de regras publicas: `docs/rules/HEAVY_RP_RULES.md`.
- Esboco consolidado de regras publicas: `docs/rules/PUBLIC_RULES_LAUNCH_OUTLINE.md`.
- Evidencias dos testes da Fase 0: `docs/roadmap/PHASE_0_TEST_LOG.md`.
- Modelo de aplicacao de personagem: `docs/rules/CHARACTER_APPLICATION_TEMPLATE.md`.
- Rubrica de whitelist da staff: `docs/staff/WHITELIST_RUBRIC.md`.
- Estudo de referencias tecnicas: `docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md`.
- Checklist de setup SkyMP: `docs/technical/SKYMP_SERVER_SETUP.md`.
- Schema de server-options: `docs/technical/SERVER_OPTIONS_SCHEMA.md`.
- Politica de licenca e nao afiliacao: `docs/technical/LICENSE_AND_AFFILIATION_POLICY.md`.
- Decisao tecnica sobre NPCs: `docs/technical/NPC_POLICY_DECISION.md`.
- Politica de nomes.
- Politica de historia de personagem.
- Padroes de Heavy RP.
- Proibicao de fail RP.
- Proibicao de metagaming.
- Proibicao de powergaming.
- Proibicao de random deathmatch.
- Proibicao de bait de combate.
- Proibicao de escalada irreal.
- Proibicao de explorar bugs.
- Proibicao de duplicar itens.
- Proibicao de assedio.
- Regras de voz/chat.
- Regras de morte.
- Regras de ferimento.
- Regras de nova vida/memoria.
- Regras de inicio de combate.
- Regras de refem, tortura e consequencias permanentes.
- Regras de crime.
- Processo de recurso contra decisao da staff.
- Politica de adulteracao de mod/cliente.
- Politica de banimento.

## 8.1 Regras de Design Heavy RP

### Padrao da Whitelist

- A whitelist deve testar maturidade de RP, nao apenas memorizacao de regras.
- Aplicacoes devem exigir conceito do personagem, motivacoes, fraquezas e lacos sociais.
- Candidatos devem explicar metagaming, powergaming, fail RP e escalada.
- Staff deve rejeitar personagens fortes demais, vagos demais ou criados apenas para combate.

### Padroes de Personagem

- Personagens precisam de nomes, historias, objetivos, falhas e limites plausiveis.
- Nobres, magos poderosos, assassinos, vampiros, lobisomens, ligados a Daedra e lideres de faccao exigem aprovacao da staff.
- Personagens nao devem comecar como herois lendarios.
- Progressao deve acontecer em jogo, nao no texto da aplicacao.

### Morte e Consequencias

- Morte nao deve ser casual.
- Morte permanente deve exigir regras rigidas, revisao da staff ou consentimento do jogador, dependendo do caso.
- Ferimento, captura, prisao, dano de reputacao, divida e exilio devem ser usados antes de deletar personagem.
- Regras de respawn devem impedir revenge killing e abuso de memoria.

### Padroes de Economia

- Economia deve sustentar cenas de RP, nao loops de farm.
- Trabalhos devem criar interacao entre jogadores.
- Itens valiosos devem exigir historia, crafting, acesso por faccao ou evento aprovado.
- Geracao rapida de dinheiro deve ser tratada como bug de design.

### Padroes da Staff

- Staff deve ser treinada em aplicacao de Heavy RP.
- Personagens da staff devem seguir regras de conflito de interesse.
- Comandos da staff devem ser logados.
- Punicoes graves devem ter evidencia e notas de revisao.
- Staff de evento deve criar situacoes, nao forcar resultados.

## 9. Riscos de Seguranca e Abuso

### Alto Risco

- Spawn de item pelo cliente.
- Manipulacao de moeda.
- Duplicacao por crash ou dessync.
- Arquivos de mod nao autorizados.
- Abuso de staff.
- Admin por senha simples.
- Comandos destrutivos sem auditoria.
- `offlineMode` ativo em producao.
- Hot reload ativo em producao.
- Corrupcao do banco.
- Problemas legais com redistribuicao de mods.

### Mitigacoes

- Economia autoritativa no servidor.
- Logs em ledger.
- Checagem de integridade de arquivos.
- Trilha de auditoria da staff.
- Permissoes limitadas para staff.
- Autenticacao por identidade externa e cargo, nao por senha compartilhada.
- Bloqueio de comandos destrutivos fora de staging/eventos autorizados.
- Backups frequentes.
- Ambiente de staging.
- Rastreamento explicito de permissao dos mods.
- Conformidade com licencas GPL/AGPL do SkyMP e licencas dos mods.

## 10. Processo de Release

### Ambientes

- Desenvolvimento local.
- Servidor de staging.
- Servidor de producao.

### Passos de Release

1. Fazer merge do codigo na branch de release.
2. Rodar migrations no staging.
3. Fazer smoke test com staff.
4. Empacotar mudancas de cliente/servidor.
5. Publicar changelog.
6. Fazer backup da producao.
7. Fazer deploy em producao.
8. Monitorar logs por pelo menos 60 minutos.

## 11. Roadmap dos Primeiros 30 Dias

### Semana 1

- Rodar servidor SkyMP localmente.
- Validar conexao com dois jogadores.
- Documentar setup do cliente.
- Escolher versao do Skyrim.
- Criar estrutura do repositorio.
- Criar checklist de portas, `dataDir`, masters do Skyrim e scripts.
- Decidir driver inicial de persistencia SkyMP.
- Executar laboratorio Red House apenas como referencia.

### Semana 2

- Adicionar banco de dados.
- Implementar prova de conceito de conta/personagem.
- Adicionar comandos basicos da staff.
- Adicionar auditoria de comandos da staff.
- Iniciar documento de regras.

### Semana 3

- Construir MVP web de whitelist.
- Adicionar Discord OAuth.
- Adicionar fluxo de revisao pela staff.
- Adicionar enforcement de whitelist no servidor.

### Semana 4

- Adicionar chat local/OOC/staff.
- Adicionar chat por proximidade/celula.
- Adicionar reports.
- Adicionar logs de moderacao.
- Rodar teste fechado com 5-10 jogadores.

## 12. Backlog do MVP

### Obrigatorio

- Servidor inicia de forma confiavel.
- Guia de instalacao do cliente.
- Whitelist.
- Identidade persistente de personagem.
- Comandos da staff.
- Chat local.
- Chat por proximidade/celula.
- Reports.
- Logs.
- Backups.
- Regras.
- Rubrica de whitelist Heavy RP.
- Revisao de historia de personagem.

### Deve Ter

- MVP de economia.
- MVP de profissoes.
- MVP de faccoes.
- Sincronizacao de cargos no Discord.
- Prototipo de launcher.
- Server-options proprio validado por ambiente.
- Politica de licenca e nao afiliacao.
- Decisao tecnica inicial sobre NPCs.

### Pode Ter

- Propriedades.
- Negocios.
- Dashboard de eventos.
- Perfis publicos de personagem.
- Status publico do servidor.

### Fora do MVP

- Modpack enorme.
- Economia criminosa complexa.
- Governos controlados por jogadores.
- Guerras em larga escala.
- Launcher completo com auto-patch.
- Monetizacao agressiva (o sistema basico de VIP/Loja foi antecipado para o MVP).

## 13. Decisoes-Chave

- Idioma do servidor: portugues, ingles ou bilingue.
- Nivel de rigidez com lore.
- Nivel de rigidez Heavy RP.
- Se historias de personagem exigem aprovacao antes do primeiro login.
- Meta de jogadores para primeira beta publica.
- **Voice chat não é obrigatório — fechado em 07/08/2026.** A voz nativa por proximidade (`/voz`, `voip-service.js`) é **opcional, fase `lab`, Pós-Alfa**: não é pré-requisito de lançamento e nada no caminho crítico depende dela. A voz da Alfa e da Beta fechada são os **canais de voz temporários do Discord** (`apps/bot-discord/voiceChannels.js`, `/voz-criar` e `/voz-fechar`) — que já funcionam.
  - **Por quê:** o patch de client que libera o microfone no CEF nunca foi compilado nem validado, e foi submetido três vezes ao upstream do SkyMP sem nunca ser mergeado — as três PRs foram auto-fechadas pelo próprio autor, sem review de mantenedor, o que é rejeição por abandono e não decisão técnica. Reconstruí-lo exigiria fork e manutenção contínua de um client C++, custo que não se paga antes da Fase 0 nem da Alfa. Ver [`VOICE_CLIENT_PATCH.md`](docs/technical/VOICE_CLIENT_PATCH.md) e o "Não fazer" do [`QA_REPORT_2026-08.md`](docs/technical/QA_REPORT_2026-08.md).
  - **Isto pode ser revisitado.** Se o upstream mergear um patch equivalente, ou se alguém validar a compilação num ambiente Windows/Visual Studio/vcpkg, o lado servidor já está pronto: `voip-service.js` tem sinalização WebRTC, ticket de uso único e volume por distância, tudo coberto por teste. Voltar atrás é destravar uma peça que já existe, não reescrever.
- Se morte permanente existe no lancamento.
- Se launcher e obrigatorio antes da beta publica.
- Quais mods sao permitidos e legalmente redistribuiveis.
- Se NPCs permanecem, sao reduzidos ou substituidos por papeis de jogadores.
- Decisao inicial recomendada: vanilla spawn seletivo para MVP.
- Se a economia sera resetada depois da beta.
- Se o estado SkyMP usara `file` no MVP e `mongodb` em producao.
- Como cumprir publicacao de codigo/alteracoes exigida pelas licencas do SkyMP.

## 14. Próximo Passo Imediato

> O roteiro executivo desta etapa, incluindo gates, responsáveis e os pacotes destinados ao Claude a partir de 13/08/2026, está em [`docs/roadmap/PLANO_EXECUCAO_POS_FORKS_2026-08.md`](docs/roadmap/PLANO_EXECUCAO_POS_FORKS_2026-08.md).

> Reescrito em 07/08/2026. A versão anterior apontava para **Housing** ou "refinar combate/física" e foi escrita antes de `hit-events`, `espm`, `safe-zones`, `core/soul.js` e do primeiro boot real do servidor existirem. Housing continua PARKED por decisão registrada, e o combate é do cliente — o servidor não arbitra golpe.

**O próximo passo não é uma feature. É conectar um cliente.**

Nada deste projeto foi validado numa sessão real. O servidor subiu pela primeira vez em 06/08/2026 e o gamemode carregou, mas **ninguém entrou**. Os testes usam `mp` mockado, e mock aceita qualquer coisa — foi assim que 22 chamadas Papyrus com argumento errado passaram meses com a suíte verde.

Hoje há **oito sistemas** com o mesmo aviso — *confirmado por teste automatizado, não confirmado em sessão real*. Eram quatro quando esta seção foi escrita em 07/08; a voz (fallback e nativa), a persistência de identidade e a nametag com `/revelaridentidade` entraram depois.

A lista está no índice único do [`docs/technical/FASE_0_ROTEIRO.md`](docs/technical/FASE_0_ROTEIRO.md), que a consolidou porque os mesmos sistemas estavam espalhados por três documentos. **Esta seção não repete a lista**: enquanto repetia, ela envelheceu em silêncio — que é exatamente o defeito que o índice existe para não ter.

O roteiro está pronto e **não executado**. Ele precisa de três pessoas, dois clientes e um servidor — nada que agente de código consiga fazer sozinho.

**O que a Fase 0 desbloqueia**, e por isso ela vem antes de qualquer feature nova:

- apagar o `checkDamageSpike` do `death-service` (a heurística só sai quando o evento de hit provar que chega);
- tirar o polling do `death-service`, se `mp.onDeath` disparar como esperado;
- remover `/internal/session/resolve`, se o master API confirmar;
- liberar a **etapa 2 da Afinidade da Alma** — os quatro resultados em encantamento, que é o primeiro lugar onde a alma vira consequência mecânica.

**Depois da Fase 0**, e não antes, a ordem que o resto da documentação já sustenta:

1. **Etapa 2 do `soul-service`** (`docs/design/SOUL_AFFINITY.md`, "Proposta de implementação"). Escopo pequeno, economia mensurável, primeira profissão de verdade — e valida o mecanismo central do sistema num lugar onde errar é barato. Depende de tirar o `crafting-service` de PARKED, que já foi migrado pro `transaction-service` e está pronto para essa conversa.
2. **Fase 1 — Identidade e Emotes**, que o `REFERENCE_STUDY_SKYMP_RED_HOUSE.md` já mapeou.
3. **Housing / Propriedades**, se e quando a decisão de reativá-lo for tomada — `housing-service.js` está migrado e estacionado, e reativar é decisão de escopo, não de segurança (ver [`PARKED_SERVICES_DECISION.md`](docs/technical/PARKED_SERVICES_DECISION.md)).

O marco técnico atual continua sendo:

```text
Marco 0.1 - Teste de Conexao SkyMP
- Servidor rodando            [feito em 06/08/2026]
- Dois clientes conectados    [PENDENTE — e o que trava todo o resto]
- Versao documentada
- Modlist base documentada
- Notas de crash/dessync documentadas
- Decisao: continuar, corrigir ou mudar abordagem
```
