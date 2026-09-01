import { useMemo, useState, type MouseEvent } from 'react';
import { Popup } from 'react-leaflet';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DistanceUnit } from '../../../contexts/SettingsContext';
import { formatRelativeTime } from '../../../utils/datetime';
import { formatDistance } from '../../../utils/distance';
import {
  isUnknownSnr,
  type TracerouteRenderSegment,
} from '../../../utils/tracerouteSegments';
import { UiIcon } from '../../icons';

interface ChartDatum {
  timeDecimal: number;
  timeLabel: string;
  snr: number;
  fullTimestamp: number;
}

/** Small chart for route-segment SNR samples with two time-axis modes. */
function SegmentSnrChart({ chartData }: { chartData: ChartDatum[] }) {
  const [mode, setMode] = useState<'timeOfDay' | 'chronological'>('timeOfDay');

  const chronoData = useMemo(
    () =>
      [...chartData]
        .sort((a, b) => a.fullTimestamp - b.fullTimestamp)
        .map((datum) => {
          const date = new Date(datum.fullTimestamp);
          const month = (date.getMonth() + 1).toString().padStart(2, '0');
          const day = date.getDate().toString().padStart(2, '0');
          const hours = date.getHours().toString().padStart(2, '0');
          const minutes = date.getMinutes().toString().padStart(2, '0');
          return {
            ...datum,
            chronoLabel: `${month}/${day} ${hours}:${minutes}`,
            chronoTime: datum.fullTimestamp,
          };
        }),
    [chartData],
  );

  return (
    <div className="snr-timeline-chart">
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
        <button
          className={`node-popup-tab ${mode === 'timeOfDay' ? 'active' : ''}`}
          style={{
            fontSize: '10px',
            padding: '2px 8px',
            border: '1px solid var(--ctp-surface2)',
            borderRadius: '4px',
            cursor: 'pointer',
            background: mode === 'timeOfDay' ? 'var(--ctp-blue)' : 'var(--ctp-surface0)',
            color: mode === 'timeOfDay' ? 'var(--ctp-base)' : 'var(--ctp-subtext1)',
          }}
          onClick={(event) => {
            event.stopPropagation();
            setMode('timeOfDay');
          }}
        >
          Time of Day
        </button>
        <button
          className={`node-popup-tab ${mode === 'chronological' ? 'active' : ''}`}
          style={{
            fontSize: '10px',
            padding: '2px 8px',
            border: '1px solid var(--ctp-surface2)',
            borderRadius: '4px',
            cursor: 'pointer',
            background: mode === 'chronological' ? 'var(--ctp-blue)' : 'var(--ctp-surface0)',
            color: mode === 'chronological' ? 'var(--ctp-base)' : 'var(--ctp-subtext1)',
          }}
          onClick={(event) => {
            event.stopPropagation();
            setMode('chronological');
          }}
        >
          Over Time
        </button>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        {mode === 'timeOfDay' ? (
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--ctp-surface2)" />
            <XAxis
              dataKey="timeDecimal"
              type="number"
              domain={[0, 24]}
              ticks={[0, 6, 12, 18, 24]}
              tickFormatter={(value) => {
                const hours = Math.floor(value);
                const minutes = Math.round((value - hours) * 60);
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              }}
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
            />
            <YAxis
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
              label={{
                value: 'SNR (dB)',
                angle: -90,
                position: 'insideLeft',
                style: { fill: 'var(--ctp-subtext1)', fontSize: 10 },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--ctp-surface0)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'var(--ctp-text)' }}
              labelFormatter={(value) => {
                const item = chartData.find((datum) => datum.timeDecimal === value);
                return item ? item.timeLabel : String(value);
              }}
            />
            <Line
              type="monotone"
              dataKey="snr"
              stroke="var(--ctp-mauve)"
              strokeWidth={2}
              dot={{ fill: 'var(--ctp-mauve)', r: 3 }}
            />
          </LineChart>
        ) : (
          <LineChart data={chronoData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--ctp-surface2)" />
            <XAxis
              dataKey="chronoTime"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(value) => {
                const date = new Date(value);
                return `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date
                  .getDate()
                  .toString()
                  .padStart(2, '0')}`;
              }}
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
            />
            <YAxis
              tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
              stroke="var(--ctp-surface2)"
              label={{
                value: 'SNR (dB)',
                angle: -90,
                position: 'insideLeft',
                style: { fill: 'var(--ctp-subtext1)', fontSize: 10 },
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--ctp-surface0)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'var(--ctp-text)' }}
              labelFormatter={(value) => {
                const item = chronoData.find((datum) => datum.chronoTime === value);
                return item ? item.chronoLabel : String(value);
              }}
            />
            <Line
              type="monotone"
              dataKey="snr"
              stroke="var(--ctp-mauve)"
              strokeWidth={2}
              dot={{ fill: 'var(--ctp-mauve)', r: 3 }}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export interface RouteSegmentPopupProps {
  segment: TracerouteRenderSegment;
  fromName: string;
  toName: string;
  distanceKm?: number;
  distanceUnit: DistanceUnit;
  /** Override the segment's occurrence count with a consumer-owned aggregate. */
  usageCount?: number;
  /** Override the segment's samples with a consumer-owned aggregate. */
  snrSamples?: Array<{ snr: number; timestamp?: number }>;
  /** Override whether any observation for this segment travelled over IP. */
  isMqtt?: boolean;
  /** Optional Dashboard-only attribution. */
  sourceName?: string | null;
  /** Optional Dashboard-only most-recent observation timestamp, in milliseconds. */
  lastSeen?: number | null;
  onFromNodeClick?: () => void;
  onToNodeClick?: () => void;
  onUsageClick?: () => void;
}

