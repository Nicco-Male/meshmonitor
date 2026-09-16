# MeshMonitor — blocco 3: backend campagne traceroute

Completato il 16 settembre 2026 sul ramo `integration/upstream-custom-20260915`, partendo dal checkpoint del blocco 2 `2a4ef391098dc96e682768465b0f186064be1169`. Base upstream conservata: `51023a75688e133853bd2dd0224063888b3d671b` (4.16.1-rc3). `main` e i due backup restano invariati; la promozione finale appartiene al blocco 9.

## Funzionalità reintegrate

Tipi condivisi, coordinator, servizio in memoria e router campagne recuperati dal backup custom e adattati alle API upstream. Per ogni target, nell'ordine selezionato, le sorgenti vengono ordinate per successo recente: più recente prima, poi ordine originale per quelle senza successi. Il lookup considera entrambi gli orientamenti degli endpoint, la finestra temporale, la sorgente e il canale effettivo. Una route diretta `[]` è un successo; una riga di richiesta senza payload route/SNR non lo è.

Le modalità sono `continue` (tutte le sorgenti) e `stop-on-success` (salta le altre sorgenti dello stesso target dopo il primo successo e passa al prossimo target). Sono esposti stato, avanzamento, tempi, errori, route di andata/ritorno, SNR e hop. Un target uguale al nodo locale viene saltato. Retry crea una nuova campagna collegata all'originale e contenente soltanto tentativi `timeout`/`error`; non introduce retry periodici o illimitati.

Una campagna alla volta, massimo 100 target, 20 sorgenti e 20 campagne conservate in memoria, come nel backup. Nessuna migrazione o persistenza aggiunta: il riavvio perde lo storico delle campagne, mentre i traceroute seguono la persistenza upstream. Nessun nuovo timer periodico o richiesta radio al boot.

## Scheduler, riserve e cancellazione

Tutti gli invii passano dallo scheduler del blocco 2: **un solo traceroute globale attivo**, cooldown 5 s; nessun dominio RF configurabile. Priorità: manuale, campagna, automazione, automatico, retry. Le sorgenti selezionate vengono riservate atomicamente e rilasciate alla fine, in caso di errore di preparazione o di cancellazione. Un nuovo avvio rimane bloccato fino al rilascio.

`sendCampaignTraceroute` conserva i controlli upstream di connessione, nodo locale e TX; non modifica il corpo di trasmissione dei pacchetti. Un callback asincrono verifica nuovamente i permessi quando il tentativo raggiunge l'invio, dopo un'eventuale attesa in coda. Connessione, identità del trasporto e cancellazione vengono ricontrollate dopo quel callback.

Il timeout della campagna comincia dopo la trasmissione, non in coda. Il waiter ignora risultati precedenti all'invio, di un'altra sorgente, di un altro canale noto o di un'altra coppia di nodi. Cattura anche una risposta veloce, arrivata mentre l'invio sta ancora completando la persistenza locale. Una disconnessione conclude il tentativo con errore. Gli eventi privi di canale mantengono la compatibilità con gli emitter upstream; non è disponibile una correlazione end-to-end per request ID.

Ogni tentativo dispone di un `AbortSignal` proprio: la cancellazione elimina subito il lavoro non inviato e interrompe anche le attese locali. Non cancella richieste equivalenti di altri chiamanti e non libera anticipatamente lo slot RF di un pacchetto già inviato. La deduplica ordinaria continua a funzionare; richieste con diversa proprietà della cancellazione rimangono distinte. Le sorgenti tornano disponibili dopo la chiusura del runner, ma un trace già trasmesso continua a occupare lo scheduler fino a risposta/timeout.

Il manager respinge con `TRACEROUTE_CAMPAIGN_ACTIVE` anche un normale trace accodato prima della riserva e giunto al dispatch dopo l'avvio della campagna. L'autotrace salta la selezione su sorgenti riservate. Entrambi gli ingressi manuali restituiscono 409; l'Automation Engine registra uno skip per la sorgente occupata e prosegue sulle altre. Il corpo della risposta di successo del vecchio ingresso manuale rimane compatibile.

## Contratto API per il blocco 4

Il router è montato su `/api/traceroute-campaigns`. Tutte le route richiedono una sessione autenticata o un Bearer token valido; l'utente anonimo non può avviare o leggere campagne. Proprietario e admin possono accedere ai record, sempre con i permessi correnti per sorgenti e canali.

| Richiesta | Risposta di successo |
| --- | --- |
| `POST /api/traceroute-campaigns` | 202 `{ success: true, data: campaign }` |
| `GET /api/traceroute-campaigns/active` | 200 `{ success: true, data: { campaign } }`, anche `null` |
| `GET /api/traceroute-campaigns/latest` | 200 `{ success: true, data: { campaign } }`, anche `null` |
| `GET /api/traceroute-campaigns/:id` | 200 `{ success: true, data: campaign }` |
| `POST /api/traceroute-campaigns/:id/retry` | 202 `{ success: true, data: campaign }`, con `retryOfCampaignId` |
| `POST /api/traceroute-campaigns/:id/cancel` | 200 `{ success: true, data: campaign }` |

