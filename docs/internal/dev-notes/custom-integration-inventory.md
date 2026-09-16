# Inventario custom MeshMonitor — blocco 1

Inventario storico fissato nel blocco 1 il 15 settembre 2026. Stato del porting aggiornato al blocco 3; le classificazioni descrivono il confronto iniziale, non il tree corrente.

| Riferimento | SHA |
| --- | --- |
| Base storica | `1bd63a1422aa3b9326361c419a96f9c324010a19` |
| Backup custom | `54dbf4dfa9024d9935d706680bad522917dda82f` |
| Upstream fissato | `51023a75688e133853bd2dd0224063888b3d671b` |

## Risultato

| Decisione | File | Significato |
| --- | ---: | --- |
| PORTARE | 35 | 23 aggiunte custom assenti upstream e 12 file il cui contenuto upstream è identico alla base storica. Import, tipi e integrazione vanno comunque validati. |
| ADATTARE | 50 | Delta custom da riportare su file cambiati anche upstream; merge semantico necessario. |
| COPERTO | 3 | Stesso requisito custom già implementato upstream in modo diverso: conservare la nuova implementazione e i suoi test. |

L’inventario comprende tutti gli **88 file** dei **58 commit** custom: **8.355 righe aggiunte, 755 rimosse**. Non comprende i file modificati soltanto da upstream, che restano integralmente nella nuova base. Nessun file coincide interamente con il vecchio file custom; COPERTO indica equivalenza della funzionalità, non identità del blob.

Il confronto a tre versioni è stato eseguito soltanto su copie temporanee. Sui 53 file modificati da entrambi i rami (compresi i 3 COPERTO) il controllo testuale segnala 27 file con sovrapposizioni; 24 restano tra gli ADATTARE. Un controllo testuale senza conflitti non dimostra compatibilità semantica. Non è stato eseguito un merge di branch o applicato il risultato della simulazione al repository.

## Dipendenze e punti di attenzione

| Punto | Decisione per il porting |
| --- | --- |
| Scheduler/campagne | Nel blocco 2 portare lo scheduler autonomo; riserva delle sorgenti e agganci al coordinator arrivano nel blocco 3, evitando import non risolti. |
| Limite RF effettivo | Il backup implementa un solo trace globale attivo per tutte le sorgenti, cooldown 5 s, timeout di default 75 s. Non distingue domini RF configurabili. Conservare inizialmente questo comportamento. |
| Query campagne | `getLatestSuccessfulTracerouteByNodes` va portata già nel blocco 3. La normalizzazione MQTT/DB rimane al blocco 8 salvo dipendenze concrete. |
| NodeInfo | #5198 include già il trattamento di HardwareModel.UNSET e aggiunge verifica delle copie e uso del canale del target; non ripristinare i vecchi tre file. |
| Frontend e mappe | Preservare nuovi report, UI mobile, filtri, helper API, UiIcon, CSS module, Carto con chiave/Esri e worker MapLibre. La sostituzione OpenFreeMap richiede verifica dei vecchi ID salvati. |

## Come verificare l’inventario

```bash
git diff --name-status 1bd63a1422aa3b9326361c419a96f9c324010a19 54dbf4dfa9024d9935d706680bad522917dda82f
git diff --stat 1bd63a1422aa3b9326361c419a96f9c324010a19 54dbf4dfa9024d9935d706680bad522917dda82f
```

Per ogni percorso, confrontare i blob delle tre revisioni con `git ls-tree` e il delta storico con `git diff BASE CUSTOM -- percorso`. Usare il backup soltanto per il delta custom: il confronto diretto upstream→backup include anche rimozioni di novità upstream che non vanno ripristinate.