function EndpointName({
  name,
  onClick,
}: {
  name: string;
  onClick?: () => void;
}) {
  const handleClick = onClick
    ? (event: MouseEvent<HTMLElement>) => {
        event.stopPropagation();
        onClick();
      }
    : undefined;

  return (
    <strong
      className={onClick ? 'route-node-link' : undefined}
      onClick={handleClick}
      title={onClick ? 'Click to select and center on this node' : ''}
    >
      {name}
    </strong>
  );
}

/**
 * Shared advanced popup for a physical traceroute segment.
 *
 * The Nodes map supplies callbacks for its existing navigation affordances;
 * Dashboard consumers omit them and render the same information read-only.
 */
export default function RouteSegmentPopup({
  segment,
  fromName,
  toName,
  distanceKm = 0,
  distanceUnit,
  usageCount = segment.usageCount ?? 1,
  snrSamples = segment.snrSamples ?? [],
  isMqtt = segment.isMqtt,
  sourceName,
  lastSeen,
  onFromNodeClick,
  onToNodeClick,
  onUsageClick,
}: RouteSegmentPopupProps) {
  const finiteSnrSamples = snrSamples.filter(
    (sample) => Number.isFinite(sample.snr) && !isUnknownSnr(sample.snr),
  );
  const snrValues = finiteSnrSamples.map((sample) => sample.snr);
  const snrStats =
    snrValues.length > 0
      ? {
          min: Math.min(...snrValues).toFixed(1),
          max: Math.max(...snrValues).toFixed(1),
          avg: (snrValues.reduce((sum, value) => sum + value, 0) / snrValues.length).toFixed(1),
          count: snrValues.length,
        }
      : null;

  const chartData: ChartDatum[] | null =
    finiteSnrSamples.length >= 3
      ? finiteSnrSamples
          .filter((sample): sample is { snr: number; timestamp: number } =>
            typeof sample.timestamp === 'number' && sample.timestamp > 0,
          )
          .map((sample) => {
            const date = new Date(sample.timestamp);
            const hours = date.getHours();
            const minutes = date.getMinutes();
            return {
              timeDecimal: hours + minutes / 60,
              timeLabel: `${hours.toString().padStart(2, '0')}:${minutes
                .toString()
                .padStart(2, '0')}`,
              snr: Number(sample.snr.toFixed(1)),
              fullTimestamp: sample.timestamp,
            };
          })
          .sort((a, b) => a.timeDecimal - b.timeDecimal)
      : null;

  const usageValue = onUsageClick ? (
    <strong
      onClick={(event) => {
        event.stopPropagation();
        onUsageClick();
      }}
      style={{ cursor: 'pointer', color: 'var(--ctp-blue)', textDecoration: 'underline' }}
      title="Click to view all traceroutes using this segment"
    >
      {usageCount}
    </strong>
  ) : (
    <strong>{usageCount}</strong>
  );

  return (
    <Popup>
      <div className="route-popup">
        <h4>TRACEROUTE · Route Segment</h4>
        {isMqtt && <div className="mqtt-badge">via IP</div>}
        <div className="route-endpoints">
          <EndpointName name={fromName} onClick={onFromNodeClick} />
          {' '}
          <UiIcon name="bidirectional" size={14} />
          {' '}
          <EndpointName name={toName} onClick={onToNodeClick} />
        </div>
        <div className="route-usage">
          Used in {usageValue} traceroute{usageCount !== 1 ? 's' : ''}
        </div>
        {distanceKm > 0 && (
          <div className="route-usage">
            Distance: <strong>{formatDistance(distanceKm, distanceUnit)}</strong>
          </div>
        )}
        {sourceName && (
          <div className="route-usage">
            Source: <strong>{sourceName}</strong>
          </div>
        )}
        {typeof lastSeen === 'number' && lastSeen > 0 && (
          <div className="route-usage">
            Last traced: <strong>{formatRelativeTime(lastSeen)}</strong>
          </div>
        )}
        {snrStats && (
          <div className="route-snr-stats">
            {snrStats.count === 1 ? (
              <>
                <h5>SNR:</h5>
                <div className="snr-stat-row">
                  <span className="stat-value">{snrStats.min} dB</span>
                </div>
              </>
            ) : snrStats.count === 2 ? (
              <>
                <h5>SNR Statistics:</h5>
                <div className="snr-stat-row">
                  <span className="stat-label">Min:</span>
                  <span className="stat-value">{snrStats.min} dB</span>
                </div>
                <div className="snr-stat-row">
                  <span className="stat-label">Max:</span>
                  <span className="stat-value">{snrStats.max} dB</span>
                </div>
                <div className="snr-stat-row">
                  <span className="stat-label">Samples:</span>
                  <span className="stat-value">{snrStats.count}</span>
                </div>
              </>
            ) : (
              <>
                <h5>SNR Statistics:</h5>
                <div className="snr-stat-row">
                  <span className="stat-label">Min:</span>
                  <span className="stat-value">{snrStats.min} dB</span>
                </div>
                <div className="snr-stat-row">
                  <span className="stat-label">Max:</span>
                  <span className="stat-value">{snrStats.max} dB</span>
                </div>
                <div className="snr-stat-row">
                  <span className="stat-label">Average:</span>
                  <span className="stat-value">{snrStats.avg} dB</span>
                </div>
                <div className="snr-stat-row">
                  <span className="stat-label">Samples:</span>
                  <span className="stat-value">{snrStats.count}</span>
                </div>
                {chartData && chartData.length >= 3 && <SegmentSnrChart chartData={chartData} />}
              </>
            )}
          </div>
        )}
      </div>
    </Popup>
  );
}
