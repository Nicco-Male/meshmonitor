import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import {
  buildPowerMetricLabelOverrides,
  getPowerChannelNumbers,
  MAX_TELEMETRY_CHANNEL_LABEL_LENGTH,
  parseTelemetryChannelLabels,
  telemetryChannelLabelKey,
  type TelemetryChannelLabels,
} from '../../utils/telemetryChannelLabels';
import TelemetryGraphs from '../TelemetryGraphs';
import { UiIcon } from '../icons';
import styles from './NodeTelemetryReport.module.css';

interface UnifiedTelemetryEntry {
  nodeId: string;
  nodeNum?: number;
  telemetryType: string;
  sourceId: string;
  sourceName: string;
  nodeLongName?: string | null;
  nodeShortName?: string | null;
}

interface ReportNode {
  key: string;
  nodeId: string;
  sourceId: string;
  sourceName: string;
  displayName: string;
  telemetryTypes: string[];
}

interface SettingsPayload {
  telemetryChannelLabels?: string;
}

function buildReportNodes(entries: UnifiedTelemetryEntry[]): ReportNode[] {
  const nodes = new Map<string, Omit<ReportNode, 'telemetryTypes'> & { telemetryTypes: Set<string> }>();

  for (const entry of entries) {
    if (!entry.nodeId || !entry.sourceId || !entry.telemetryType) continue;
    const key = telemetryChannelLabelKey(entry.sourceId, entry.nodeId);
    const existing = nodes.get(key);
    if (existing) {
      existing.telemetryTypes.add(entry.telemetryType);
      continue;
    }

    nodes.set(key, {
      key,
      nodeId: entry.nodeId,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName || entry.sourceId,
      displayName: entry.nodeLongName || entry.nodeShortName || entry.nodeId,
      telemetryTypes: new Set([entry.telemetryType]),
    });
  }

  return [...nodes.values()]
    .map((node) => ({ ...node, telemetryTypes: [...node.telemetryTypes] }))
    .sort(
      (a, b) =>
        a.sourceName.localeCompare(b.sourceName) ||
        a.displayName.localeCompare(b.displayName),
    );
}