## Blocco 2 — Scheduler e agganci condivisi (8 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C001 | `docs/features/automation-engine.md` | ADATTARE | 2 | 0 | **Blocco 2 completato.** Documentare coda, priorità e serializzazione senza perdere le nuove funzionalità del motore upstream. |
| C054 | `src/server/meshtasticManager.tracerouteScheduler.test.ts` | PORTARE | 2, 3 | — | **Blocchi 2–3 completati.** Estendere i test upstream dell’autotrace con le esclusioni per coda occupata e campagne. |
| C055 | `src/server/meshtasticManager.ts` | ADATTARE | 2, 3 | 0 | **Blocchi 2–3 completati.** Portare solo gli agganci scheduler/campagne. Conservare getConfiguredHopLimit, servizi Admin, macchina a stati e gli aggiornamenti upstream. |
| C064 | `src/server/routes/tracerouteRoutes.ts` | ADATTARE | 2 | 1 | **Blocco 2 completato.** Aggiungere stato della coda preservando route di partecipazione, permessi e filtri di canale upstream; riesaminare lo scope dei dati restituiti. |
| C067 | `src/server/services/automation/meshActionDeps.test.ts` | ADATTARE | 2 | 0 | **Blocco 2 completato.** Passare la priorità automation allo scheduler preservando adattatore e comportamento delle altre azioni. |
| C068 | `src/server/services/automation/meshActionDeps.ts` | ADATTARE | 2 | 0 | **Blocco 2 completato.** Passare la priorità automation allo scheduler preservando adattatore e comportamento delle altre azioni. |
| C078 | `src/server/services/tracerouteRequestScheduler.test.ts` | PORTARE | 2 | — | **Blocco 2 completato.** Aggiungere coda globale, deduplica, priorità, cooldown e rilascio su risposta/timeout. Il vecchio codice serializza tutte le sorgenti insieme; non dispone ancora di domini RF separati. |
| C079 | `src/server/services/tracerouteRequestScheduler.ts` | PORTARE | 2 | — | **Blocco 2 completato.** Aggiungere coda globale, deduplica, priorità, cooldown e rilascio su risposta/timeout. Il vecchio codice serializza tutte le sorgenti insieme; non dispone ancora di domini RF separati. |

## Blocco 3 — Campagne backend e dati necessari (11 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C040 | `src/db/repositories/traceroutes.test.ts` | ADATTARE | 3, 8 | 0 | **Blocco 3 completato:** query dell’ultimo trace riuscito per sorgente/canale. Blocco 8: orientamento canonico risposta e persistenza; conservare routePositions, query di partecipazione e supporto ai tre DB. |
| C041 | `src/db/repositories/traceroutes.ts` | ADATTARE | 3, 8 | 3 | **Blocco 3 completato:** query dell’ultimo trace riuscito per sorgente/canale. Blocco 8: orientamento canonico risposta e persistenza; conservare routePositions, query di partecipazione e supporto ai tre DB. |
| C061 | `src/server/routes/meshRequestRoutes.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Delta custom: trattamento degli errori di sorgente riservata da una campagna. Preservare gli errori e gli helper API upstream. |
| C063 | `src/server/routes/tracerouteCampaignRoutes.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Aggiungere tipi/coordinamento/service/routes delle campagne, sequenza multi-source, retry finali, criteri di successo e dettagli hop; adeguare API e permessi. |
| C065 | `src/server/routes/v1/actions.ts` | ADATTARE | 3 | 1 | **Blocco 3 completato.** Delta custom: trattamento degli errori di sorgente riservata da una campagna. Preservare gli errori e gli helper API upstream. |
| C066 | `src/server/server.ts` | ADATTARE | 3 | 0 | **Blocco 3 completato.** Montare il router campagne rispettando ordine del middleware e autenticazione upstream. |
| C074 | `src/server/services/tracerouteCampaignCoordinator.test.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Aggiungere tipi/coordinamento/service/routes delle campagne, sequenza multi-source, retry finali, criteri di successo e dettagli hop; adeguare API e permessi. |
| C075 | `src/server/services/tracerouteCampaignCoordinator.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Aggiungere tipi/coordinamento/service/routes delle campagne, sequenza multi-source, retry finali, criteri di successo e dettagli hop; adeguare API e permessi. |
| C076 | `src/server/services/tracerouteCampaignService.test.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Aggiungere tipi/coordinamento/service/routes delle campagne, sequenza multi-source, retry finali, criteri di successo e dettagli hop; adeguare API e permessi. |
| C077 | `src/server/services/tracerouteCampaignService.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Aggiungere tipi/coordinamento/service/routes delle campagne, sequenza multi-source, retry finali, criteri di successo e dettagli hop; adeguare API e permessi. |
| C082 | `src/types/tracerouteCampaign.ts` | PORTARE | 3 | — | **Blocco 3 completato.** Aggiungere tipi/coordinamento/service/routes delle campagne, sequenza multi-source, retry finali, criteri di successo e dettagli hop; adeguare API e permessi. |

