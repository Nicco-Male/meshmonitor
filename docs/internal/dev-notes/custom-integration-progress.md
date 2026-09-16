# MeshMonitor custom integration — checkpoint del blocco 3

Aggiornato il 16 settembre 2026. **Blocchi 1–3 completati; blocchi 4–9 da eseguire.**

L'utente ha richiesto una sessione per blocco, in base ai token disponibili. Il blocco 3 aggiunge il backend delle campagne allo scheduler del blocco 2. La UI arriva nel blocco 4; `main` sarà aggiornato soltanto nel blocco 9.

## Riferimenti fissati

| Riferimento | Valore |
| --- | --- |
| Repository originale | `https://github.com/Yeraze/meshmonitor` |
| Fork di destinazione | `https://github.com/Nicco-Male/meshmonitor` |
| Base upstream | `51023a75688e133853bd2dd0224063888b3d671b` — 4.16.1-rc3 |
| Ramo di lavoro pubblicato sul fork | `integration/upstream-custom-20260915` |
| Main del fork prima del lavoro | `ef78c6b21246576ebdd09ae6872f71c38859179b` |
| Backup del main prima del lavoro | `backup/pre-integration-20260915` → `ef78c6b21246576ebdd09ae6872f71c38859179b` |
| Backup custom da cui recuperare le feature | `backup/pre-upstream-sync-20260907` → `54dbf4dfa9024d9935d706680bad522917dda82f` |
| Base storica del delta custom | `1bd63a1422aa3b9326361c419a96f9c324010a19` |

Alla verifica, il fork era 13 commit dietro upstream e 0 commit avanti. Il ramo di integrazione parte esattamente dalla base upstream fissata; il checkpoint del blocco 1 (`b47f06fd1562883582714ce040eeafa2b971553e`) aggiungeva soltanto questo registro, l'inventario e il rapporto di baseline.

Per identificare lo SHA completo del commit che introduce il blocco 1 anche dopo sessioni successive:

```bash
git log --diff-filter=A --format=%H -- docs/internal/dev-notes/custom-integration-progress.md
```

## Storico del blocco 1

| Attività | Risultato |
| --- | --- |
| Checkout e sicurezza | Checkout nuovo, proveniente dai remoti; backup custom verificato; backup del main e ramo di integrazione creati sul fork. Nessun reset o force push. |
| Istruzioni | Letti `CLAUDE.md` e `ARCHITECTURE_LESSONS.md`; nessun `AGENTS.md` nel tree upstream fissato. Per i prossimi blocchi leggere anche i file architetturali specifici richiesti da `CLAUDE.md`. |
| Inventario | Tutti gli 88 file classificati: 35 PORTARE, 50 ADATTARE, 3 COPERTO; blocchi e dipendenze assegnati. [Inventario completo](custom-integration-inventory.md). |
| Ambiente e baseline | Node 24.19.0, npm 11.9.0, dipendenze del lockfile e submodule inizializzati. Build client/server, lint e 103 test superati. [Verifiche e limiti](custom-integration-baseline.md). |
| Completezza del checkpoint | Sorgenti, dipendenze dichiarate, versioni, submodule e schema rimangono quelli upstream. Le simulazioni di merge sono state eseguite solo in file temporanei. |

## Blocco 2 completato

Scheduler condiviso, agganci nel manager, priorità manual/automation/automatic, cancellazione delle richieste non inviate alla disconnessione e API dello stato con permessi per sorgente/canale. Il checkpoint pubblicato del blocco 2 è `2a4ef391098dc96e682768465b0f186064be1169`; il successivo blocco 3 integra coordinator e backend campagne. [Dettagli, verifiche e contratto API](custom-integration-block2.md).

## Blocco 3 completato

Servizio e API campagne, sequenza multi-source, ordinamento per successi recenti, stop per target, retry fallimenti, riserve sorgenti, cancellazione della coda e integrazione con automazioni. Query con scope sorgente/canale e permessi rivalutati anche al dispatch. **496 test superati**, build client/server, lint e tipi dei file interessati verificati; servizi Remote Admin preservati. [Dettagli, API per la UI e limiti](custom-integration-block3.md).

