export type TelemetryChannelLabels = Record<string, Record<string, string>>;

const CHANNEL_NUMBER_RE = /^[1-8]$/;
const POWER_METRIC_RE = /^ch([1-8])(Voltage|Current)$/;
const MAX_NODE_KEY_LENGTH = 240;
export const MAX_TELEMETRY_CHANNEL_LABEL_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stable key for labels belonging to one node as observed by one source.
 * Encoding both parts prevents separators inside a source ID from colliding.
 */
export function telemetryChannelLabelKey(sourceId: string, nodeId: string): string {
  return `${encodeURIComponent(sourceId)}:${encodeURIComponent(nodeId.toLowerCase())}`;
}

/**
 * Parse and normalize the JSON-backed setting. Invalid entries are ignored so
 * a manually edited or older setting cannot break the Reports workspace.
 */
export function parseTelemetryChannelLabels(raw: unknown): TelemetryChannelLabels {
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (!isRecord(parsed)) return {};

  const normalized: TelemetryChannelLabels = {};
  for (const [nodeKey, channelValues] of Object.entries(parsed)) {
    if (!nodeKey || nodeKey.length > MAX_NODE_KEY_LENGTH || !isRecord(channelValues)) {
      continue;
    }

    const normalizedChannels: Record<string, string> = {};
    for (const [channel, value] of Object.entries(channelValues)) {
      if (!CHANNEL_NUMBER_RE.test(channel) || typeof value !== 'string') continue;
      const label = value.trim().slice(0, MAX_TELEMETRY_CHANNEL_LABEL_LENGTH);
      if (label) normalizedChannels[channel] = label;
    }

    if (Object.keys(normalizedChannels).length > 0) {
      normalized[nodeKey] = normalizedChannels;
    }
  }

  return normalized;
}

export function getPowerChannelNumbers(telemetryTypes: Iterable<string>): number[] {
  const channels = new Set<number>();
  for (const telemetryType of telemetryTypes) {
    const match = telemetryType.match(POWER_METRIC_RE);
    if (match) channels.add(Number(match[1]));
  }
  return [...channels].sort((a, b) => a - b);
}

/**
 * Expand a user-facing channel name to the exact voltage/current metric names
 * consumed by TelemetryGraphs.
 */
export function buildPowerMetricLabelOverrides(
  channelLabels: Record<string, string> | undefined,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (!channelLabels) return overrides;

  for (const [channel, rawLabel] of Object.entries(channelLabels)) {
    if (!CHANNEL_NUMBER_RE.test(channel)) continue;
    const label = rawLabel.trim();
    if (!label) continue;
    overrides[`ch${channel}Voltage`] = `${label} · Voltage`;
    overrides[`ch${channel}Current`] = `${label} · Current`;
  }

  return overrides;
}
