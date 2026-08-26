import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  upsertNodeMock: vi.fn(),
  getAllNodesMock: vi.fn(),
  getAllSourcesMock: vi.fn(),
  getManagerMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: h.getNodeMock,
      upsertNode: h.upsertNodeMock,
      getAllNodes: h.getAllNodesMock,
    },
    sources: {
      getAllSources: h.getAllSourcesMock,
    },
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: h.getManagerMock,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  copyNodeInfo,
  countFilledNodeInfoFields,
  isNodeInfoFieldBlank,
} from './nodeInfoCopyService.js';
import { analyzeEnrichment } from './nodeInfoEnrichmentService.js';

const makeNode = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  nodeNum: 100,
  nodeId: '!00000064',
  sourceId,
  longName: null,
  shortName: null,
  hwModel: null,
  role: null,
  macaddr: null,
  publicKey: null,
  hasPKC: null,
  firmwareVersion: null,
  updatedAt: 1000,
  lastHeard: 900,
  createdAt: 500,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.upsertNodeMock.mockResolvedValue(undefined);
  h.getAllSourcesMock.mockResolvedValue([
    { id: 'src-A', name: 'Source A', type: 'meshtastic_tcp' },
    { id: 'src-B', name: 'Source B', type: 'mqtt_bridge' },
  ]);
});

describe('HardwareModel.UNSET enrichment regression', () => {
  it('treats hwModel=0 as blank without treating other zero-valued fields as blank', () => {
    expect(isNodeInfoFieldBlank(0, 'hwModel')).toBe(true);
    expect(isNodeInfoFieldBlank(0, 'role')).toBe(false);

    const fieldsFilled = countFilledNodeInfoFields(
      makeNode('src-A', { hwModel: 0, role: 0 }),
    );
    expect(fieldsFilled).toBe(1); // role=0 is valid; hwModel=0 is UNSET
  });

  it('does not copy hwModel=0 from a donor', async () => {
    const donor = makeNode('src-B', { longName: 'MQTT donor', hwModel: 0 });
    const target = makeNode('src-A');

    h.getNodeMock
      .mockResolvedValueOnce(donor)
      .mockResolvedValueOnce(target);

    const result = await copyNodeInfo(100, 'src-B', 'src-A');

    expect(result.copiedFields).toContain('longName');
    expect(result.copiedFields).not.toContain('hwModel');
    expect(h.upsertNodeMock).toHaveBeenCalledOnce();
    expect(h.upsertNodeMock.mock.calls[0][0]).not.toHaveProperty('hwModel');
  });

  it('does not advertise hwModel=0 as a fillable enrichment field', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeNode('src-A', { longName: 'Target', hwModel: null }),
      makeNode('src-B', { longName: 'Donor', hwModel: 0 }),
    ]);

    const result = await analyzeEnrichment();

    expect(result.nodes).toEqual([]);
    expect(result.summary).toEqual({ nodeCount: 0, targetCount: 0, fieldCount: 0 });
  });
});
