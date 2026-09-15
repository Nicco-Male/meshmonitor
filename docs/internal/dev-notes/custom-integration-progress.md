# MeshMonitor custom integration — checkpoint del blocco 1

Aggiornato il 15 settembre 2026. **Blocco 1 completato; blocchi 2–9 da eseguire.**

L'utente ha richiesto una sessione per blocco, in base ai token disponibili. Questo checkpoint prepara la base e l'inventario; non reintegra ancora funzionalità custom e non aggiorna `main`.

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

Alla verifica, il fork era 13 commit dietro upstream e 0 commit avanti. Il ramo di integrazione parte esattamente dalla base upstream fissata; i soli file aggiunti dal checkpoint sono questo registro, l'inventario e il rapporto di baseline.

Per identificare lo SHA completo del commit che introduce il blocco 1 anche dopo sessioni successive:

```bash
git log --diff-filter=A --format=%H -- docs/internal/dev-notes/custom-integration-progress.md
```

## Cosa è stato completato

| Attività | Risultato |
| --- | --- |
| Checkout e sicurezza | Checkout nuovo, proveniente dai remoti; backup custom verificato; backup del main e ramo di integrazione creati sul fork. Nessun reset o force push. |
| Istruzioni | Letti `CLAUDE.md` e `ARCHITECTURE_LESSONS.md`; nessun `AGENTS.md` nel tree upstream fissato. Per i prossimi blocchi leggere anche i file architetturali specifici richiesti da `CLAUDE.md`. |
| Inventario | Tutti gli 88 file classificati: 35 PORTARE, 50 ADATTARE, 3 COPERTO; blocchi e dipendenze assegnati. [Inventario completo](custom-integration-inventory.md). |
| Ambiente e baseline | Node 24.19.0, npm 11.9.0, dipendenze del lockfile e submodule inizializzati. Build client/server, lint e 103 test superati. [Verifiche e limiti](custom-integration-baseline.md). |
| Completezza del checkpoint | Sorgenti, dipendenze dichiarate, versioni, submodule e schema rimangono quelli upstream. Le simulazioni di merge sono state eseguite solo in file temporanei. |

## Stato dei blocchi

| Blocco | Contenuto | Stato |
| --- | --- | --- |
| 1 | Base, inventario e baseline | Completato |
| 2 | Scheduler centrale e agganci trace | Da eseguire — prossimo |
| 3 | Campagne backend e query necessarie | Da eseguire |
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

## Prossima sessione: blocco 2

**Obiettivo:** recuperare lo scheduler centrale senza anticipare l'intera implementazione delle campagne.

| Ordine | Operazione |
| --- | --- |
| A | Verificare HEAD remoto del ramo di integrazione, istruzioni attuali e checkout pulito; leggere registro, baseline, source registry e manager. |
| B | Recuperare `tracerouteRequestScheduler.ts` e test dal backup; integrare l'accodamento nel manager preservando gli aggiornamenti upstream. |
| C | Instradare priorità automatic/automation e recuperare endpoint stato coda. Il codice di riserva del coordinator, gli errori campaign-busy e la pagina campagne appartengono ai blocchi 3–4. |
| D | Validare deduplica, priorità, rilascio su risposta/timeout, errori di invio e coesistenza con autotrace. Rieseguire le suite Remote Admin a protezione del manager. |
| E | Aggiornare questo registro, eseguire le verifiche necessarie e pubblicare il checkpoint del blocco 2 sullo stesso ramo. |

Comportamento effettivo del vecchio scheduler da conservare inizialmente: **un solo traceroute globale attivo tra tutte le sorgenti**, cooldown di 5 s e timeout predefinito di 75 s. Il backup non contiene una configurazione di domini RF separati; non dichiarare quella funzione già presente. La query dell'ultimo traceroute riuscito va invece portata con le campagne nel blocco 3.

**Problema preesistente da tenere presente:** il controllo `check:imports` upstream usa il campo `n` di `es-module-lexer`, mentre la versione 3.0.2 installata espone `specifier`. Il comando ordinario restituisce successo ma visita un solo modulo. Nel blocco 1 un adattamento temporaneo esterno al repository ha verificato tutti i 653 moduli raggiungibili con esito positivo. Prima di fidarsi del gate nei prossimi blocchi, usare una verifica compatibile o correggere esplicitamente lo script come intervento distinto e documentato; non trattare il falso successo del vecchio gate come copertura completa.