La vecchia UI del backup leggeva payload senza envelope: **adattare i consumer per leggere `data`**, senza modificare globalmente `ApiService`. Alla cancellazione lo stato della campagna cambia subito; l'ultimo job può raggiungere lo stato terminale nel successivo polling.

Body di creazione: `targets: [{ nodeNum, nodeId?, name? }]`, `sourceIds: string[]`, `recentSuccessHours` (1–720), `behavior` (`continue`/`stop-on-success`), `timeoutSeconds` (5–300), `delaySeconds` (0–300). Target unicast validi e sorgenti vengono deduplicati conservando l'ordine; gli ID delle sorgenti vengono normalizzati prima del controllo dei permessi. I limiti si applicano all'input ricevuto, prima della deduplica.

Sono ammesse sorgenti Meshtastic TCP abilitate e connesse, con nodo locale disponibile; il canale viene risolto con `resolveBroadcastChannel` upstream. `campaign.sources[].channel` è ora obbligatorio; `jobs[].channel` viene valorizzato quando si prepara il tentativo. Adeguare anche i fixture della UI.

Creazione e tentativi richiedono `traceroute:read`, `traceroute:write` e `channel_N:viewOnMap` sulla sorgente effettiva. Il servizio verifica l'utente attivo e i permessi prima del tentativo e di nuovo al dispatch. Le letture richiedono read e visibilità di tutti i canali presenti nella snapshot: negare l'accesso restituisce 403 senza risultati parziali. Retry richiede visibilità dell'originale e write sui tentativi da ripetere. Cancel richiede read/write e visibilità; se i permessi del proprietario vengono revocati, l'admin può arrestare la campagna.

Errori delle route campagne: `{ success: false, error, code }`. Esempi: 400 input non valido/nessun fallimento da ripetere, 401 autenticazione richiesta (middleware upstream), 403 permessi, 404 record inesistente o di altro proprietario, 409 campagna già in esecuzione/sorgente non disponibile. Non esporre risultati di altre sorgenti tramite lo stato della campagna.

Lo stato dello scheduler continua a richiedere `GET /api/traceroutes/scheduler/status?sourceId=...` e restituisce `{ success: true, data: status }` filtrato per sorgente/canale. Un `active: null` filtrato non implica che lo slot globale sia libero.

## Verifiche

| Controllo | Esito |
| --- | --- |
| Test pertinenti e regressioni | **24 file, 496 test superati**, 46 saltati (suite PostgreSQL/MySQL senza container). Include campagne, query SQLite, API con middleware reale, scheduler, manager, TX, automazioni e Remote Admin. |
| Build client | `npm run build` — superata. |
| Build server | `npm run build:server` — superata dopo il build client. |
| Lint | `npm run lint:ci` — superato, baseline invariata. |
| Tipi | Tutti i sorgenti di produzione e gli 8 file di test aggiunti/modificati, compilati con tsconfig temporaneo e heap 4 GB — superati. |
| Import runtime | Checker compatibile `i.n ?? i.specifier`: **657 moduli**, tutti gli import relativi statici risolvibili sotto Node ESM. |
| Preservazione upstream | `protobufService.ts`, `remoteAdminService.ts`, `adminTransactionService.ts` identici alla base; corpo di `sendTraceroutePacket` identico al vecchio `sendTraceroute` upstream. |

Il controllo dei tipi ha evidenziato tre problemi preesistenti nei test ora interessati: un'asserzione sul campo runtime `sourceId` non dichiarato in `DbTraceroute` e due fixture di trigger schedule senza `subjectNodeNum`. Corretti con un'asserzione strutturale equivalente e `subjectNodeNum: null`, senza cambiare i tipi di produzione. I due file sono stati rieseguiti dopo la correzione.

Rimangono i limiti globali documentati nel blocco 2: `typecheck:tests` dell'intero progetto non è verde (2.374 errori sulla base verificata allora); il checker import upstream con es-module-lexer installato visita un solo modulo e non costituisce una verifica valida. Non sono stati ripetuti quei controlli globali già diagnosticati. Nessun test ha usato radio o database di produzione; PostgreSQL/MySQL e collaudo completo restano nel blocco 9.

Per ripetere i test, usare la lista del blocco 2 e aggiungere:

```bash
npx vitest run \
  src/server/services/tracerouteCampaignService.test.ts \
  src/server/services/tracerouteCampaignCoordinator.test.ts \
  src/server/routes/tracerouteCampaignRoutes.perSource.test.ts \
  src/server/routes/meshRequestRoutes.campaign.perSource.test.ts \
  src/db/repositories/traceroutes.test.ts \
  src/server/services/automation/actionExecutor.test.ts \
  src/server/routes/meshRequestRoutes.test.ts \
  src/server/routes/v1/actions.test.ts
```

## Prossimo blocco

**Blocco 4: pagina/panel campagne, accesso dal dashboard, nuova scheda, ricerca long/short name, selezione e ordinamento target, polling di avanzamento, retry e dettagli.** Recuperare il delta storico, adattando gli envelope API e i campi canale qui documentati. Nessuna UI è stata portata in questo blocco. Le altre modifiche DB (orientamento/persistenza), MQTT e source handling restano nel blocco 8.
