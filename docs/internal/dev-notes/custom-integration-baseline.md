# Baseline upstream MeshMonitor — blocco 1

Verifica eseguita il 15 settembre 2026 sulla base upstream **`51023a75688e133853bd2dd0224063888b3d671b` / 4.16.1-rc3**, prima di applicare qualsiasi modifica custom al codice.

## Ambiente

| Elemento | Valore |
| --- | --- |
| Runtime | Linux x64, Node.js 24.19.0, npm 11.9.0 |
| Toolchain dal lockfile | TypeScript 6.0.3; Vitest 5.0.0; es-module-lexer 3.0.2; better-sqlite3 13.0.3 |
| Dipendenze | `npm ci --no-audit --no-fund`; 1.269 pacchetti installati; nessuna modifica a package.json/package-lock.json |
| Protobuf Meshtastic | `protobufs` → `970fb19a44f89f8beab02991adb349a4b8d6c48f` |
| TAK SDK | `takpacket-sdk` → `247bc5294284696f20adbe65f26dd503443a71a3` |
| Protobuf annidati nel TAK SDK | `takpacket-sdk/protobufs` → `f5b94bc36786e3862eb16f4a68169709ee23c809` |

I submodule sono stati inizializzati con `git submodule update --init --recursive`. Non sono stati avviati il server applicativo, collegamenti ai nodi o migrazioni su database dell'utente.

## Risultati

| Controllo | Esito | Durata osservata |
| --- | --- | ---: |
| `npm run build` — TypeScript e bundle frontend | PASS, exit 0 | 40,5 s |
| `npm run build:server` | PASS, exit 0 | 16,4 s |
| `npm run lint:ci` | PASS, exit 0; controlli regole, locali e ratchet | 65,4 s |
| Test mirati sotto elencati | PASS: 7 suite, 103 test, 0 fallimenti | 6,7 s |
| `npm run check:imports` originale | Exit 0, ma copertura insufficiente: visita 1 modulo; vedi problema B1-ENV-02 | 0,2 s |
| Controllo import compatibile, copia temporanea | PASS: 653 moduli raggiungibili, nessun percorso relativo mancante | <1 s |

### Test eseguiti

```bash
npm run test:run -- --maxWorkers=2 \
  src/server/meshtasticManager.adminHopLimit.test.ts \
  src/server/protobufService.adminHopLimit.test.ts \
  src/server/routes/adminRoutes.asyncOperations.test.ts \
  src/server/services/remoteAdminService.test.ts \
  src/server/services/adminTransactionService.test.ts \
  src/server/services/nodeInfoEnrichment.hwModelUnset.test.ts \
  src/server/meshtasticManager.tracerouteScheduler.test.ts
```

Questa è una baseline mirata, non l'intera suite del progetto. PostgreSQL/MySQL, integrazione con radio reali, sistema completo e verifica visiva UI non fanno parte dei risultati del blocco 1. Nessun test nuovo è stato aggiunto per questi tre documenti.

## Problemi preesistenti e gestione

### B1-ENV-01 — estrazione header Node durante npm ci

Il primo `npm ci` si è fermato durante il build nativo di `better-sqlite3`: `node-gyp` ha scaricato correttamente gli header di Node 24.19.0 (HTTP 200), ma l'estrazione ha restituito ripetutamente `TAR_ENTRY_ERROR EINVAL: invalid argument, fchown`.

La soluzione ha riguardato soltanto l'ambiente: scaricare gli stessi header in una directory temporanea, estrarli con `tar --no-same-owner --no-same-permissions` e passarne la directory a `npm_config_nodedir` durante un nuovo `npm ci`, con `PUPPETEER_SKIP_DOWNLOAD=true`. Installazione successiva completata, 1.269 pacchetti in 50 s. Nessuna modifica al lockfile, a npmrc o alle dipendenze del repository.

In una nuova sessione tentare prima la normale installazione prevista dal repository. Applicare questo rimedio soltanto se ricompare lo stesso problema di estrazione; usare gli header della versione Node effettivamente in esecuzione.

### B1-ENV-02 — falso successo del controllo import upstream

Lo script `scripts/check-runtime-imports.mjs` legge `i.n` dagli elementi restituiti da `es-module-lexer`. La versione 3.0.2 presente nel lockfile e installata localmente restituisce invece `i.specifier`.

Prova raccolta: il parser rileva 129 import nell'entrypoint compilato, ma lo script originale visita un solo modulo perché il filtro scarta tutti i campi `n` mancanti. Anche il campione `import x from './x.js'` restituisce un elemento con `specifier: './x.js'`, senza `n`.

Per completare la verifica della base, è stata eseguita una copia **temporanea e non versionata** dello stesso script, cambiando soltanto l'estrazione in:

```js
.map((i) => i.n ?? i.specifier)
```

La verifica compatibile ha visitato **653 moduli** dall'entrypoint `dist/server/server.js` ed è terminata con exit 0. Analisi statica soltanto, senza eseguire i moduli. Lo script nel repository rimane identico a upstream. Prima di usare il gate per certificare i prossimi blocchi occorre una verifica compatibile oppure una correzione esplicita e verificata dello script.

### Avvisi non bloccanti

La base emette già avvisi per alcune opzioni npm, per l'uso di `__dirname` nella futura modalità di caricamento nativa della configurazione Vite e per la dimensione di alcuni bundle. Il lint segnala inoltre quattro conteggi migliorati rispetto al baseline, ma passa: il baseline non è stato riscritto.

## Protezione Remote Admin

| File upstream | Blob Git prima del porting |
| --- | --- |
| `src/server/meshtasticManager.ts` | `2dca1c200ca900f2e779dc55ebe42f3bfe558624` |
| `src/server/protobufService.ts` | `049cbcae8daf0d63ca259b12997731178e3c03e4` |
| `src/server/services/remoteAdminService.ts` | `392060d1dd9584f4c2d8961b2b0e768ee6b37a9a` |
| `src/server/services/adminTransactionService.ts` | `6e49dcd48689f788333dc6f028dafc46f9d38801` |

Il codice corrente usa `getConfiguredHopLimit()` nelle richieste Admin; le routes contengono la gestione asincrona con `operationId`. Le suite hop limit, servizi Admin e operazioni asincrone sono passate. Nel blocco 1 nessuno di questi file è stato modificato.