export default function NodeTelemetryReport() {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const { temperatureUnit } = useSettings();
  const canEditLabels = hasPermission('settings', 'write');

  const [sourceFilter, setSourceFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedNodeKey, setSelectedNodeKey] = useState('');
  const [storedLabels, setStoredLabels] = useState<TelemetryChannelLabels>({});
  const [draftLabels, setDraftLabels] = useState<TelemetryChannelLabels>({});
  const [saveMessage, setSaveMessage] = useState('');

  const nodesQuery = useQuery({
    queryKey: ['reports', 'node-telemetry', 'nodes'],
    queryFn: () => api.get<UnifiedTelemetryEntry[]>('/api/unified/telemetry?hours=168'),
    staleTime: 30_000,
  });

  const settingsQuery = useQuery({
    queryKey: ['reports', 'node-telemetry', 'settings'],
    queryFn: () => api.get<SettingsPayload>('/api/settings'),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    const parsed = parseTelemetryChannelLabels(
      settingsQuery.data.telemetryChannelLabels,
    );
    setStoredLabels(parsed);
    setDraftLabels(parsed);
  }, [settingsQuery.data]);

  const reportNodes = useMemo(
    () => buildReportNodes(nodesQuery.data ?? []),
    [nodesQuery.data],
  );

  const sources = useMemo(() => {
    const names = new Map<string, string>();
    for (const node of reportNodes) {
      if (!names.has(node.sourceId)) names.set(node.sourceId, node.sourceName);
    }
    return [...names.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [reportNodes]);

  const filteredNodes = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return reportNodes.filter((node) => {
      if (sourceFilter && node.sourceId !== sourceFilter) return false;
      if (!normalizedSearch) return true;
      return [node.displayName, node.nodeId, node.sourceName]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch);
    });
  }, [reportNodes, search, sourceFilter]);

  const selectedNode = reportNodes.find((node) => node.key === selectedNodeKey) ?? null;
  const powerChannels = selectedNode
    ? getPowerChannelNumbers(selectedNode.telemetryTypes)
    : [];
  const selectedDraftLabels = selectedNode
    ? draftLabels[selectedNode.key] ?? {}
    : {};
  const selectedStoredLabels = selectedNode
    ? storedLabels[selectedNode.key] ?? {}
    : {};
  const labelOverrides = buildPowerMetricLabelOverrides(selectedDraftLabels);
  const labelsDirty =
    JSON.stringify(parseTelemetryChannelLabels({ node: selectedDraftLabels }).node ?? {}) !==
    JSON.stringify(parseTelemetryChannelLabels({ node: selectedStoredLabels }).node ?? {});

  const saveMutation = useMutation({
    mutationFn: async (nextLabels: TelemetryChannelLabels) => {
      const response = await csrfFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telemetryChannelLabels: JSON.stringify(nextLabels),
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to save channel names (${response.status})`);
      }
      return nextLabels;
    },
    onSuccess: (nextLabels) => {
      setStoredLabels(nextLabels);
      setDraftLabels(nextLabels);
      setSaveMessage(
        t('analysis.node_telemetry.labels_saved', 'Channel names saved.'),
      );
    },
    onError: () => {
      setSaveMessage(
        t(
          'analysis.node_telemetry.labels_save_failed',
          'Could not save channel names.',
        ),
      );
    },
  });

  const updateChannelLabel = (channel: number, value: string) => {
    if (!selectedNode) return;
    setSaveMessage('');
    setDraftLabels((current) => ({
      ...current,
      [selectedNode.key]: {
        ...(current[selectedNode.key] ?? {}),
        [String(channel)]: value,
      },
    }));
  };

  const saveChannelLabels = () => {
    if (!selectedNode || !canEditLabels) return;
    const normalizedNodeLabels =
      parseTelemetryChannelLabels({ node: selectedDraftLabels }).node ?? {};
    const nextLabels = { ...storedLabels };
    if (Object.keys(normalizedNodeLabels).length > 0) {
      nextLabels[selectedNode.key] = normalizedNodeLabels;
    } else {
      delete nextLabels[selectedNode.key];
    }
    saveMutation.mutate(nextLabels);
  };

  return (
    <div className={styles.report}>
      <div>
        <h2 className="reports-section__title">
          <UiIcon name="telemetry" size={22} />
          {t('analysis.node_telemetry.title', 'Node Telemetry')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.node_telemetry.description',
            'Select a node to inspect its telemetry history and name its current and voltage sensor channels.',
          )}
        </p>
      </div>

      <section className={`reports-panel ${styles.controlsPanel}`}>
        <div className={styles.controlsGrid}>
          <label className={styles.field}>
            <span>{t('analysis.node_telemetry.source', 'Source')}</span>
            <select
              value={sourceFilter}
              onChange={(event) => {
                setSourceFilter(event.target.value);
                setSelectedNodeKey('');
              }}
            >
              <option value="">
                {t('analysis.node_telemetry.all_sources', 'All sources')}
              </option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span>{t('analysis.node_telemetry.search', 'Search nodes')}</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t(
                'analysis.node_telemetry.search_placeholder',
                'Name or node ID',
              )}
            />
          </label>

          <label className={`${styles.field} ${styles.nodeField}`}>
            <span>{t('analysis.node_telemetry.node', 'Node')}</span>
            <select
              value={selectedNodeKey}
              onChange={(event) => {
                setSelectedNodeKey(event.target.value);
                setSaveMessage('');
              }}
              disabled={nodesQuery.isLoading || filteredNodes.length === 0}
            >
              <option value="">
                {nodesQuery.isLoading
                  ? t('analysis.node_telemetry.loading_nodes', 'Loading nodes…')
                  : t('analysis.node_telemetry.select_node', 'Select a node…')}
              </option>
              {filteredNodes.map((node) => (
                <option key={node.key} value={node.key}>
                  {node.displayName} · {node.nodeId} · {node.sourceName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!nodesQuery.isLoading && (
          <div className={styles.resultCount}>
            {t('analysis.node_telemetry.nodes_found', {
              defaultValue: '{{count}} nodes found',
              count: filteredNodes.length,
            })}
          </div>
        )}
      </section>

      {nodesQuery.isError && (
        <div className="reports-banner reports-banner--error">
          {t(
            'analysis.node_telemetry.nodes_error',
            'Could not load telemetry nodes. Check your telemetry permissions.',
          )}
        </div>
      )}

      {!selectedNode && !nodesQuery.isError && (
        <div className="reports-banner reports-banner--empty">
          {t(
            'analysis.node_telemetry.empty',
            'Choose a node to display its telemetry charts.',
          )}
        </div>
      )}

      {selectedNode && (
        <>
          <section className={`reports-panel ${styles.nodeSummary}`}>
            <div>
              <strong>{selectedNode.displayName}</strong>
              <span>{selectedNode.nodeId}</span>
            </div>
            <span className={styles.sourceBadge}>{selectedNode.sourceName}</span>
          </section>

          <section className={`reports-panel ${styles.labelsPanel}`}>
            <div className={styles.labelsHeader}>
              <div>
                <h3>
                  {t(
                    'analysis.node_telemetry.channel_names',
                    'Current and voltage channel names',
                  )}
                </h3>
                <p>
                  {t(
                    'analysis.node_telemetry.channel_names_help',
                    'One name is shared by the current and voltage charts for the same sensor channel.',
                  )}
                </p>
              </div>
              {canEditLabels && powerChannels.length > 0 && (
                <button
                  type="button"
                  className="reports-btn"
                  onClick={saveChannelLabels}
                  disabled={!labelsDirty || saveMutation.isPending}
                >
                  {saveMutation.isPending
                    ? t('common.saving', 'Saving…')
                    : t('common.save', 'Save')}
                </button>
              )}
            </div>

            {powerChannels.length === 0 ? (
              <div className={styles.noChannels}>
                {t(
                  'analysis.node_telemetry.no_power_channels',
                  'This node has no ch1…ch8 current or voltage telemetry in the last 7 days.',
                )}
              </div>
            ) : (
              <div className={styles.channelGrid}>
                {powerChannels.map((channel) => {
                  const hasVoltage = selectedNode.telemetryTypes.includes(
                    `ch${channel}Voltage`,
                  );
                  const hasCurrent = selectedNode.telemetryTypes.includes(
                    `ch${channel}Current`,
                  );
                  return (
                    <label key={channel} className={styles.channelCard}>
                      <span className={styles.channelHeading}>
                        {t('analysis.node_telemetry.channel', {
                          defaultValue: 'Channel {{channel}}',
                          channel,
                        })}
                      </span>
                      <input
                        type="text"
                        value={selectedDraftLabels[String(channel)] ?? ''}
                        onChange={(event) =>
                          updateChannelLabel(channel, event.target.value)
                        }
                        maxLength={MAX_TELEMETRY_CHANNEL_LABEL_LENGTH}
                        placeholder={t(
                          'analysis.node_telemetry.channel_placeholder',
                          'e.g. Solar panel',
                        )}
                        disabled={!canEditLabels}
                        aria-label={t('analysis.node_telemetry.channel_name_label', {
                          defaultValue: 'Channel {{channel}} name',
                          channel,
                        })}
                      />
                      <span className={styles.metricBadges}>
                        {hasVoltage && (
                          <span>
                            {t('analysis.node_telemetry.voltage', 'Voltage')}
                          </span>
                        )}
                        {hasCurrent && (
                          <span>
                            {t('analysis.node_telemetry.current', 'Current')}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {!canEditLabels && powerChannels.length > 0 && (
              <div className={styles.readOnlyHint}>
                {t(
                  'analysis.node_telemetry.read_only_labels',
                  'You need Settings write permission to rename channels.',
                )}
              </div>
            )}
            {saveMessage && (
              <div
                className={
                  saveMutation.isError ? styles.saveError : styles.saveSuccess
                }
                role="status"
              >
                {saveMessage}
              </div>
            )}
          </section>

          <TelemetryGraphs
            nodeId={selectedNode.nodeId}
            sourceId={selectedNode.sourceId}
            temperatureUnit={temperatureUnit}
            telemetryHours={24}
            showTimeRangeSelector
            labelOverrides={labelOverrides}
            readOnly
          />
        </>
      )}
    </div>
  );
}