Adattamenti aggiuntivi del blocco 3, esterni all'inventario storico di 88 file: test API con middleware reale in `tracerouteCampaignRoutes.perSource.test.ts` e `meshRequestRoutes.campaign.perSource.test.ts`; gestione dello skip campaign-busy e test in `services/automation/actionExecutor.ts` e `.test.ts`. I file scheduler del blocco 2 ricevono cancellazione per tentativo e protezione della deduplica tra proprietari diversi. [Rapporto del blocco 3](custom-integration-block3.md).

## Blocco 4 — UI campagne (8 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C014 | `src/components/Dashboard/TracerouteCampaignPanel.test.tsx` | PORTARE | 4 | — | Aggiungere pagina/panel e test; ricerca long/short name, selezione manuale, ordinamento, nuova scheda, retry, coda e dettagli. Adeguare i nuovi componenti ad ApiService/UiIcon e agli stili previsti upstream. |
| C015 | `src/components/Dashboard/TracerouteCampaignPanel.tsx` | PORTARE | 4 | — | Aggiungere pagina/panel e test; ricerca long/short name, selezione manuale, ordinamento, nuova scheda, retry, coda e dettagli. Adeguare i nuovi componenti ad ApiService/UiIcon e agli stili previsti upstream. |
| C048 | `src/main.tsx` | ADATTARE | 4 | 1 | Registrare la pagina campagne senza perdere le route aggiunte upstream. |
| C049 | `src/pages/DashboardPage.test.tsx` | ADATTARE | 4 | 2 | Ripristinare l’accesso alle campagne in pagina separata/nuova scheda e i test; preservare dashboard upstream. |
| C050 | `src/pages/DashboardPage.tsx` | ADATTARE | 4 | 0 | Ripristinare l’accesso alle campagne in pagina separata/nuova scheda e i test; preservare dashboard upstream. |
| C051 | `src/pages/TracerouteCampaignPage.test.tsx` | PORTARE | 4 | — | Aggiungere pagina/panel e test; ricerca long/short name, selezione manuale, ordinamento, nuova scheda, retry, coda e dettagli. Adeguare i nuovi componenti ad ApiService/UiIcon e agli stili previsti upstream. |
| C052 | `src/pages/TracerouteCampaignPage.tsx` | PORTARE | 4 | — | Aggiungere pagina/panel e test; ricerca long/short name, selezione manuale, ordinamento, nuova scheda, retry, coda e dettagli. Adeguare i nuovi componenti ad ApiService/UiIcon e agli stili previsti upstream. |
| C081 | `src/styles/dashboard.css` | ADATTARE | 4, 5, 6 | 0 | Distribuire gli stili custom per feature; preferire CSS module nei nuovi componenti e mantenere regole/layout mobile upstream. |