## Stato dei blocchi

| Blocco | Contenuto | Stato |
| --- | --- | --- |
| 1 | Base, inventario e baseline | Completato |
| 2 | Scheduler centrale e agganci trace | Completato |
| 3 | Campagne backend e query necessarie | Completato |
| 4 | UI campagne e nuova scheda | Da eseguire — prossimo |
| 5 | Percorsi, snapshot, movimento, TTL e popup | Da eseguire |
| 6 | Ruoli, marker mobili/fissi e mappe di base | Da eseguire |
| 7 | Report telemetria, filtri, refresh, etichette | Da eseguire |
| 8 | MQTT, DB, sorgenti e riconciliazione finale | Da eseguire |
| 9 | Verifiche integrate e pubblicazione su main | Da eseguire |

## Vincoli per continuare

1. Riprendere dal ramo pubblicato di integrazione. Conservare la base upstream fissata per tutta la reintegrazione; un nuovo aggiornamento upstream va valutato separatamente, senza cambiare base silenziosamente tra le sessioni.
2. Recuperare il delta **base storica → backup custom**, per feature. Non sostituire file condivisi con le loro vecchie versioni. Un diff diretto upstream→backup include rimozioni di codice moderno che non appartengono alle customizzazioni da recuperare.
3. Preservare i fix Remote Admin: `getConfiguredHopLimit()`, inoltro del limite configurato ai pacchetti Admin e operazioni HTTP asincrone con polling. Solo `meshtasticManager.ts` riceve agganci custom in questa area; gli altri servizi Admin non hanno un delta custom nell'inventario.
4. Concludere ogni blocco con verifiche pertinenti, commit e checkpoint pubblicato sul ramo di integrazione. Registrare problemi preesistenti, copertura effettiva e prossimo passo; non allargare il lint baseline per nascondere nuovi errori.
5. Promuovere a `main` soltanto il risultato completo e validato del blocco 9. Se il main remoto avanza, riesaminare lo stato; nessun force push/reset distruttivo senza conferma dell'utente.

## Prossima sessione: blocco 4

**Obiettivo:** recuperare la pagina campagne e l'accesso dal dashboard, usando il backend già verificato.

| Ordine | Operazione |
| --- | --- |
| A | Verificare HEAD remoto del ramo di integrazione, checkout pulito, questo registro, rapporto del blocco 3 e inventario. Conservare la base upstream fissata. |
| B | Portare panel/pagina e test dal delta storico; selezione manuale, ricerca long/short name, ordinamento target, sorgenti e impostazioni della campagna. |
| C | Integrare route frontend, accesso dal dashboard e apertura in nuova scheda, mantenendo i componenti e gli stili upstream. |
| D | Adattare letture API a `{ success: true, data }`, polling di campagna e scheduler con sourceId, retry, stop e dettagli hop. Aggiornare i fixture per `sources[].channel`; verificare permessi ed errori 401/403/409. |
| E | Verificare test/build/lint, aggiornare registro e inventario e pubblicare il checkpoint sullo stesso ramo. Fermarsi prima dei lavori mappa del blocco 5. |

Il limite effettivo resta **un solo traceroute globale attivo tra tutte le sorgenti**, cooldown di 5 s e timeout predefinito di 75 s (configurabile 5–300 s nelle campagne). Non esistono domini RF configurabili. Le campagne sono in memoria: un riavvio ne perde lo stato.

**Contratto da rispettare nel blocco 4:** tutte le API campagne sono documentate nel [rapporto del blocco 3](custom-integration-block3.md). La vecchia UI del backup leggeva payload senza envelope; ora deve leggere `data`. `GET /api/traceroutes/scheduler/status?sourceId=...` richiede sorgente e visibilità del canale: uno stato filtrato con `active: null` non certifica che il globale sia libero.

**Verifiche da riprendere correttamente:** usare il controllo import compatibile descritto nella baseline (il gate upstream visita solo un modulo). I rapporti dei blocchi 2–3 documentano il controllo dei tipi e i limiti della verifica; non presentare i test mirati come intera suite o collaudo con radio reali.
