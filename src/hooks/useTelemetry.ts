/**
 * Telemetry data fetching hooks using TanStack Query
 *
 * Provides hooks for fetching telemetry and solar estimate data
 * with automatic caching, deduplication, and periodic refetching.
 * Replaces manual setInterval polling with TanStack Query's built-in
 * refetch capabilities.
 */

import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query';
import { useResolvedSourceId } from './useResolvedSourceId';

const MULTI_SOURCE_PREFIX = '__meshmonitor_multi_source__:';

/**
 * Build a source scope that useTelemetry can resolve to one or more concrete
 * sources. Existing callers can keep passing a normal sourceId unchanged.
 */
export function buildTelemetrySourceScope(sourceIds: string[]): string | null {
  const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];
  if (uniqueSourceIds.length === 0) return null;
  if (uniqueSourceIds.length === 1) return uniqueSourceIds[0];
  return `${MULTI_SOURCE_PREFIX}${uniqueSourceIds.map(encodeURIComponent).join(',')}`;
}

function parseTelemetrySourceScope(sourceId: string): string[] {
  if (!sourceId.startsWith(MULTI_SOURCE_PREFIX)) return [sourceId];

  return sourceId
    .slice(MULTI_SOURCE_PREFIX.length)
    .split(',')
    .filter(Boolean)
    .map((value) => decodeURIComponent(value));
}

/**
 * Telemetry data point from the backend
 */
export interface TelemetryData {
  /** Unique identifier for this telemetry record */
  id?: number;
  /** Node ID in format !xxxxxxxx */
  nodeId: string;
  /** Numeric node identifier */
  nodeNum: number;
  /** Type of telemetry (e.g., 'batteryLevel', 'temperature', 'voltage') */
  telemetryType: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Telemetry value */
  value: number;
  /** Unit of measurement (optional) */
  unit?: string;
  /** Record creation timestamp */
  createdAt: number;
  /** Original packet timestamp, when available */
  packetTimestamp?: number;
  /** Meshtastic packet id, when available */
  packetId?: number;
}

/**
 * Merge telemetry received by multiple MeshMonitor sources without turning one
 * radio packet into multiple graph samples. Packet id is preferred; when the
 * API returns averaged rows (which intentionally omit packet metadata), the
 * metric + bucket timestamp identifies the one logical sample. This keeps one
 * source's value instead of summing or averaging source copies together.
 */
