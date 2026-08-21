# Plano de Teste - Governanca, Guarda e Barraquinhas

Data: 2026-07-13

> ⚠️ **Superado por [FASE_0_ROTEIRO.md](../technical/FASE_0_ROTEIRO.md)** (06/08/2026). Este plano cobre governança e barracas; desde ele entraram `death-service`, `/painel`, VOIP, master API de sessão e a fila, e o gamemode passou de ~15 para mais de 60 comandos. Mantido como referência da validação visual (camada 5), que o roteiro novo não cobre.

## Objetivo

Validar, em camadas, os sistemas de governanca/guarda e barraquinhas antes de liberar em gameplay real.

## Camadas de validacao

1. Validacao estatica local
   - Rodar `npm test` em `skymp/gamemode`.
   - Rodar `npm run test:systems` em `skymp/gamemode`.
   - Confirmar que migrations, comandos, permissoes e flags de ambiente estao alinhados.

2. Validacao de banco
   - Aplicar `migration-v3-governance.sql`.
   - Aplicar `migration-v4-market-stalls.sql`.
   - Rodar `RUN_DB_CHECK=1 npm run test:systems`.
   - Confirmar tabelas de governanca, guarda, barracas, vendas e licencas.

3. Validacao de servidor sem asset visual
   - Ligar `ENABLE_GOVERNANCE_SERVICE=true`.
   - Ligar `ENABLE_MARKET_STALLS_SERVICE=true`.
   - Manter `skymp/config/market-stalls.visual.json` ausente ou com `enabled=false`.
   - Confirmar boot sem erro.

4. Validacao de gameplay com dois jogadores
   - Jogador A recebe cargo de guarda/fiscal.
   - Jogador B recebe licenca de vendedor.
   - B monta barraca, anuncia item e A fiscaliza.
   - Jogador A ou C compra item da barraca.
   - Conferir ouro, imposto, estoque, inventario persistente e logs.

5. Validacao visual
   - Criar plugin proprio com asset aprovado.
   - Configurar `defaultStallBaseId` em `skymp/config/market-stalls.visual.json`.
   - Repetir spawn, compra, recolhimento, reconnect e late join.

## Script local

Rodar dentro de `skymp/gamemode`:

```powershell
npm run test:systems
```

Com banco real:

```powershell
$env:RUN_DB_CHECK='1'
npm run test:systems
Remove-Item Env:\RUN_DB_CHECK
```

## Checklist manual minimo

- `/realmcreate skyrim Skyrim`
- `/citycreate whiterun skyrim whiterun Whiterun`
- `/govadd <actorId> city whiterun guard`
- `/guardduty on`
- `/stalllicense <actorIdVendedor> whiterun 7`
- `/stallplace Feira de Teste`
- `/stalladd <stallId> 0xf 10 5 Septims`
- `/stallitems <stallId>`
- `/stallbuy <stallId> <itemId> 2`
- `/stallinspect <stallId>`
- `/stallsuspend <stallId> teste`
- `/stallpack <stallId>`

## Criterios de aceite

- Nenhuma acao critica depende de dados confiados pelo client.
- Compra usa transacao de banco e atualiza ouro, estoque, imposto e inventario de forma atomica.
- Guarda/fiscal sem permissao nao consegue fiscalizar, suspender ou confiscar.
- Barraca sem asset visual continua funcionando logicamente.
- Barraca com asset visual gera `visual_ref_id` e desativa o objeto ao recolher.
- Falha de spawn visual nao bloqueia o sistema economico.

## Riscos restantes

- `ObjectReference.PlaceAtMe` precisa ser confirmado no runtime SkyMP com o plugin final carregado.
- Objetos visuais precisam de permissao/licenca registrada antes de entrar no modpack.
- O teste local nao prova sincronizacao de late join nem persistencia visual apos restart.
