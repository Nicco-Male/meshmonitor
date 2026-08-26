/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { telemetryChannelLabelKey } from '../../utils/telemetryChannelLabels';
import NodeTelemetryReport from './NodeTelemetryReport';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  csrfFetch: vi.fn(),
  telemetryProps: null as Record<string, unknown> | null,
}));

vi.mock('../../services/api', () => ({
  default: { get: mocks.apiGet },
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mocks.csrfFetch,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: () => true,
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    temperatureUnit: 'C',
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (typeof options === 'string') return options;
      const template =
        typeof options?.defaultValue === 'string' ? options.defaultValue : key;
      return template.replace(
        /\{\{(\w+)\}\}/g,
        (_match, name: string) => String(options?.[name] ?? ''),
      );
    },
  }),
}));

vi.mock('../TelemetryGraphs', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.telemetryProps = props;
    return <div data-testid="telemetry-graphs">{String(props.nodeId)}</div>;
  },
}));

vi.mock('../icons', () => ({
  UiIcon: () => null,
}));

function renderReport() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<NodeTelemetryReport />, { wrapper: Wrapper });
}

const nodeKey = telemetryChannelLabelKey('source-a', '!e1820fa0');

async function selectLineaGoticaNode() {
  const nodeSearch = await screen.findByRole('combobox', {
    name: 'Search and select node',
  });
  fireEvent.change(nodeSearch, { target: { value: 'Linea Gotica' } });
  const option = await screen.findByRole('option', {
    name: /Linea Gotica sixt.*!e1820fa0.*NiccoPisa/i,
  });
  fireEvent.click(option);
}

describe('NodeTelemetryReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.telemetryProps = null;
    mocks.csrfFetch.mockResolvedValue({ ok: true, status: 200 });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/api/settings') {
        return Promise.resolve({
          telemetryChannelLabels: JSON.stringify({
            [nodeKey]: { 1: 'Solar panel' },
          }),
        });
      }
      if (path === '/api/unified/telemetry?hours=168') {
        return Promise.resolve([
          {
            nodeId: '!e1820fa0',
            telemetryType: 'batteryLevel',
            sourceId: 'source-a',
            sourceName: 'NiccoPisa',
            nodeLongName: 'Linea Gotica sixt',
          },
          {
            nodeId: '!e1820fa0',
            telemetryType: 'ch1Voltage',
            sourceId: 'source-a',
            sourceName: 'NiccoPisa',
            nodeLongName: 'Linea Gotica sixt',
          },
          {
            nodeId: '!e1820fa0',
            telemetryType: 'ch1Current',
            sourceId: 'source-a',
            sourceName: 'NiccoPisa',
            nodeLongName: 'Linea Gotica sixt',
          },
          {
            nodeId: '!00000002',
            telemetryType: 'ch3Voltage',
            sourceId: 'source-b',
            sourceName: 'Nicco Berry Pisa',
            nodeLongName: 'Other node',
            nodeShortName: 'OTHR',
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });
  });

  it('selects one source-scoped node and applies saved channel names to its charts', async () => {
    renderReport();

    await selectLineaGoticaNode();

    expect(await screen.findByDisplayValue('Solar panel')).toBeInTheDocument();
    expect(screen.getByText('1 node found')).toBeInTheDocument();
    expect(screen.getByText('Voltage')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-graphs')).toHaveTextContent('!e1820fa0');
    expect(mocks.telemetryProps).toMatchObject({
      nodeId: '!e1820fa0',
      sourceId: 'source-a',
      readOnly: true,
      showTimeRangeSelector: true,
      labelOverrides: {
        ch1Voltage: 'Solar panel · Voltage',
        ch1Current: 'Solar panel · Current',
      },
    });
  });

  it('persists a renamed current/voltage channel in the global setting', async () => {
    renderReport();

    await selectLineaGoticaNode();
    const channelInput = await screen.findByLabelText('Channel 1 name');
    fireEvent.change(channelInput, { target: { value: 'Battery bank' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(1));
    const [, init] = mocks.csrfFetch.mock.calls[0] as [
      string,
      { body: string },
    ];
    const body = JSON.parse(init.body);
    expect(JSON.parse(body.telemetryChannelLabels)).toEqual({
      [nodeKey]: { 1: 'Battery bank' },
    });
    expect(await screen.findByText('Channel names saved.')).toBeInTheDocument();
  });

  it('filters the searchable node picker by node ID and selects the matching result', async () => {
    renderReport();

    const nodeSearch = await screen.findByRole('combobox', {
      name: 'Search and select node',
    });
    fireEvent.change(nodeSearch, { target: { value: 'Other 00000002' } });

    expect(
      screen.queryByRole('option', { name: /Linea Gotica sixt/i }),
    ).not.toBeInTheDocument();
    const matchingNode = await screen.findByRole('option', {
      name: /Other node.*!00000002.*Nicco Berry Pisa/i,
    });
    fireEvent.click(matchingNode);

    expect(screen.getByTestId('telemetry-graphs')).toHaveTextContent('!00000002');
    expect(mocks.telemetryProps).toMatchObject({
      nodeId: '!00000002',
      sourceId: 'source-b',
    });
  });

  it('does not match nodes by source name', async () => {
    renderReport();

    const nodeSearch = await screen.findByRole('combobox', {
      name: 'Search and select node',
    });
    fireEvent.change(nodeSearch, { target: { value: 'nicco' } });

    expect(
      await screen.findByText('No nodes match this search.'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 nodes found')).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Linea Gotica sixt/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Other node/i }),
    ).not.toBeInTheDocument();
  });

  it('matches a node by its short name', async () => {
    renderReport();

    const nodeSearch = await screen.findByRole('combobox', {
      name: 'Search and select node',
    });
    fireEvent.change(nodeSearch, { target: { value: 'OTHR' } });

    expect(
      await screen.findByRole('option', {
        name: /Other node.*!00000002.*Nicco Berry Pisa/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 node found')).toBeInTheDocument();
  });
});
