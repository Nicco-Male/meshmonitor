# MeshMonitor custom integration — blocco 2

15 settembre 2026. Scheduler centrale reintegrato sul ramo `integration/upstream-custom-20260915`, a partire dal checkpoint `b47f06fd1562883582714ce040eeafa2b971553e`. La base rimane upstream **4.16.1-rc3**, `51023a75688e133853bd2dd0224063888b3d671b`. Nessun aggiornamento di `main`.

## Funzionalità reintegrate

| Area | Risultato |
| --- | --- |
| Coda condivisa | Un solo traceroute Meshtastic attivo tra tutte le sorgenti. Rilascio su risposta corrispondente oppure timeout di default 75 s, seguito da cooldown 5 s. Nessun dominio RF configurabile. |
| Priorità e deduplica | Manuale, campagna, automazione, automatico, retry; FIFO a parità di priorità e retry in fondo. Duplicati per sorgente/nodo locale/destinazione/canale condividono l'invio. Una richiesta già attiva non viene interrotta da priorità maggiori. |
| Manager | Gli ingressi manuali esistenti passano automaticamente dalla nuova coda. Autotrace usa `automatic`; Automation Engine e Auto Responder usano `automation`. Il corpo upstream dell'invio del pacchetto è conservato integralmente in `sendTraceroutePacket`. |
| Convivenza e ciclo di vita | Autotrace salta una sorgente con lavoro pendente. Attesa in coda esclusa dai suoi clock e dal timeout di risposta dell'Auto Responder. Disconnessione cancella il lavoro non inviato della sorgente; il trace già trasmesso conserva lo slot RF. Connessione, nodo locale e permesso TX vengono ricontrollati prima dell'invio. |
| API e test | Stato coda con autenticazione reale e filtri di sorgente/canale. Recuperati ed estesi test dello scheduler; aggiunte regressioni tra due manager e test di permessi con `createRouteTestApp`. |

Sono coperti gli otto file assegnati al blocco 2 nell'inventario, più il nuovo test di permessi della route. I due file del manager hanno ancora gli agganci alle campagne assegnati al blocco 3. Non sono stati aggiunti coordinator, service, router o pagina campagne.

Rispetto al vecchio scheduler sono state adattate le risposte senza sorgente (non rilasciano lo slot), la corrispondenza del canale quando disponibile, la cancellazione alla disconnessione e gli errori della guardia di dispatch. Una risposta veloce non permette al prossimo callback di invio di sovrapporsi a quello precedente ancora in corso.

## Contratto per i prossimi blocchi

```text
GET /api/traceroutes/scheduler/status?sourceId=<source-id>
```

La sorgente è obbligatoria. Si applicano `traceroute:read` sulla sorgente e la stessa visibilità del canale usata per i traceroute salvati. La risposta è `{ success: true, data: { maxActive, cooldownMs, active, queue } }`; gli errori usano `fail()` e un codice stabile. Anche l'amministratore riceve solo la sorgente richiesta.

La vecchia UI custom che richiedeva uno stato globale senza `sourceId` e leggeva direttamente il payload va adattata nel blocco 4. `active: null` significa che non c'è un trace attivo visibile **per quella sorgente**, non che l'arbitro globale sia libero. La coda interna resta unica.

`sendTraceroute()` si risolve dopo l'invio, non alla ricezione di una route. L'attesa in coda può prolungare le chiamate HTTP manuali e i passi delle automazioni che già attendono questo metodo. Questo blocco mantiene quel contratto custom; l'API non è stata trasformata in un protocollo di job HTTP. Le operazioni asincrone Remote Admin upstream restano invariate.

Il blocco 3 deve aggiungere `sendCampaignTraceroute`, riserva/rilascio sorgenti e gestione campaign-busy sopra questa coda. Sono già disponibili `priority`, `timeoutMs`, `shouldDispatch`, `hasPendingForSource` e `TracerouteRequestCancelledError`. Le priorità campagna/retry sono testate nella coda ma non costituiscono ancora una campagna utilizzabile.

## Verifiche