## Blocco 5 — Percorsi, snapshot e popup (20 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C008 | `src/components/Dashboard/DashboardMap.test.tsx` | ADATTARE | 5, 6 | 9 | Integrare popup/segmenti/hop stimati e stili dei nodi. Preservare filtri, resa mobile, marker cache e nuove funzioni upstream. |
| C009 | `src/components/Dashboard/DashboardMap.tsx` | ADATTARE | 5, 6 | 6 | Integrare popup/segmenti/hop stimati e stili dei nodi. Preservare filtri, resa mobile, marker cache e nuove funzioni upstream. |
| C010 | `src/components/Dashboard/DashboardNeighborPopup.test.tsx` | PORTARE | 5 | — | Ripristinare etichetta NeighborInfo esplicita e distinzione dai traceroute. |
| C011 | `src/components/Dashboard/DashboardNeighborPopup.tsx` | PORTARE | 5 | — | Ripristinare etichetta NeighborInfo esplicita e distinzione dai traceroute. |
| C025 | `src/components/TracerouteWidget.tsx` | ADATTARE | 5 | 0 | Abilitare hop stimati e traceKey, mantenendo nuovi dettagli/selezione dei traceroute upstream. |
| C029 | `src/components/map/layers/TraceroutePathsLayer.mapTtl.test.tsx` | PORTARE | 5 | — | Ripristinare dettagli dei segmenti, marker hop stimati e TTL condiviso delle mappe normali. Non estendere il limite alle viste storiche selezionate. |
| C030 | `src/components/map/layers/TraceroutePathsLayer.test.tsx` | PORTARE | 5 | — | Ripristinare dettagli dei segmenti, marker hop stimati e TTL condiviso delle mappe normali. Non estendere il limite alle viste storiche selezionate. |
| C031 | `src/components/map/layers/TraceroutePathsLayer.tsx` | PORTARE | 5 | — | Ripristinare dettagli dei segmenti, marker hop stimati e TTL condiviso delle mappe normali. Non estendere il limite alle viste storiche selezionate. |
| C034 | `src/components/map/popups/RouteSegmentPopup.test.tsx` | PORTARE | 5 | — | Aggiungere popup con origine del collegamento e dettagli hop; distinguere SNR sconosciuto da trasporto IP. |
| C035 | `src/components/map/popups/RouteSegmentPopup.tsx` | PORTARE | 5 | — | Aggiungere popup con origine del collegamento e dettagli hop; distinguere SNR sconosciuto da trasporto IP. |
| C042 | `src/hooks/useSourceView.ts` | ADATTARE | 5 | 1 | Propagare routePositions e mantenere nodi senza posizione eleggibili per gli hop stimati, senza eliminare i filtri source/transport upstream. |
| C043 | `src/hooks/useTracerouteAnalysis.test.ts` | ADATTARE | 5 | 0 | Distinguere snrUnknown da isMqtt: il sentinel SNR non prova il trasporto IP. |
| C044 | `src/hooks/useTracerouteAnalysis.ts` | ADATTARE | 5 | 0 | Distinguere snrUnknown da isMqtt: il sentinel SNR non prova il trasporto IP. |
| C045 | `src/hooks/useTraceroutePaths.mapTtl.test.tsx` | PORTARE | 5 | — | Merge semantico di snapshot, hop anonimi/stimati, movimento e TTL 4h. Preservare risoluzione coordinate nulle valide, filtri dei nodi e refactoring upstream. |
| C046 | `src/hooks/useTraceroutePaths.test.tsx` | PORTARE | 5 | — | Merge semantico di snapshot, hop anonimi/stimati, movimento e TTL 4h. Preservare risoluzione coordinate nulle valide, filtri dei nodi e refactoring upstream. |
| C047 | `src/hooks/useTraceroutePaths.tsx` | ADATTARE | 5 | 14 | Merge semantico di snapshot, hop anonimi/stimati, movimento e TTL 4h. Preservare risoluzione coordinate nulle valide, filtri dei nodi e refactoring upstream. |
| C085 | `src/utils/tracerouteSegments.movement.test.ts` | PORTARE | 5 | — | Integrare topologia fedele, snapshot stretti, invalidazione movimento, stime condivise e SNR senza inferire IP; preservare helper usati dai nuovi consumer upstream. |
| C086 | `src/utils/tracerouteSegments.snapshotStrict.test.ts` | PORTARE | 5 | — | Integrare topologia fedele, snapshot stretti, invalidazione movimento, stime condivise e SNR senza inferire IP; preservare helper usati dai nuovi consumer upstream. |
| C087 | `src/utils/tracerouteSegments.test.ts` | ADATTARE | 5 | 0 | Integrare topologia fedele, snapshot stretti, invalidazione movimento, stime condivise e SNR senza inferire IP; preservare helper usati dai nuovi consumer upstream. |
| C088 | `src/utils/tracerouteSegments.ts` | ADATTARE | 5 | 7 | Integrare topologia fedele, snapshot stretti, invalidazione movimento, stime condivise e SNR senza inferire IP; preservare helper usati dai nuovi consumer upstream. |