function mergeTelemetrySources(rows: TelemetryData[][]): TelemetryData[] {
  const merged = rows
    .flat()
    .sort((a, b) => a.timestamp - b.timestamp || a.createdAt - b.createdAt);
  const seen = new Set<string>();

  return merged.filter((row) => {
    const sampleTimestamp = row.packetTimestamp ?? row.timestamp;
    const key = row.packetId != null
      ? `packet:${row.nodeId}:${row.packetId}:${row.telemetryType}`
      : `sample:${row.nodeId}:${row.telemetryType}:${sampleTimestamp}`;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Solar power estimate data point
 */
interface SolarEstimate {
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Estimated watt-hours of solar power */
  wattHours: number;
}

/**
 * Response from solar estimates API
 */
interface SolarEstimatesResponse {
  estimates: SolarEstimate[];
}

/**
 * Options for useTelemetry hook
 */
interface UseTelemetryOptions {
  /** Node ID to fetch telemetry for */
  nodeId: string;
  /** Number of hours of historical data to fetch (default: 24) */
  hours?: number;
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Source ID for multi-source deployments */
  sourceId?: string | null;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch telemetry data for a specific node
 *
 * Uses TanStack Query for:
 * - Automatic request deduplication (prevents duplicate in-flight requests)
 * - Caching with configurable stale time
 * - Automatic background refetching every 30 seconds
 * - Loading and error states
 *
 * A source scope produced by buildTelemetrySourceScope() is resolved client-side
 * into parallel per-source requests, then merged into one logical series.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with telemetry data
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useTelemetry({
 *   nodeId: '!abcd1234',
 *   hours: 24
 * });
 * ```
 */
export function useTelemetry({ nodeId, hours = 24, baseUrl = '', sourceId, enabled = true }: UseTelemetryOptions) {
  // The endpoint requires a concrete sourceId. Legacy/single-source callers
  // still fall back to the resolved primary source; report views may pass a
  // synthetic multi-source scope which is expanded before any request is sent.
  const fallbackSourceId = useResolvedSourceId();
  const effectiveSourceId = sourceId ?? fallbackSourceId;

  return useQuery({
    queryKey: ['telemetry', nodeId, hours, effectiveSourceId],
    queryFn: async (): Promise<TelemetryData[]> => {
      const sourceIds = parseTelemetrySourceScope(effectiveSourceId!);
      const responses = await Promise.all(
        sourceIds.map(async (concreteSourceId) => {
          const url = `${baseUrl}/api/telemetry/${nodeId}?hours=${hours}&sourceId=${encodeURIComponent(concreteSourceId)}`;
          const response = await fetch(url);

          if (!response.ok) {
            throw new Error(`Failed to fetch telemetry: ${response.status} ${response.statusText}`);
          }

          return response.json() as Promise<TelemetryData[]>;
        }),
      );

      return sourceIds.length === 1 ? responses[0] : mergeTelemetrySources(responses);
    },
    // Defer until a sourceId is available (required by the endpoint).
    enabled: enabled && !!nodeId && !!effectiveSourceId,
    // Keep showing the prior result while a new window/node loads so the time
    // range selector and charts don't flash a loading state on every change.
    placeholderData: keepPreviousData,
    refetchInterval: 30000, // Refetch every 30 seconds
    staleTime: 25000, // Data considered fresh for 25 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useSolarEstimates hook
 */
interface UseSolarEstimatesOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Start timestamp in Unix seconds */
  startTimestamp?: number;
  /** End timestamp in Unix seconds */
  endTimestamp?: number;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch solar power estimates within a time range
 *
 * Uses TanStack Query for automatic caching and periodic refetching.
 * Returns an empty Map if solar monitoring is not configured.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with solar estimates as Map<timestamp_ms, wattHours>
 *
 * @example
 * ```tsx
 * const { data: solarEstimates } = useSolarEstimates({
 *   startTimestamp: Math.floor(Date.now() / 1000) - 86400,
 *   endTimestamp: Math.floor(Date.now() / 1000)
 * });
 * ```
 */
export function useSolarEstimates({
  baseUrl = '',
  startTimestamp,
  endTimestamp,
  enabled = true,
}: UseSolarEstimatesOptions) {
  return useQuery({
    queryKey: ['solarEstimates', startTimestamp, endTimestamp],
    queryFn: async (): Promise<Map<number, number>> => {
      const response = await fetch(`${baseUrl}/api/solar/estimates/range?start=${startTimestamp}&end=${endTimestamp}`);

      if (!response.ok) {
        // Return empty map if solar monitoring not configured
        return new Map();
      }

      const data: SolarEstimatesResponse = await response.json();

      const estimatesMap = new Map<number, number>();
      if (data.estimates && data.estimates.length > 0) {
        data.estimates.forEach(est => {
          // Convert Unix seconds to milliseconds for consistency with telemetry timestamps
          estimatesMap.set(est.timestamp * 1000, est.wattHours);
        });
      }

      return estimatesMap;
    },
    enabled: enabled && !!startTimestamp && !!endTimestamp,
    refetchInterval: 60000, // Refetch every 60 seconds
    staleTime: 55000, // Data considered fresh for 55 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useSolarEstimatesLatest hook
 */
interface UseSolarEstimatesLatestOptions {
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
  /** Maximum number of estimates to fetch (default: 500) */
  limit?: number;
  /** Whether to enable the query (default: true) */
  enabled?: boolean;
}

/**
 * Hook to fetch latest solar power estimates (no time range)
 *
 * Uses TanStack Query for automatic caching and periodic refetching.
 * Returns an empty Map if solar monitoring is not configured.
 * This is useful for the Dashboard which shows all available solar data.
 *
 * @param options - Configuration options
 * @returns TanStack Query result with solar estimates as Map<timestamp_ms, wattHours>
 */
export function useSolarEstimatesLatest({
  baseUrl = '',
  limit = 500,
  enabled = true,
}: UseSolarEstimatesLatestOptions = {}) {
  return useQuery({
    queryKey: ['solarEstimatesLatest', limit],
    queryFn: async (): Promise<Map<number, number>> => {
      const response = await fetch(`${baseUrl}/api/solar/estimates?limit=${limit}`);

      if (!response.ok) {
        // Return empty map if solar monitoring not configured
        return new Map();
      }

      const data: SolarEstimatesResponse = await response.json();

      const estimatesMap = new Map<number, number>();
      if (data.estimates && data.estimates.length > 0) {
        data.estimates.forEach(est => {
          // Convert Unix seconds to milliseconds for consistency with telemetry timestamps
          estimatesMap.set(est.timestamp * 1000, est.wattHours);
        });
      }

      return estimatesMap;
    },
    enabled,
    refetchInterval: 300000, // Refetch every 5 minutes
    staleTime: 290000, // Data considered fresh for ~5 minutes
    gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Options for useNodeVoltages hook
 */
interface UseNodeVoltagesOptions {
  /** Node IDs that need fallback voltage data */
  nodeIds: string[];
  /** Base URL for API requests (default: '') */
  baseUrl?: string;
}

/**
 * Hook to fetch latest voltage telemetry for multiple nodes
 *
 * Uses useQueries to leverage TanStack Query caching and deduplication
 * per node, avoiding redundant fetches on re-renders.
 *
 * @param options - Configuration options
 * @returns Map of nodeId to latest voltage value
 */
export function useNodeVoltages({ nodeIds, baseUrl = '' }: UseNodeVoltagesOptions): Map<string, number> {
  const results = useQueries({
    queries: nodeIds.map(nodeId => ({
      queryKey: ['nodeVoltage', nodeId],
      queryFn: async (): Promise<{ nodeId: string; value: number } | null> => {
        try {
          const response = await fetch(`${baseUrl}/api/telemetry/${encodeURIComponent(nodeId)}?hours=720`);
          if (!response.ok) return null;
          const data = await response.json();

          const telemetryRows: TelemetryData[] = Array.isArray(data) ? data : [];
          const voltageRows = telemetryRows.filter(row => row.telemetryType === 'voltage');
          if (voltageRows.length === 0) return null;

          const latest = voltageRows.reduce((prev, current) =>
            current.timestamp > prev.timestamp ? current : prev
          );
          const value = Number(latest.value);
          if (Number.isNaN(value)) return null;

          return { nodeId, value };
        } catch {
          return null;
        }
      },
      staleTime: 5 * 60 * 1000, // Fresh for 5 minutes
      gcTime: 10 * 60 * 1000, // Cache for 10 minutes
      refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
      refetchOnWindowFocus: false,
    })),
  });

  const voltageMap = new Map<string, number>();
  results.forEach(result => {
    if (result.data) {
      voltageMap.set(result.data.nodeId, result.data.value);
    }
  });

  return voltageMap;
}