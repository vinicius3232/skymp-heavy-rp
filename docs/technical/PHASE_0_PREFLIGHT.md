# Preflight da Fase 0

**Status:** disponível desde 12/08/2026  
**Comando:** `npm run preflight:phase0` em `skymp/gamemode`

O preflight reúne as verificações locais que precisam passar antes de chamar os testadores. Ele é somente leitura: não cria configuração, não inicia serviços e nunca imprime valores de segredo.

## Uso

```bash
cd skymp/gamemode
npm run preflight:phase0 -- --profile main --topology local
```

Perfis aceitos:

- `main`: etapas 1–7, com governança, barracas, morte e painel ativos;
- `nametag`: variação do perfil principal para a etapa 3.7;
- `voice-fallback`: valida o boot de voz sem exposição do ticket;
- `voice-native`: exige a exposição temporária do ticket para o helper;
- `soul`: exige `ENABLE_SOUL_SERVICE=true` e `SOUL_SECRET` preenchido;
- `safe-zones`: exige também `skymp/config/safe-zones.json` válido.

Topologias aceitas:

- `local`: servidor e cliente na mesma máquina;
- `lan`: clientes em outras máquinas da rede local;
- `internet`: testadores remotos.

Em `lan` e `internet`, o preflight rejeita hosts de voz limitados a loopback. A acessibilidade externa das portas ainda precisa ser confirmada de outra máquina; o script não executa teste de rede ativo.

## O que é verificado

- arquivos de entrada e dependências dos quatro aplicativos;
- presença dos `.env`, sem revelar seus valores;
- artifact executável do servidor SkyMP;
- perfil de flags do gamemode;
- `NODE_ENV=local` para as configurações locais;
- `offlineMode=false`, `gamemodePath` e `loadOrder` do servidor;
- JSON válido nas configurações locais;
- forma mínima de `apps/game-api/mods.json`;
- requisitos adicionais de voz, alma e safe zones conforme o perfil.

O script não valida se todas as credenciais dos aplicativos são aceitas pelos provedores externos. Também não substitui `npm run check:schema`, que precisa conectar ao banco real.

## Critério de saída

- código `0`: nenhuma pendência detectada;
- código `1`: ambiente incompleto ou configuração incompatível;
- código `2`: argumento de linha de comando inválido.

O resumo final informa a quantidade de itens `OK`, avisos e erros. Corrija todos os erros antes de executar `Start-AllServices.ps1`.

## Resultado local de 12/08/2026

O perfil `main/local` terminou com **9 erros e 9 verificações aprovadas**. As dependências dos aplicativos já foram restauradas. Permanecem pendentes:

1. `apps/web/.env`;
2. `apps/bot-discord/.env`;
3. `apps/game-api/.env`;
4. `apps/launcher/.env`;
5. `skymp/server/dist_back/skymp5-server.js`;
6. `skymp/gamemode/.env`;
7. `skymp/config/server-settings.local.json`;
8. `skymp/config/server-options.local.json`;
9. `apps/game-api/mods.json`.

Esses arquivos dependem de credenciais, escolhas do operador, artifact externo ou do modpack real. Eles não devem ser preenchidos com placeholders apenas para deixar o gate verde.

## Testes automatizados

As regras do preflight têm testes próprios em `skymp/gamemode/scripts/phase0-preflight.test.js` e também fazem parte de `npm test`.