## Blocco 6 — Marker e mappe di base (18 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C012 | `src/components/Dashboard/DashboardNodePopup.test.tsx` | ADATTARE | 6 | 0 | Ripristinare indicazione/gestione della posizione stimata del nodo e relativo test. |
| C013 | `src/components/Dashboard/DashboardNodePopup.tsx` | PORTARE | 6 | — | Ripristinare indicazione/gestione della posizione stimata del nodo e relativo test. |
| C016 | `src/components/MapAnalysis/MapLegend.tsx` | PORTARE | 6 | — | Reintegrare legende ruolo/mobilità; conservare le nuove voci e la modalità hop shading. |
| C017 | `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx` | ADATTARE | 6 | 0 | Propagare mobile/isMobile e invalidare correttamente la cache delle icone, mantenendo hop shading e filtri upstream. |
| C018 | `src/components/MapAnalysis/useAnalysisNodes.ts` | ADATTARE | 6 | 0 | Propagare mobile/isMobile e invalidare correttamente la cache delle icone, mantenendo hop shading e filtri upstream. |
| C019 | `src/components/MapLegend.tsx` | ADATTARE | 6 | 4 | Reintegrare legende ruolo/mobilità; conservare le nuove voci e la modalità hop shading. |
| C020 | `src/components/NodesTab.tsx` | ADATTARE | 6 | 1 | Ripristinare stili ruolo/mobilità e firma cache dei marker preservando nuovi filtri e layout upstream. |
| C024 | `src/components/TilesetSelector.tsx` | ADATTARE | 6 | 1 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C026 | `src/components/VectorTileLayer.tsx` | ADATTARE | 6 | 0 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C027 | `src/components/map/BaseMap.test.tsx` | ADATTARE | 6 | 1 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C028 | `src/components/map/BaseMap.tsx` | ADATTARE | 6 | 1 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C032 | `src/components/map/markerIcons.test.ts` | ADATTARE | 6 | 1 | Ripristinare colori per ruoli e marker mobili, mantenendo UiIcon e i nuovi marker/indicatori upstream. |
| C033 | `src/components/map/markerIcons.ts` | ADATTARE | 6 | 3 | Ripristinare colori per ruoli e marker mobili, mantenendo UiIcon e i nuovi marker/indicatori upstream. |
| C036 | `src/config/basemap3d.test.ts` | ADATTARE | 6 | 1 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C037 | `src/config/basemap3d.ts` | ADATTARE | 6 | 0 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C038 | `src/config/tilesets.ts` | ADATTARE | 6 | 1 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C056 | `src/server/middleware/dynamicCsp.test.ts` | ADATTARE | 6 | 0 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |
| C057 | `src/server/middleware/dynamicCsp.ts` | ADATTARE | 6 | 0 | Ripristinare OpenFreeMap/styleUrl/CSP per le preferenze carto* esistenti. Upstream ha ora Carto con chiave, Esri Dark e gestione worker MapLibre: conservare queste aggiunte e verificarne la compatibilità. |

## Blocco 7 — Telemetria (12 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C003 | `public/locales/en.json` | ADATTARE | 7 | 0 | Delta custom relativo a telemetryChannelLabels: allowlist impostazioni, test e traduzione. Mantenere tutte le altre chiavi upstream. |
| C004 | `src/components/Analysis/AnalysisTab.tsx` | ADATTARE | 7 | 1 | Ripristinare report telemetria per nodo, ricerca nomi/ID, aggregazione sorgenti e nomi dei canali; integrare il catalogo report upstream. |
| C005 | `src/components/Analysis/NodeTelemetryReport.module.css` | PORTARE | 7 | — | Ripristinare report telemetria per nodo, ricerca nomi/ID, aggregazione sorgenti e nomi dei canali; integrare il catalogo report upstream. |
| C006 | `src/components/Analysis/NodeTelemetryReport.test.tsx` | PORTARE | 7 | — | Ripristinare report telemetria per nodo, ricerca nomi/ID, aggregazione sorgenti e nomi dei canali; integrare il catalogo report upstream. |
| C007 | `src/components/Analysis/NodeTelemetryReport.tsx` | PORTARE | 7 | — | Ripristinare report telemetria per nodo, ricerca nomi/ID, aggregazione sorgenti e nomi dei canali; integrare il catalogo report upstream. |
| C021 | `src/components/TelemetryGraphs.css` | ADATTARE | 7 | 1 | Ripristinare refresh e filtri disponibili anche senza dati. Conservare nuove regolazioni di densità marker e layout mobile upstream. |
| C022 | `src/components/TelemetryGraphs.test.tsx` | ADATTARE | 7 | 1 | Ripristinare refresh e filtri disponibili anche senza dati. Conservare nuove regolazioni di densità marker e layout mobile upstream. |
| C023 | `src/components/TelemetryGraphs.tsx` | ADATTARE | 7 | 5 | Ripristinare refresh e filtri disponibili anche senza dati. Conservare nuove regolazioni di densità marker e layout mobile upstream. |
| C053 | `src/server/constants/settings.ts` | ADATTARE | 7 | 0 | Delta custom relativo a telemetryChannelLabels: allowlist impostazioni, test e traduzione. Mantenere tutte le altre chiavi upstream. |
| C062 | `src/server/routes/settingsRoutes.test.ts` | ADATTARE | 7 | 0 | Delta custom relativo a telemetryChannelLabels: allowlist impostazioni, test e traduzione. Mantenere tutte le altre chiavi upstream. |
| C083 | `src/utils/telemetryChannelLabels.test.ts` | PORTARE | 7 | — | Ripristinare etichette ch1–ch8 per nodo/sorgente, serializzazione, validazione e test. |
| C084 | `src/utils/telemetryChannelLabels.ts` | PORTARE | 7 | — | Ripristinare etichette ch1–ch8 per nodo/sorgente, serializzazione, validazione e test. |