| Controllo | Esito |
| --- | --- |
| Regressioni mirate | PASS: 16 file, 249 test, 0 fallimenti, 9,34 s. Dopo la correzione del fixture, rieseguiti i due file interessati: 26 test PASS. Elenco riproducibile sotto. |
| Build client e server | PASS: `npm run build` e `npm run build:server`, entrambi exit 0. |
| Lint | PASS: `npm run lint:ci`, regole/locali/ratchet. Baseline invariato; ESLint sui file di test e scheduler riconfermato dopo la correzione del fixture. |
| Import del server compilato | PASS: 654 moduli con la copia compatibile del checker descritta nella baseline del blocco 1. Lo script upstream non è stato modificato. |
| Protezione Remote Admin | Suite hop limit, transazioni, servizi e operazioni HTTP asincrone passate. I blob di protobufService, remoteAdminService e adminTransactionService sono identici alla base upstream. Diff del manager limitato al traceroute e alla sua cancellazione nel ciclo di connessione. |
| Tipi dei test | PASS su tutti i sorgenti di produzione e i quattro file di test modificati, con configurazione temporanea derivata da `tsconfig.tests.json` e heap 4 GB. Il gate globale conserva gli errori preesistenti descritti sotto. |

```bash
npx vitest run \
  src/server/services/tracerouteRequestScheduler.test.ts \
  src/server/meshtasticManager.tracerouteScheduler.test.ts \
  src/server/routes/tracerouteRoutes.scheduler.perSource.test.ts \
  src/server/services/automation/meshActionDeps.test.ts \
  src/server/meshtasticManager.txDisabled.test.ts \
  src/server/meshtasticManager.udpBroadcastTxGuard.test.ts \
  src/server/meshtasticManager.autoAckResponderPingTxDisabled.test.ts \
  src/server/meshtasticManager.traceroute-hops.test.ts \
  src/server/routes/tracerouteRoutes.test.ts \
  src/server/routes/tracerouteRoutes.participation.test.ts \
  src/server/meshtasticManager.adminHopLimit.test.ts \
  src/server/protobufService.adminHopLimit.test.ts \
  src/server/routes/adminRoutes.asyncOperations.test.ts \
  src/server/services/remoteAdminService.test.ts \
  src/server/services/adminTransactionService.test.ts \
  src/server/services/nodeInfoEnrichment.hwModelUnset.test.ts
```

La verifica riguarda scheduler, instradamento, guardie TX, permessi e regressioni Admin. Non è l'intera suite del progetto, non avvia server o radio reali e non certifica PostgreSQL/MySQL o il sistema completo. Queste verifiche integrate restano nel blocco 9; in questo blocco non cambiano schema, query di produzione, dipendenze, versioni o submodule.

## Limiti preesistenti rilevati

`npm run typecheck:tests` supera il limite heap Node di circa 2 GB nell'ambiente corrente. Con 6 GB il compilatore conclude, ma segnala **2.374 errori già presenti nella base**. Il conteggio è stato verificato con un compiler host che legge dal checkpoint precedente i file modificati ed esclude le nuove aggiunte, senza alterare il checkout o i nodi. Il primo candidato aggiungeva un solo errore: un fixture DbNode incompleto nel nuovo test dell'autoresponder; è stato corretto aggiungendo i quattro campi obbligatori. La verifica successiva comprende tutti i sorgenti di produzione e i quattro test modificati, esclude gli altri file `*.test`/`*.spec` e termina con exit 0. Questo gate globale non viene dichiarato verde né usato per nascondere i problemi upstream.

Resta anche il problema `check:imports` già documentato nel blocco 1: la versione installata di es-module-lexer espone `specifier`, mentre lo script upstream legge `n`. Il controllo valido qui usa temporaneamente `i.n ?? i.specifier`.

Durante il porting è stato osservato che l'aggiornamento dei risultati nel log autotrace upstream (`updateAutoTracerouteResultByNodeAsync`) seleziona per nodo senza sorgente. Lo scheduler e la nuova API hanno scope verificato; la riconciliazione di quel log DB rimane un punto da affrontare con il lavoro DB/source del blocco 8.

## Impatto sulla mesh e ripresa

Si accodano le richieste già generate dagli ingressi esistenti: nessun nuovo timer periodico, fan-out o retry automatico aggiuntivo. I limiti di 1 attivo, 75 s e 5 s sono quelli fissati nel blocco 1 dal backup custom. Riavviare o disabilitare l'autotrace non azzera lo slot globale o il cooldown. La deduplica riduce gli invii equivalenti; gli errori e le cancellazioni non lasciano la coda bloccata.

Prossima operazione autorizzabile separatamente: **blocco 3, backend delle campagne**. Ripartire dal ramo remoto di integrazione e dal [registro](custom-integration-progress.md); `main` e i due backup rimangono ai riferimenti documentati.
