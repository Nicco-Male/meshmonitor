import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { buildTelemetrySourceScope } from '../../hooks/useTelemetry';
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

interface ReportSource {
  id: string;
  name: string;
}

interface ReportNode {
  /** Logical node key: deliberately independent from the receiving source. */
  key: string;
  nodeId: string;
  nodeLongName?: string | null;
  nodeShortName?: string | null;
  displayName: string;
  telemetryTypes: string[];
  sources: ReportSource[];
  /** Old source-specific keys used only as a read fallback for saved labels. */
  legacyLabelKeys: string[];
}

interface SettingsPayload {
  telemetryChannelLabels?: string;
}

const MAX_VISIBLE_NODE_RESULTS = 50;

function logicalNodeKey(nodeId: string): string {
  return `node:${encodeURIComponent(nodeId.toLowerCase())}`;
}

function formatNodeLabel(node: ReportNode): string {
  return `${node.displayName} · ${node.nodeId}`;
}

function getNodeLabels(
  labels: TelemetryChannelLabels,
  node: ReportNode | null,
): Record<string, string> {
  if (!node) return {};
  if (labels[node.key]) return labels[node.key];

  for (const legacyKey of node.legacyLabelKeys) {
    if (labels[legacyKey]) return labels[legacyKey];
  }

  return {};
}

function buildReportNodes(entries: UnifiedTelemetryEntry[]): ReportNode[] {
  const nodes = new Map<
    string,
    {
      key: string;
      nodeId: string;
      nodeLongName?: string | null;
      nodeShortName?: string | null;
      telemetryTypes: Set<string>;
      sources: Map<string, string>;
    }
  >();

  for (const entry of entries) {
    if (!entry.nodeId || !entry.sourceId || !entry.telemetryType) continue;

    const key = logicalNodeKey(entry.nodeId);
    const sourceName = entry.sourceName || entry.sourceId;
    const existing = nodes.get(key);

    if (existing) {
      existing.telemetryTypes.add(entry.telemetryType);
      if (!existing.sources.has(entry.sourceId)) {
        existing.sources.set(entry.sourceId, sourceName);
      }
      existing.nodeLongName ||= entry.nodeLongName?.trim() || null;
      existing.nodeShortName ||= entry.nodeShortName?.trim() || null;
      continue;
    }

    nodes.set(key, {
      key,
      nodeId: entry.nodeId,
      nodeLongName: entry.nodeLongName?.trim() || null,
      nodeShortName: entry.nodeShortName?.trim() || null,
      telemetryTypes: new Set([entry.telemetryType]),
      sources: new Map([[entry.sourceId, sourceName]]),
    });
  }

  return [...nodes.values()]
    .map((node) => {
      const sources = [...node.sources.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

      return {
        key: node.key,
        nodeId: node.nodeId,
        nodeLongName: node.nodeLongName,
        nodeShortName: node.nodeShortName,
        displayName: node.nodeLongName || node.nodeShortName || node.nodeId,
        telemetryTypes: [...node.telemetryTypes],
        sources,
        legacyLabelKeys: sources.map((source) =>
          telemetryChannelLabelKey(source.id, node.nodeId),
        ),
      };
    })
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) || a.nodeId.localeCompare(b.nodeId),
    );
}

