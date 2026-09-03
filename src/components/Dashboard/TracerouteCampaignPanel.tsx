import { useEffect, useMemo, useState } from 'react';
import api from '../../services/api';
import type {
  CreateTracerouteCampaignInput,
  TracerouteCampaign,
  TracerouteCampaignJob,
  TracerouteCampaignTargetInput,
} from '../../types/tracerouteCampaign';
import type { DashboardSource, SourceStatus } from '../../hooks/useDashboardData';
import { UiIcon } from '../icons';

interface TracerouteCampaignPanelProps {
  nodes: unknown[];
  sources: DashboardSource[];
  sourceStatuses: Map<string, SourceStatus | null>;
  initialTarget: TracerouteCampaignTargetInput | null;
}

interface NodeOption extends TracerouteCampaignTargetInput {
  shortName?: string;
  searchText: string;
}

interface TraceNodePresentation {
  label: string;
  detail: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function nodeOption(raw: unknown): NodeOption | null {
  const node = asRecord(raw);
  if (node.isMeshCore === true) return null;
  const user = asRecord(node.user);
  const nodeNum = Number(node.nodeNum);
  if (!Number.isInteger(nodeNum) || nodeNum <= 0 || nodeNum >= 0xffffffff) return null;
  const nodeId = typeof node.nodeId === 'string'
    ? node.nodeId
    : typeof user.id === 'string' ? user.id : `!${nodeNum.toString(16).padStart(8, '0')}`;
  const shortName = typeof node.shortName === 'string'
    ? node.shortName
    : typeof user.shortName === 'string' ? user.shortName : undefined;
  const name = typeof node.longName === 'string'
    ? node.longName
    : typeof user.longName === 'string'
      ? user.longName
      : shortName ?? nodeId;
  return {
    nodeNum,
    nodeId,
    name,
    shortName,
    searchText: `${name} ${shortName ?? ''} ${nodeId} ${nodeNum} ${nodeNum.toString(16)}`.toLocaleLowerCase(),
  };
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function parseTraceNumbers(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map(Number).filter((entry) => Number.isFinite(entry))
      : [];
  } catch {
    return [];
  }
}

function traceNodePresentation(
  nodeNum: number,
  job: TracerouteCampaignJob,
  nodeByNum: Map<number, NodeOption>,
): TraceNodePresentation {
  const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
  if (nodeNum === 0xffffffff) return { label: 'Sconosciuto', detail: 'Hop anonimo' };
  if (nodeNum === job.localNodeNum) return { label: job.sourceName, detail: nodeId };

  const node = nodeByNum.get(nodeNum);
  if (node) {
    const name = node.name ?? node.nodeId ?? nodeId;
    return {
      label: node.shortName && node.shortName !== name ? node.shortName : name,
      detail: node.shortName && node.shortName !== name ? `${name} · ${node.nodeId ?? nodeId}` : node.nodeId ?? nodeId,
    };
  }
  if (nodeNum === job.target.nodeNum) {
    return { label: job.target.name ?? job.target.nodeId ?? nodeId, detail: job.target.nodeId ?? nodeId };
  }
  return { label: nodeId, detail: nodeId };
}

function TracePath({
  nodeNums,
  snrValues,
  job,
  nodeByNum,
}: {
  nodeNums: number[];
  snrValues: number[];
  job: TracerouteCampaignJob;
  nodeByNum: Map<number, NodeOption>;
}) {
  return (
    <div className="traceroute-campaign-path">
      {nodeNums.map((nodeNum, index) => {
        const node = traceNodePresentation(nodeNum, job, nodeByNum);
        const rawSnr = index > 0 ? snrValues[index - 1] : undefined;
        const snr = rawSnr === -128
          ? 'SNR ?'
          : rawSnr === undefined ? null : `${(rawSnr / 4).toFixed(1)} dB`;
        return (
          <span key={`${nodeNum}-${index}`} className="traceroute-campaign-path-step">
            {index > 0 && (
              <span className="traceroute-campaign-path-link">
                {snr && <small>{snr}</small>}
                <UiIcon name="forward" size={14} />
              </span>
            )}
            <span className="traceroute-campaign-path-node" title={node.detail}>{node.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function TracerouteJobDetails({
  job,
  nodeByNum,
}: {
  job: TracerouteCampaignJob;
  nodeByNum: Map<number, NodeOption>;
}) {
  if (!job.result) return null;
  const route = parseTraceNumbers(job.result.route);
  const routeBack = parseTraceNumbers(job.result.routeBack);
  const snrTowards = parseTraceNumbers(job.result.snrTowards);
  const snrBack = parseTraceNumbers(job.result.snrBack);
  const hasReturnPath = routeBack.length > 0 || snrBack.length > 0;

  return (
    <div className="traceroute-campaign-job-details">
      <div className="traceroute-campaign-leg">
        <strong>Andata · {route.length + 1} hop</strong>
        <TracePath
          nodeNums={[job.localNodeNum, ...route, job.target.nodeNum]}
          snrValues={snrTowards}
          job={job}
          nodeByNum={nodeByNum}
        />
      </div>
      <div className="traceroute-campaign-leg">
        <strong>Ritorno{hasReturnPath ? ` · ${routeBack.length + 1} hop` : ''}</strong>
        {hasReturnPath ? (
          <TracePath
            nodeNums={[job.target.nodeNum, ...routeBack, job.localNodeNum]}
            snrValues={snrBack}
            job={job}
            nodeByNum={nodeByNum}
          />
        ) : (
          <span className="traceroute-campaign-no-return">Percorso di ritorno non disponibile</span>
        )}
      </div>
      <small className="traceroute-campaign-result-time">Risposta ricevuta: {formatTimestamp(job.result.timestamp)}</small>
    </div>
  );
}

function statusLabel(job: TracerouteCampaignJob): string {
  switch (job.status) {
    case 'queued': return 'In coda';
    case 'running': return 'In esecuzione';
    case 'success': return job.result?.hopCount == null ? 'Riuscito' : `Riuscito · ${job.result.hopCount} hop`;
    case 'timeout': return 'Timeout';
    case 'error': return 'Errore';
    case 'skipped': return 'Saltato';
    case 'cancelled': return 'Annullato';
  }
}

function statusIcon(job: TracerouteCampaignJob) {
  if (job.status === 'success') return <UiIcon name="check" size={15} />;
  if (job.status === 'running') return <UiIcon name="radioSignal" size={15} />;
  if (job.status === 'queued') return <UiIcon name="timer" size={15} />;
  if (job.status === 'skipped' || job.status === 'cancelled') return <UiIcon name="blocked" size={15} />;
  return <UiIcon name="error" size={15} />;
}

export default function TracerouteCampaignPanel({
  nodes,
  sources,
  sourceStatuses,
  initialTarget,
}: TracerouteCampaignPanelProps) {
  const [selectedTargetNums, setSelectedTargetNums] = useState<Set<number>>(new Set());
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [behavior, setBehavior] = useState<CreateTracerouteCampaignInput['behavior']>('continue');
  const [recentSuccessHours, setRecentSuccessHours] = useState(24);
  const [timeoutSeconds, setTimeoutSeconds] = useState(75);
  const [delaySeconds, setDelaySeconds] = useState(5);
  const [campaign, setCampaign] = useState<TracerouteCampaign | null>(null);
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [checkingActive, setCheckingActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nodeOptions = useMemo(() => {
    const byNodeNum = new Map<number, NodeOption>();
    for (const raw of nodes) {
      const option = nodeOption(raw);
      if (option) byNodeNum.set(option.nodeNum, option);
    }
    if (initialTarget && !byNodeNum.has(initialTarget.nodeNum)) {
      const nodeId = initialTarget.nodeId ?? `!${initialTarget.nodeNum.toString(16).padStart(8, '0')}`;
      const name = initialTarget.name ?? nodeId;
      byNodeNum.set(initialTarget.nodeNum, {
        ...initialTarget,
        nodeId,
        name,
        searchText: `${name} ${nodeId} ${initialTarget.nodeNum} ${initialTarget.nodeNum.toString(16)}`.toLocaleLowerCase(),
      });
    }
    return [...byNodeNum.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [nodes, initialTarget]);

  const eligibleSources = useMemo(() => sources.filter((source) =>
    source.enabled && source.type === 'meshtastic_tcp'), [sources]);
  const connectedSourceKey = eligibleSources
    .filter((source) => sourceStatuses.get(source.id)?.connected === true
      && Number(sourceStatuses.get(source.id)?.nodeNum) > 0)
    .map((source) => source.id)
    .join('\u0000');
  const connectedSourceIds = useMemo(
    () => new Set(connectedSourceKey ? connectedSourceKey.split('\u0000') : []),
    [connectedSourceKey],
  );

  useEffect(() => {
    setError(null);
    setSearch('');
    setSelectedTargetNums(initialTarget ? new Set([initialTarget.nodeNum]) : new Set());
    setSelectedSourceIds(new Set(connectedSourceIds));
    setCheckingActive(true);
    let cancelled = false;
    void (async () => {
      const active = await api.get<{ campaign: TracerouteCampaign | null }>('/api/traceroute-campaigns/active');
      if (active.campaign) return active.campaign;
      const latest = await api.get<{ campaign: TracerouteCampaign | null }>('/api/traceroute-campaigns/latest');
      return latest.campaign;
    })()
      .then((availableCampaign) => {
        if (!cancelled) setCampaign(availableCampaign);
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Impossibile leggere la campagna attiva');
      })
      .finally(() => { if (!cancelled) setCheckingActive(false); });
    return () => { cancelled = true; };
  }, [initialTarget, connectedSourceIds]);

  const polledCampaignId = campaign?.id;
  const polledCampaignStatus = campaign?.status;
  useEffect(() => {
    if (!polledCampaignId || (polledCampaignStatus !== 'queued' && polledCampaignStatus !== 'running')) return;
    const interval = window.setInterval(() => {
      void api.get<TracerouteCampaign>(`/api/traceroute-campaigns/${polledCampaignId}`)
        .then(setCampaign)
        .catch((requestError) => setError(
          requestError instanceof Error ? requestError.message : 'Impossibile aggiornare lo stato della campagna',
        ));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [polledCampaignId, polledCampaignStatus]);

  const filteredNodes = nodeOptions.filter((node) => !search.trim()
    || node.searchText.includes(search.trim().toLocaleLowerCase()));
  const nodeByNum = useMemo(
    () => new Map(nodeOptions.map((node) => [node.nodeNum, node])),
    [nodeOptions],
  );
  const toggleTarget = (nodeNum: number) => setSelectedTargetNums((current) => {
    const next = new Set(current);
    if (next.has(nodeNum)) next.delete(nodeNum); else next.add(nodeNum);
    return next;
  });
  const toggleSource = (sourceId: string) => setSelectedSourceIds((current) => {
    const next = new Set(current);
    if (next.has(sourceId)) next.delete(sourceId); else next.add(sourceId);
    return next;
  });
  const toggleJobDetails = (jobId: string) => setExpandedJobIds((current) => {
    const next = new Set(current);
    if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
    return next;
  });

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const targets = nodeOptions
        .filter((node) => selectedTargetNums.has(node.nodeNum))
        .map(({ nodeNum, nodeId, name }) => ({ nodeNum, nodeId, name }));
      const sourceIds = eligibleSources
        .filter((source) => selectedSourceIds.has(source.id))
        .map((source) => source.id);
      const created = await api.post<TracerouteCampaign>('/api/traceroute-campaigns', {
        targets,
        sourceIds,
        behavior,
        recentSuccessHours,
        timeoutSeconds,
        delaySeconds,
      } satisfies CreateTracerouteCampaignInput);
      setCampaign(created);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Impossibile avviare la campagna');
    } finally {
      setLoading(false);
    }
  };

  const cancel = async () => {
    if (!campaign) return;
    setLoading(true);
    setError(null);
    try {
      setCampaign(await api.post<TracerouteCampaign>(`/api/traceroute-campaigns/${campaign.id}/cancel`));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Impossibile annullare la campagna');
    } finally {
      setLoading(false);
    }
  };

  const retryFailed = async () => {
    if (!campaign) return;
    setLoading(true);
    setError(null);
    try {
      setCampaign(await api.post<TracerouteCampaign>(`/api/traceroute-campaigns/${campaign.id}/retry`));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Impossibile ritentare i traceroute falliti');
    } finally {
      setLoading(false);
    }
  };

  const campaignActive = campaign?.status === 'queued' || campaign?.status === 'running';
  const failedAttemptCount = campaign?.jobs.filter((job) =>
    job.status === 'timeout' || job.status === 'error').length ?? 0;
  const progressPercent = campaign && campaign.progress.total > 0
    ? Math.round(campaign.progress.completed / campaign.progress.total * 100)
    : 0;
  const jobsByTarget = campaign ? [...new Map(campaign.jobs.map((job) => [
    job.target.nodeNum,
    campaign.jobs.filter((candidate) => candidate.target.nodeNum === job.target.nodeNum),
  ])).entries()] : [];

  return (
    <section className="traceroute-campaign-panel-page" aria-labelledby="traceroute-campaign-title">
        <header className="traceroute-campaign-header">
          <div>
            <h2 id="traceroute-campaign-title"><UiIcon name="route" size={20} /> Campagna traceroute</h2>
            <p>Interroga le sorgenti una alla volta e aspetta l’esito prima di proseguire.</p>
          </div>
        </header>

        {error && <div className="traceroute-campaign-error" role="alert">{error}</div>}

        {!campaign ? (
          <div className="traceroute-campaign-setup">
            <div className="traceroute-campaign-panel">
              <div className="traceroute-campaign-panel-title">
                <span>Nodi destinazione <strong>{selectedTargetNums.size}</strong></span>
                <span className="traceroute-campaign-inline-actions">
                  <button type="button" onClick={() => setSelectedTargetNums(new Set(filteredNodes.map((node) => node.nodeNum)))}>Tutti visibili</button>
                  <button type="button" onClick={() => setSelectedTargetNums(new Set())}>Nessuno</button>
                </span>
              </div>
              <label className="traceroute-campaign-search">
                <UiIcon name="search" size={15} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cerca nome, short name o node ID" />
              </label>
              <div className="traceroute-campaign-scroll-list">
                {filteredNodes.map((node) => (
                  <label key={node.nodeNum} className="traceroute-campaign-choice">
                    <input type="checkbox" checked={selectedTargetNums.has(node.nodeNum)} onChange={() => toggleTarget(node.nodeNum)} />
                    <span>
                      <span className="traceroute-campaign-node-name">
                        <strong>{node.name}</strong>
                        {node.shortName && node.shortName !== node.name && (
                          <span className="traceroute-campaign-short-name">{node.shortName}</span>
                        )}
                      </span>
                      <small>{node.nodeId}</small>
                    </span>
                  </label>
                ))}
                {filteredNodes.length === 0 && <div className="traceroute-campaign-empty">Nessun nodo corrispondente</div>}
              </div>
            </div>

            <div className="traceroute-campaign-panel">
              <div className="traceroute-campaign-panel-title">
                <span>Sorgenti <strong>{selectedSourceIds.size}</strong></span>
                <button type="button" onClick={() => setSelectedSourceIds(new Set(connectedSourceIds))}>Connesse</button>
              </div>
              <div className="traceroute-campaign-source-list">
                {eligibleSources.map((source) => {
                  const status = sourceStatuses.get(source.id);
                  const connected = connectedSourceIds.has(source.id);
                  return (
                    <label key={source.id} className={`traceroute-campaign-choice ${connected ? '' : 'is-disabled'}`}>
                      <input type="checkbox" disabled={!connected} checked={selectedSourceIds.has(source.id)} onChange={() => toggleSource(source.id)} />
                      <span><strong>{source.name}</strong><small>{connected ? `Connessa · nodo locale !${Number(status?.nodeNum).toString(16).padStart(8, '0')}` : 'Non disponibile'}</small></span>
                    </label>
                  );
                })}
                {eligibleSources.length === 0 && <div className="traceroute-campaign-empty">Nessuna sorgente Meshtastic TCP</div>}
              </div>
            </div>

            <fieldset className="traceroute-campaign-options">
              <legend>Comportamento dopo un esito positivo</legend>
              <label>
                <input type="radio" name="campaign-behavior" checked={behavior === 'continue'} onChange={() => setBehavior('continue')} />
                <span><strong>Continua su tutte le sorgenti</strong><small>Raccoglie un risultato da ogni sorgente selezionata.</small></span>
              </label>
              <label>
                <input type="radio" name="campaign-behavior" checked={behavior === 'stop-on-success'} onChange={() => setBehavior('stop-on-success')} />
                <span><strong>Ferma il nodo al primo successo</strong><small>Le sorgenti rimanenti vengono saltate solo per quel nodo.</small></span>
              </label>
            </fieldset>

            <div className="traceroute-campaign-numeric-options">
              <label><span>Successi recenti prima</span><span><input type="number" min={1} max={720} value={recentSuccessHours} onChange={(event) => setRecentSuccessHours(Number(event.target.value))} /> ore</span></label>
              <label><span>Timeout per sorgente</span><span><input type="number" min={5} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /> sec</span></label>
              <label><span>Pausa tra tentativi</span><span><input type="number" min={0} max={300} value={delaySeconds} onChange={(event) => setDelaySeconds(Number(event.target.value))} /> sec</span></label>
            </div>
            <p className="traceroute-campaign-hint">Per ogni nodo, le sorgenti con un successo nelle ultime {recentSuccessHours || 0} ore partono per prime, dal successo più recente.</p>
          </div>
        ) : (
          <div className="traceroute-campaign-results">
            <div className="traceroute-campaign-summary">
              <div>
                <strong>{campaign.status === 'completed' ? 'Completata' : campaign.status === 'cancelled' ? 'Annullata' : 'In corso'}</strong>
                <span>{campaign.progress.completed} di {campaign.progress.total} tentativi</span>
              </div>
              <div className="traceroute-campaign-counts">
                <span className="is-success">{campaign.progress.successful} riusciti</span>
                <span className="is-failure">{campaign.progress.failed} falliti</span>
                <span>{campaign.progress.skipped} saltati</span>
              </div>
            </div>
            <div className="traceroute-campaign-progress" aria-label={`Avanzamento ${progressPercent}%`}>
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="traceroute-campaign-job-groups">
              {jobsByTarget.map(([nodeNum, jobs]) => (
                <section key={nodeNum} className="traceroute-campaign-job-group">
                  <h3>{jobs[0].target.name ?? jobs[0].target.nodeId ?? `!${nodeNum.toString(16).padStart(8, '0')}`}</h3>
                  {jobs.map((job) => (
                    <div key={job.id} className={`traceroute-campaign-job is-${job.status}`}>
                      <span className="traceroute-campaign-job-icon">{statusIcon(job)}</span>
                      <span className="traceroute-campaign-job-source">
                        <strong>{job.sourceName}</strong>
                        {job.recentSuccessAt && <small title={formatTimestamp(job.recentSuccessAt)}>positivo recente · priorità</small>}
                      </span>
                      <span className="traceroute-campaign-job-status">
                        <span className="traceroute-campaign-job-status-line">
                          <strong>{statusLabel(job)}</strong>
                          {job.status === 'success' && job.result && (
                            <button
                              type="button"
                              className="traceroute-campaign-info-btn"
                              aria-label={`Dettagli traceroute ${job.sourceName}`}
                              aria-expanded={expandedJobIds.has(job.id)}
                              title="Mostra percorso e SNR"
                              onClick={() => toggleJobDetails(job.id)}
                            >
                              <UiIcon name="info" size={15} />
                            </button>
                          )}
                        </span>
                        {job.error && <small title={job.error}>{job.error}</small>}
                      </span>
                      {expandedJobIds.has(job.id) && (
                        <TracerouteJobDetails job={job} nodeByNum={nodeByNum} />
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}

        <footer className="traceroute-campaign-footer">
          {campaignActive ? (
            <button type="button" className="traceroute-campaign-btn is-danger" onClick={cancel} disabled={loading}>Annulla campagna</button>
          ) : campaign ? (
            <button type="button" className="traceroute-campaign-btn" onClick={() => { setCampaign(null); setError(null); }}>Nuova campagna</button>
          ) : <span />}
          {campaign && !campaignActive && failedAttemptCount > 0 && (
            <button
              type="button"
              className="traceroute-campaign-btn is-primary"
              onClick={retryFailed}
              disabled={loading}
            >
              <UiIcon name="refresh" size={15} /> {loading ? 'Attendi…' : `Riprova falliti (${failedAttemptCount})`}
            </button>
          )}
          {!campaign && (
            <button
              type="button"
              className="traceroute-campaign-btn is-primary"
              onClick={start}
              disabled={loading || checkingActive || selectedTargetNums.size === 0 || selectedSourceIds.size === 0}
            >
              <UiIcon name="play" size={15} /> {loading || checkingActive ? 'Attendi…' : 'Avvia in sequenza'}
            </button>
          )}
        </footer>
    </section>
  );
}
