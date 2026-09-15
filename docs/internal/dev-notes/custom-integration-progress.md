# MeshMonitor custom integration — checkpoint del blocco 2

Aggiornato il 15 settembre 2026. **Blocchi 1–2 completati; blocchi 3–9 da eseguire.**

L'utente ha richiesto una sessione per blocco, in base ai token disponibili. Il blocco 2 reintegra lo scheduler centrale sulla base preparata nel blocco 1. Le campagne arrivano nei blocchi 3–4; `main` sarà aggiornato soltanto nel blocco 9.

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

Scheduler condiviso, agganci nel manager, priorità manual/automation/automatic, cancellazione delle richieste non inviate alla disconnessione e API dello stato con permessi per sorgente/canale. I tipi campaign/retry sono pronti; il coordinator e le campagne non sono ancora reintegrati. [Dettagli, verifiche e contratto API](custom-integration-block2.md).

## Stato dei blocchi

| Blocco | Contenuto | Stato |
| --- | --- | --- |
| 1 | Base, inventario e baseline | Completato |
| 2 | Scheduler centrale e agganci trace | Completato |
| 3 | Campagne backend e query necessarie | Da eseguire — prossimo |
| 4 | UI campagne e nuova scheda | Da eseguire |
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

## Prossima sessione: blocco 3

**Obiettivo:** recuperare il backend delle campagne sullo scheduler già reintegrato.

| Ordine | Operazione |
| --- | --- |
| A | Verificare HEAD remoto del ramo di integrazione, checkout pulito, questo registro, rapporto del blocco 2 e inventario. Conservare la base upstream fissata. |
| B | Portare tipi, coordinator e service delle campagne dal delta storico; integrare la query `getLatestSuccessfulTracerouteByNodes` con scope sorgente nel repository traceroutes. |
| C | Aggiungere riserva/rilascio delle sorgenti e `sendCampaignTraceroute` usando lo scheduler centrale, con guardia di cancellazione e timeout per richiesta. Non bypassare i controlli di connessione/TX già reintegrati. |
| D | Integrare router campagne, mount in server e trattamento degli errori campaign-busy nei due ingressi manuali; testare permessi, sequenze multi-source, retry, stop e coesistenza con autotrace/automazioni. |
| E | Verificare build/test/lint, aggiornare registro e inventario e pubblicare il checkpoint sullo stesso ramo. Pagina campagne e nuova scheda appartengono al blocco 4. |

Il limite effettivo resta **un solo traceroute globale attivo tra tutte le sorgenti**, cooldown di 5 s e timeout predefinito di 75 s. Non esistono domini RF configurabili.

**Contratto da rispettare nel blocco 4:** `GET /api/traceroutes/scheduler/status?sourceId=...` richiede la sorgente, controlla `traceroute:read` e visibilità del canale e restituisce `{ success: true, data: status }`. La vecchia UI che leggeva uno stato globale senza query va adattata; uno stato sorgente con `active: null` non certifica che il globale sia libero.

**Verifiche da riprendere correttamente:** usare il controllo import compatibile descritto nella baseline (il gate upstream visita solo un modulo). Il rapporto del blocco 2 documenta anche il controllo dei tipi dei test e i limiti della verifica; non presentare i test mirati come intera suite o collaudo con radio reali.