export default function NodeTelemetryReport() {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const { temperatureUnit } = useSettings();
  const canEditLabels = hasPermission('settings', 'write');

  // The source is a secondary filter for the selected logical node. Empty means
  // merge all sources that observed the node.
  const [sourceFilter, setSourceFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedNodeKey, setSelectedNodeKey] = useState('');
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  const [storedLabels, setStoredLabels] = useState<TelemetryChannelLabels>({});
  const [draftLabels, setDraftLabels] = useState<TelemetryChannelLabels>({});
  const [saveMessage, setSaveMessage] = useState('');
  const pickerId = useId();
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const nodeOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  const filteredNodes = useMemo(() => {
    const searchTerms = search
      .trim()
      .toLowerCase()
      .replaceAll('·', ' ')
      .split(/\s+/)
      .filter(Boolean);

    return reportNodes.filter((node) => {
      if (searchTerms.length === 0) return true;
      const searchableNode = [
        node.nodeLongName,
        node.nodeShortName,
        node.nodeId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchTerms.every((term) => searchableNode.includes(term));
    });
  }, [reportNodes, search]);

  const visibleNodes = filteredNodes.slice(0, MAX_VISIBLE_NODE_RESULTS);
  const selectedNode =
    reportNodes.find((node) => node.key === selectedNodeKey) ?? null;

  useEffect(() => {
    if (
      selectedNode &&
      sourceFilter &&
      !selectedNode.sources.some((source) => source.id === sourceFilter)
    ) {
      setSourceFilter('');
    }
  }, [selectedNode, sourceFilter]);

  const selectedSource = selectedNode?.sources.find(
    (source) => source.id === sourceFilter,
  );
  const telemetrySourceScope = selectedNode
    ? buildTelemetrySourceScope(
        sourceFilter
          ? [sourceFilter]
          : selectedNode.sources.map((source) => source.id),
      )
    : null;
  const powerChannels = selectedNode
    ? getPowerChannelNumbers(selectedNode.telemetryTypes)
    : [];
  const selectedDraftLabels = getNodeLabels(draftLabels, selectedNode);
  const selectedStoredLabels = getNodeLabels(storedLabels, selectedNode);
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
        ...getNodeLabels(current, selectedNode),
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

  const selectNode = (node: ReportNode) => {
    setSelectedNodeKey(node.key);
    setSourceFilter('');
    setSearch(formatNodeLabel(node));
    setNodePickerOpen(false);
    setSaveMessage('');
  };

  const clearNode = () => {
    setSearch('');
    setSelectedNodeKey('');
    setSourceFilter('');
    setSaveMessage('');
    setNodePickerOpen(true);
  };

  const handlePickerKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && visibleNodes.length > 0) {
      event.preventDefault();
      setNodePickerOpen(true);
      window.setTimeout(() => nodeOptionRefs.current[0]?.focus(), 0);
      return;
    }

    if (event.key === 'Enter' && nodePickerOpen && visibleNodes.length > 0) {
      event.preventDefault();
      selectNode(visibleNodes[0]);
      return;
    }

    if (event.key === 'Escape') {
      setNodePickerOpen(false);
    }
  };

  const handleNodeOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nodeOptionRefs.current[Math.min(index + 1, visibleNodes.length - 1)]?.focus();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) {
        pickerInputRef.current?.focus();
      } else {
        nodeOptionRefs.current[index - 1]?.focus();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setNodePickerOpen(false);
      pickerInputRef.current?.focus();
    }
  };

  const sourceBadgeLabel = selectedNode
    ? sourceFilter
      ? selectedSource?.name || sourceFilter
      : selectedNode.sources.length === 1
        ? selectedNode.sources[0].name
        : t('analysis.node_telemetry.all_sources_count', {
            defaultValue: 'All sources · {{count}}',
            count: selectedNode.sources.length,
          })
    : '';

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
          <div
            className={`${styles.field} ${styles.nodeField}`}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setNodePickerOpen(false);
              }
            }}
          >
            <span id={`${pickerId}-label`}>
              {t('analysis.node_telemetry.node_search', 'Search and select node')}
            </span>
            <div className={styles.nodePickerInput}>
              <input
                ref={pickerInputRef}
                type="search"
                role="combobox"
                aria-labelledby={`${pickerId}-label`}
                aria-controls={`${pickerId}-listbox`}
                aria-expanded={nodePickerOpen}
                aria-autocomplete="list"
                autoComplete="off"
                value={search}
                onFocus={() => setNodePickerOpen(true)}
                onKeyDown={handlePickerKeyDown}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSelectedNodeKey('');
                  setSourceFilter('');
                  setSaveMessage('');
                  setNodePickerOpen(true);
                }}
                placeholder={
                  nodesQuery.isLoading
                    ? t('analysis.node_telemetry.loading_nodes', 'Loading nodes…')
                    : t(
                        'analysis.node_telemetry.search_placeholder',
                        'Type a node name or ID…',
                      )
                }
                disabled={nodesQuery.isLoading}
              />
              {(search || selectedNode) && (
                <button
                  type="button"
                  className={styles.clearNodePicker}
                  aria-label={t(
                    'analysis.node_telemetry.clear_node_search',
                    'Clear node search',
                  )}
                  onClick={() => {
                    clearNode();
                    pickerInputRef.current?.focus();
                  }}
                >
                  <UiIcon name="close" size={14} />
                </button>
              )}
            </div>

            {nodePickerOpen && !nodesQuery.isLoading && (
              <div
                id={`${pickerId}-listbox`}
                className={styles.nodeResults}
                role="listbox"
                aria-labelledby={`${pickerId}-label`}
              >
                {visibleNodes.length === 0 ? (
                  <div className={styles.noNodeResults} role="status">
                    {t(
                      'analysis.node_telemetry.no_nodes_found',
                      'No nodes match this search.',
                    )}
                  </div>
                ) : (
                  visibleNodes.map((node, index) => (
                    <button
                      key={node.key}
                      ref={(element) => {
                        nodeOptionRefs.current[index] = element;
                      }}
                      type="button"
                      role="option"
                      aria-selected={node.key === selectedNodeKey}
                      className={`${styles.nodeResult} ${
                        node.key === selectedNodeKey ? styles.nodeResultSelected : ''
                      }`}
                      onClick={() => selectNode(node)}
                      onKeyDown={(event) => handleNodeOptionKeyDown(event, index)}
                    >
                      <span className={styles.nodeResultName}>{node.displayName}</span>
                      <span className={styles.nodeResultMeta}>
                        <span>{node.nodeId}</span>
                        <span>
                          {node.sources.length === 1
                            ? node.sources[0].name
                            : t('analysis.node_telemetry.source_count', {
                                defaultValue: '{{count}} sources',
                                count: node.sources.length,
                              })}
                        </span>
                      </span>
                    </button>
                  ))
                )}
                {filteredNodes.length > MAX_VISIBLE_NODE_RESULTS && (
                  <div className={styles.nodeResultsHint}>
                    {t('analysis.node_telemetry.refine_search', {
                      defaultValue:
                        'Showing the first {{count}} results. Keep typing to narrow the list.',
                      count: MAX_VISIBLE_NODE_RESULTS,
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {selectedNode && selectedNode.sources.length > 1 && (
            <label className={styles.field}>
              <span>{t('analysis.node_telemetry.source', 'Source')}</span>
              <select
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
              >
                <option value="">
                  {t('analysis.node_telemetry.all_sources', 'All sources')}
                </option>
                {selectedNode.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {!nodesQuery.isLoading && (
          <div className={styles.resultCount}>
            {t('analysis.node_telemetry.nodes_found', {
              defaultValue:
                filteredNodes.length === 1
                  ? '{{count}} node found'
                  : '{{count}} nodes found',
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
            <span className={styles.sourceBadge}>{sourceBadgeLabel}</span>
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
            sourceId={telemetrySourceScope}
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