## Blocco 8 — MQTT, sorgenti e completezza (11 file)

| ID | File | Decisione | Blocchi | Sovrapposizioni testuali | Azione |
| --- | --- | --- | --- | ---: | --- |
| C002 | `docs/features/multi-source.md` | ADATTARE | 8 | 0 | Riconciliare documentazione di geometria/TTL traceroute, campagne e stili nodi con gli aggiornamenti multi-source upstream. |
| C039 | `src/db/repositories/index.ts` | ADATTARE | 8 | 0 | Esportare l’helper di normalizzazione degli endpoint quando reintegrato; conservare gli export upstream. |
| C058 | `src/server/mqttIngestion.test.ts` | ADATTARE | 8 | 0 | Conservare requestId/wantResponse dopo decrittazione e ignorare la gamba di richiesta per i trace completati; mantenere packet log, filtri e metadati upstream. |
| C059 | `src/server/mqttIngestion.ts` | ADATTARE | 8 | 0 | Conservare requestId/wantResponse dopo decrittazione e ignorare la gamba di richiesta per i trace completati; mantenere packet log, filtri e metadati upstream. |
| C060 | `src/server/mqttPacketFilter.ts` | PORTARE | 8 | — | Propagare requestId/wantResponse nella forma decifrata, conservando gli altri metadati; necessaria per distinguere richieste e risposte MQTT. |
| C069 | `src/server/services/channelDecryptionService.test.ts` | PORTARE | 8 | — | Propagare requestId/wantResponse nella forma decifrata, conservando gli altri metadati; necessaria per distinguere richieste e risposte MQTT. |
| C070 | `src/server/services/channelDecryptionService.ts` | PORTARE | 8 | — | Propagare requestId/wantResponse nella forma decifrata, conservando gli altri metadati; necessaria per distinguere richieste e risposte MQTT. |
| C071 | `src/server/services/nodeInfoCopyService.ts` | COPERTO | 8 | 2 | La correzione hwModel=0/HardwareModel.UNSET è inclusa in upstream #5198 (b8cf622d). Mantenere anche verifica di persistenza e canale del target; validare con la suite upstream. |
| C072 | `src/server/services/nodeInfoEnrichment.hwModelUnset.test.ts` | COPERTO | 8 | 1 | La correzione hwModel=0/HardwareModel.UNSET è inclusa in upstream #5198 (b8cf622d). Mantenere anche verifica di persistenza e canale del target; validare con la suite upstream. |
| C073 | `src/server/services/nodeInfoEnrichmentService.ts` | COPERTO | 8 | 2 | La correzione hwModel=0/HardwareModel.UNSET è inclusa in upstream #5198 (b8cf622d). Mantenere anche verifica di persistenza e canale del target; validare con la suite upstream. |
| C080 | `src/services/database.ts` | ADATTARE | 8 | 1 | Uniformare inserimento/aggiornamento/pruning delle risposte in orientamento requester→responder senza perdere routePositions, scope e refactoring della facade upstream. |

## Aggiunte e adattamenti del blocco 2

Gli otto file del blocco 2 sono reintegrati per la parte scheduler; C054/C055 conservano lavoro per le campagne nel blocco 3. Aggiunto `src/server/routes/tracerouteRoutes.scheduler.perSource.test.ts` per verificare auth reale, scope e visibilità dei canali. Il test custom duplicato dell'adattatore automation non è stato copiato: l'asserzione già presente verifica il terzo argomento `automation`, e i test del manager verificano la serializzazione effettiva tra sorgenti.

Rispetto al backup, il nuovo endpoint stato richiede una sorgente e usa l'envelope upstream; l'autoresponder avvia il timeout dopo l'invio. [Rapporto del blocco 2](custom-integration-block2.md).
