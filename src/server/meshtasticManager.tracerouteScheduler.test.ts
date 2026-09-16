import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetNodeNeedingTracerouteAsync = vi.fn();
const mockLogAutoTracerouteAttemptAsync = vi.fn();
const mockUpdateAutoTracerouteResultByNodeAsync = vi.fn();
const mockRecordTracerouteRequest = vi.fn();
const mockFindUserByIdAsync = vi.fn();
const mockFindUserByUsernameAsync = vi.fn();
const mockCheckPermissionAsync = vi.fn();
const mockGetUserPermissionSetAsync = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    getNodeNeedingTracerouteAsync: mockGetNodeNeedingTracerouteAsync,
    logAutoTracerouteAttemptAsync: mockLogAutoTracerouteAttemptAsync,
    updateAutoTracerouteResultByNodeAsync: mockUpdateAutoTracerouteResultByNodeAsync,
    recordTracerouteRequest: mockRecordTracerouteRequest,
    recordTracerouteRequestAsync: mockRecordTracerouteRequest,
    findUserByIdAsync: mockFindUserByIdAsync,
    findUserByUsernameAsync: mockFindUserByUsernameAsync,
    checkPermissionAsync: mockCheckPermissionAsync,
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      // Per-source settings lookup — delegates to the same stub used for
      // global settings so existing tests against `mockGetSetting` still work
      // after the multi-source refactor routed these reads through
      // `getSettingForSource(this.sourceId, ...)`.
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
    },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      getAllNodes: vi.fn().mockResolvedValue([]),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      markNodeAsWelcomedIfNotAlready: vi.fn().mockResolvedValue(false),
      getNodeCount: vi.fn().mockResolvedValue(0),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
      updateNodeMessageHops: vi.fn().mockResolvedValue(undefined),
    },
    channels: {
      getChannelById: vi.fn().mockResolvedValue(null),
      getAllChannels: vi.fn().mockResolvedValue([]),
      upsertChannel: vi.fn().mockResolvedValue(undefined),
      getChannelCount: vi.fn().mockResolvedValue(0),
    },
    telemetry: {
      insertTelemetry: vi.fn().mockResolvedValue(undefined),
      insertTelemetryBatch: vi.fn().mockResolvedValue(0),
      getLatestTelemetryForType: vi.fn().mockResolvedValue(null),
    },
    messages: {
      insertMessage: vi.fn().mockResolvedValue(true),
      getMessages: vi.fn().mockResolvedValue([]),
      updateMessageTimestamps: vi.fn().mockResolvedValue(true),
      updateMessageDeliveryState: vi.fn().mockResolvedValue(true),
    },
    traceroutes: {
      insertTraceroute: vi.fn().mockResolvedValue(undefined),
      insertRouteSegment: vi.fn().mockResolvedValue(undefined),
    },
    neighbors: {
      upsertNeighborInfo: vi.fn().mockResolvedValue(undefined),
      deleteNeighborInfoForNode: vi.fn().mockResolvedValue(0),
    },
    logKeyRepairAttemptAsync: vi.fn().mockResolvedValue(0),
    clearKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    deleteNodeAsync: vi.fn().mockResolvedValue({}),
    getNodeNeedingTimeSyncAsync: vi.fn().mockResolvedValue(null),
    getNodeNeedingRemoteAdminCheckAsync: vi.fn().mockResolvedValue(null),
    updateNodeRemoteAdminStatusAsync: vi.fn().mockResolvedValue(undefined),
    getNodesNeedingKeyRepairAsync: vi.fn().mockResolvedValue([]),
    getKeyRepairLogAsync: vi.fn().mockResolvedValue([]),
    setKeyRepairStateAsync: vi.fn().mockResolvedValue(undefined),
    insertTelemetryAsync: vi.fn().mockResolvedValue(undefined),
    getLatestTelemetryForTypeAsync: vi.fn().mockResolvedValue(null),
    getMessageByRequestIdAsync: vi.fn().mockResolvedValue(null),
    updateNodeMobilityAsync: vi.fn().mockResolvedValue(0),
    getRecentEstimatedPositionsAsync: vi.fn().mockResolvedValue([]),
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    setGeofenceCooldownAsync: vi.fn().mockResolvedValue(undefined),
    markMessageAsReadAsync: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('./meshtasticProtobufService.js', () => ({
  default: {
    initialize: vi.fn(),
    createMeshPacket: vi.fn(),
    createTracerouteMessage: vi.fn(() => new Uint8Array([1, 2, 3])),
  },
}));

vi.mock('./protobufService.js', () => ({
  default: {
    encode: vi.fn(),
    decode: vi.fn(),
  },
  convertIpv4ConfigToStrings: vi.fn(),
}));

vi.mock('./protobufLoader.js', () => ({
  getProtobufRoot: vi.fn(),
}));

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    checkAndSendNotifications: vi.fn(),
  },
}));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn(),
    notifyNodeDisconnected: vi.fn(),
  },
}));

vi.mock('./services/packetLogService.js', () => ({
  default: {
    logPacket: vi.fn(),
    isEnabled: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: {
    tryDecrypt: vi.fn(),
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./messageQueueService.js', () => {
  const mockInstance = {
    enqueue: vi.fn(),
    setSendCallback: vi.fn(),
    handleAck: vi.fn(),
    handleFailure: vi.fn(),
    recordExternalSend: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(() => ({ queueLength: 0, pendingAcks: 0, processing: false })),
  };
  // Use a regular function (not arrow) so it's callable with `new`.
  // Returning `mockInstance` from a constructor replaces `this` with it.
  function MessageQueueService() { return mockInstance as any; }
  return {
    messageQueueService: mockInstance,
    MessageQueueService,
  };
});

vi.mock('./utils/cronScheduler.js', () => ({
  validateCron: vi.fn(() => true),
  scheduleCron: vi.fn((_expression: string, _callback: () => void) => ({
    stop: vi.fn(),
  })),
}));

vi.mock('./config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => ({
    NODE_IP: '127.0.0.1',
    TCP_PORT: 4403,
    LOG_LEVEL: 'info',
  })),
}));

vi.mock('../utils/autoResponderUtils.js', () => ({
  normalizeTriggerPatterns: vi.fn((trigger: string) => [trigger]),
  normalizeTriggerChannels: vi.fn(() => [0]),
}));

vi.mock('../utils/nodeHelpers.js', () => ({
  isNodeComplete: vi.fn(),
}));

import { tracerouteCampaignCoordinator } from './services/tracerouteCampaignCoordinator.js';
import { tracerouteRequestScheduler } from './services/tracerouteRequestScheduler.js';

const mockTargetNode = {
  nodeNum: 99999,
  nodeId: '!00099999',
  longName: 'Target Node',
  shortName: 'TARG',
  hwModel: 0,
  createdAt: 0,
  updatedAt: 0,
  channel: 0,
};

describe('MeshtasticManager - Traceroute Scheduler', () => {
  let manager: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Make jitter deterministic: 0 jitter means immediate execution
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // Dynamic import to get fresh module instance with mocks applied
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;

    // Set up the manager to think it's connected with local node info
    manager.isConnected = true;
    manager.localNodeInfo = {
      nodeNum: 1234567890,
      nodeId: '!12345678',
      longName: 'Test Node',
      shortName: 'TN',
    };

    // Reset rate limiting timestamp
    manager.lastTracerouteSentTime = 0;
    manager.pendingAutoTraceroutes.clear();
    manager.pendingTracerouteTimestamps.clear();
    manager.pendingAutoresponderTraceroutes.clear();
    manager.autoResponderProcessedPackets.clear();
    mockGetSetting.mockResolvedValue(null);

    // Mock sendTraceroute to avoid actually sending
    manager.sendTraceroute = vi.fn().mockResolvedValue(undefined);
    manager.checkTracerouteTimeouts = vi.fn();

    // Mock database calls
    mockGetNodeNeedingTracerouteAsync.mockResolvedValue(mockTargetNode);
    mockLogAutoTracerouteAttemptAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up timers
    manager.tracerouteIntervalMinutes = 0;
    if (manager.tracerouteJitterTimeout) {
      clearTimeout(manager.tracerouteJitterTimeout);
      manager.tracerouteJitterTimeout = null;
    }
    if (manager.tracerouteInterval) {
      clearInterval(manager.tracerouteInterval);
      manager.tracerouteInterval = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Helper: bind and call startTracerouteScheduler with the given interval
   */
  function startScheduler(minutes: number) {
    manager.tracerouteIntervalMinutes = minutes;
    const fn = manager['startTracerouteScheduler'].bind(manager);
    fn();
  }

  it('skips automatic selection while a campaign reserves this source', async () => {
    tracerouteCampaignCoordinator.reserve('auto-test-campaign', [manager.sourceId]);
    try {
      startScheduler(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.sendTraceroute).not.toHaveBeenCalled();
      expect(mockGetNodeNeedingTracerouteAsync).not.toHaveBeenCalled();
    } finally {
      tracerouteCampaignCoordinator.release('auto-test-campaign');
    }
  });

  it('skips an automatic trace when the shared arbiter already has work for this source', async () => {
    vi.spyOn(tracerouteRequestScheduler, 'hasPendingForSource').mockReturnValue(true);
    startScheduler(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.sendTraceroute).not.toHaveBeenCalled();
    expect(mockGetNodeNeedingTracerouteAsync).not.toHaveBeenCalled();
  });

  it('submits automatic priority and starts response/rate-limit clocks only after dispatch', async () => {
    let dispatched!: () => void;
    manager.sendTraceroute.mockImplementation(() => new Promise<void>(resolve => { dispatched = resolve; }));
    startScheduler(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.sendTraceroute).toHaveBeenCalledWith(mockTargetNode.nodeNum, 0, 'automatic');
    expect(manager.lastTracerouteSentTime).toBe(0);
    expect(manager.pendingTracerouteTimestamps.has(mockTargetNode.nodeNum)).toBe(false);
    // Stop periodic submissions while this mocked dispatch remains queued.
    startScheduler(0);
    await vi.advanceTimersByTimeAsync(120_000);
    dispatched();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.lastTracerouteSentTime).toBe(Date.now());
    expect(manager.pendingTracerouteTimestamps.get(mockTargetNode.nodeNum)).toBe(Date.now());
  });

  it('removes automatic timeout tracking if a queued send fails or is cancelled', async () => {
    manager.sendTraceroute.mockRejectedValue(new Error('source disconnected'));
    startScheduler(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.pendingAutoTraceroutes.has(mockTargetNode.nodeNum)).toBe(false);
    expect(manager.pendingTracerouteTimestamps.has(mockTargetNode.nodeNum)).toBe(false);
    expect(manager.lastTracerouteSentTime).toBe(0);
  });

  it('gives a legacy Auto Responder its full 75 seconds after queued dispatch', async () => {
    const database = (await import('../services/database.js')).default;
    vi.mocked(database.nodes.getAllNodes).mockResolvedValue([mockTargetNode]);
    const settings: Record<string, string> = {
      autoResponderEnabled: 'true',
      autoResponderTriggers: JSON.stringify([{ trigger: 'trace', responseType: 'traceroute', response: '99999', channel: 0 }]),
    };
    mockGetSetting.mockImplementation((key: string) => Promise.resolve(settings[key] ?? null));
    manager.actualDeviceConfig = { lora: { txEnabled: true } };
    let dispatched!: () => void;
    manager.sendTraceroute.mockImplementation(() => new Promise<void>(resolve => { dispatched = resolve; }));
    const run = manager.checkAutoResponder({ text: 'trace', fromNodeNum: 99, channel: 0 }, false, 444);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.sendTraceroute).toHaveBeenCalledWith(mockTargetNode.nodeNum, 0, 'automation');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(manager.pendingAutoresponderTraceroutes.has(mockTargetNode.nodeNum)).toBe(true);
    expect(manager.pendingAutoresponderTraceroutes.get(mockTargetNode.nodeNum).timeoutHandle).toBeUndefined();
    dispatched();
    await run;
    await vi.advanceTimersByTimeAsync(74_999);
    expect(manager.pendingAutoresponderTraceroutes.has(mockTargetNode.nodeNum)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.pendingAutoresponderTraceroutes.has(mockTargetNode.nodeNum)).toBe(false);
  });

  describe('Timer leak prevention', () => {
    it('should clear pending jitter timeout when scheduler is restarted', async () => {
      // Use non-zero jitter for this test to verify the timeout is cleared
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      startScheduler(2); // 2-minute interval, jitter = 0.5 * 2min = 1 min

      // Jitter timeout should be set
      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      // Restart scheduler before jitter fires (simulates settings change)
      // Reset jitter to 0 so second scheduler fires immediately
      vi.spyOn(Math, 'random').mockReturnValue(0);
      startScheduler(2);

      // Fire the immediate timeout (jitter = 0)
      await vi.advanceTimersByTimeAsync(0);

      // Only one traceroute from the second scheduler start
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);

      // Now advance past the first scheduler's jitter time (1 min) AND the interval (2 min)
      // If the old timeout leaked, it would create a second interval and we'd get extra calls
      manager.sendTraceroute.mockClear();
      manager.lastTracerouteSentTime = 0;
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      // Should have 1 call from the interval, not 2 (would be 2 if old timeout leaked and created extra interval)
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('should not leak intervals when scheduler is restarted multiple times', async () => {
      // Restart scheduler 5 times rapidly (simulates repeated settings changes)
      for (let i = 0; i < 5; i++) {
        startScheduler(1);
      }

      // With jitter=0, the timeout fires immediately
      await vi.advanceTimersByTimeAsync(0);

      // Only one traceroute should fire (from the last scheduler start)
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);

      // Reset and advance by exactly one interval
      manager.sendTraceroute.mockClear();
      manager.lastTracerouteSentTime = 0;
      await vi.advanceTimersByTimeAsync(60 * 1000);

      // Only one more traceroute should fire (from the single remaining interval)
      // If intervals leaked, we'd see up to 5 calls
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('should clear jitter timeout on disconnect', () => {
      // Use non-zero jitter to keep timeout pending
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      startScheduler(1);

      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      // Disconnect should clear the jitter timeout
      manager.disconnect();

      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).toBeNull();
    });
  });

  describe('Rate limiting', () => {
    it('should skip traceroute if less than 30 seconds since last send', async () => {
      // Set lastTracerouteSentTime to "now" in fake timer land
      // so the rate limit will trigger
      manager.lastTracerouteSentTime = Date.now();

      startScheduler(1);

      // Advance just past 0ms jitter but not past 30 seconds
      await vi.advanceTimersByTimeAsync(10);

      // The rate limit check should prevent the send
      expect(manager.sendTraceroute).not.toHaveBeenCalled();
    });

    it('should allow traceroute if more than 30 seconds since last send', async () => {
      // Set lastTracerouteSentTime to 60 seconds in the past
      manager.lastTracerouteSentTime = Date.now() - 60000;

      startScheduler(1);

      // Advance past 0ms jitter
      await vi.advanceTimersByTimeAsync(0);

      // Should have sent
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('should allow first traceroute when lastTracerouteSentTime is 0', async () => {
      manager.lastTracerouteSentTime = 0;

      startScheduler(1);

      // Advance past 0ms jitter
      await vi.advanceTimersByTimeAsync(0);

      // First traceroute should be allowed (lastTracerouteSentTime === 0 bypass)
      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scheduler disabled', () => {
    it('should not schedule anything when interval is 0', () => {
      startScheduler(0);

      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).toBeNull();
    });

    it('should clear existing timers when interval is set to 0', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      startScheduler(1);

      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      // Disable by setting to 0
      startScheduler(0);

      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).toBeNull();
    });
  });

  describe('Jitter timeout nullification', () => {
    it('should set tracerouteJitterTimeout to null after timeout fires', async () => {
      startScheduler(1);

      // With jitter=0, timeout fires on next tick
      expect(manager.tracerouteJitterTimeout).not.toBeNull();

      await vi.advanceTimersByTimeAsync(0);

      // After firing, jitter timeout should be nulled and interval set
      expect(manager.tracerouteJitterTimeout).toBeNull();
      expect(manager.tracerouteInterval).not.toBeNull();
    });
  });

  describe('TX-disabled skip (#4294 WP3)', () => {
    it('does not call sendTraceroute when TX is disabled, but keeps the interval running', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      manager.lastTracerouteSentTime = 0;

      startScheduler(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.sendTraceroute).not.toHaveBeenCalled();
      // The interval itself must still be armed so a later TX re-enable resumes.
      expect(manager.tracerouteInterval).not.toBeNull();
    });

    it('calls sendTraceroute once TX is re-enabled on a later tick', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      manager.lastTracerouteSentTime = 0;

      startScheduler(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.sendTraceroute).not.toHaveBeenCalled();

      // TX comes back on before the next tick.
      manager.actualDeviceConfig = { lora: { txEnabled: true } };
      manager.lastTracerouteSentTime = 0;
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('calls sendTraceroute normally when TX is enabled', async () => {
      manager.actualDeviceConfig = { lora: { txEnabled: true } };
      manager.lastTracerouteSentTime = 0;

      startScheduler(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.sendTraceroute).toHaveBeenCalledTimes(1);
    });

    it('does not log at error level across repeated ticks while TX is disabled', async () => {
      const { logger } = await import('../utils/logger.js');
      manager.actualDeviceConfig = { lora: { txEnabled: false } };
      manager.lastTracerouteSentTime = 0;

      startScheduler(1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(manager.sendTraceroute).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});

describe('MeshtasticManager — shared dispatch across sources', () => {
  type Manager = import('./meshtasticManager.js').MeshtasticManager;
  type State = {
    isConnected: boolean;
    actualDeviceConfig: { lora: { txEnabled: boolean } };
    localNodeInfo: { nodeNum: number; nodeId: string };
    transport: { send: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    startTracerouteScheduler: () => void;
    tracerouteIntervalMinutes: number;
  };
  let first: Manager;
  let second: Manager;
  let firstState: State;
  let secondState: State;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    const { MeshtasticManager } = await import('./meshtasticManager.js');
    first = new MeshtasticManager('source-a', { host: '127.0.0.1', port: 4403 });
    second = new MeshtasticManager('source-b', { host: '127.0.0.1', port: 4403 });
    firstState = first as unknown as State;
    secondState = second as unknown as State;
    for (const [state, nodeNum] of [[firstState, 1], [secondState, 2]] as const) {
      state.isConnected = true;
      state.localNodeInfo = { nodeNum, nodeId: `!${nodeNum}` };
      state.actualDeviceConfig = { lora: { txEnabled: true } };
      state.transport = { send: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn() };
    }
  });

  function completeActive() {
    const active = tracerouteRequestScheduler.getStatus().active;
    if (active) {
      tracerouteRequestScheduler.handleDataEvent({
        type: 'traceroute:complete', sourceId: active.sourceId, timestamp: Date.now(),
        data: { fromNodeNum: active.destination, toNodeNum: active.localNodeNum, channel: active.channel },
      });
    }
  }

  afterEach(async () => {
    tracerouteCampaignCoordinator.release('manager-test-campaign');
    completeActive();
    await vi.advanceTimersByTimeAsync(5_000);
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serializes real manager send paths, deduplicates and preserves source-scoped recording', async () => {
    await first.sendTraceroute(10, 0);
    const pending = second.sendTraceroute(20, 1, 'automation');
    const duplicate = second.sendTraceroute(20, 1, 'automation');
    expect(firstState.transport.send).toHaveBeenCalledTimes(1);
    expect(secondState.transport.send).not.toHaveBeenCalled();
    expect(tracerouteRequestScheduler.getStatus()).toMatchObject({
      active: { sourceId: 'source-a', priority: 'manual' },
      queue: [{ sourceId: 'source-b', priority: 'automation' }],
    });
    completeActive();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(secondState.transport.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([pending, duplicate]);
    expect(secondState.transport.send).toHaveBeenCalledTimes(1);
    expect(mockRecordTracerouteRequest).toHaveBeenCalledWith(1, 10, 'source-a');
    expect(mockRecordTracerouteRequest).toHaveBeenCalledWith(2, 20, 'source-b');
  });

  it('rechecks TX permission when a waiting trace reaches dispatch', async () => {
    await first.sendTraceroute(10);
    const pending = expect(second.sendTraceroute(20)).rejects.toMatchObject({ code: 'TX_DISABLED' });
    secondState.actualDeviceConfig.lora.txEnabled = false;
    completeActive();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(secondState.transport.send).not.toHaveBeenCalled();
    expect(tracerouteRequestScheduler.getStatus().active).toBeNull();
  });

  it('cancels queued work on disconnect without releasing another source or replaying it on reconnect', async () => {
    await first.sendTraceroute(10);
    const send = secondState.transport.send;
    const pending = expect(second.sendTraceroute(20)).rejects.toMatchObject({ code: 'TRACEROUTE_REQUEST_CANCELLED' });
    second.disconnect();
    await pending;
    expect(tracerouteRequestScheduler.getStatus().active?.sourceId).toBe('source-a');
    expect(tracerouteRequestScheduler.hasPendingForSource('source-b')).toBe(false);
    secondState.isConnected = true;
    completeActive();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not reset an active RF slot when automatic tracing is restarted or disabled', async () => {
    await first.sendTraceroute(10);
    const pending = second.sendTraceroute(20);
    firstState.tracerouteIntervalMinutes = 1;
    firstState.startTracerouteScheduler();
    firstState.tracerouteIntervalMinutes = 0;
    firstState.startTracerouteScheduler();
    await vi.advanceTimersByTimeAsync(74_999);
    expect(secondState.transport.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    await pending;
    expect(secondState.transport.send).toHaveBeenCalledTimes(1);
  });
  it('blocks ordinary requests on reserved sources while campaign requests use the shared scheduler', async () => {
    tracerouteCampaignCoordinator.reserve('manager-test-campaign', ['source-b']);
    await expect(second.sendTraceroute(20)).rejects.toMatchObject({ code: 'TRACEROUTE_CAMPAIGN_ACTIVE' });
    await expect(second.sendTraceroute(20, 0, 'automation')).rejects.toMatchObject({ code: 'TRACEROUTE_CAMPAIGN_ACTIVE' });
    await first.sendTraceroute(10);
    const onDispatch = vi.fn();
    const pending = second.sendCampaignTraceroute(20, 1, 'campaign', 10_000, () => true, { onDispatch });
    expect(onDispatch).not.toHaveBeenCalled();
    completeActive();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(secondState.transport.send).toHaveBeenCalledOnce();
    expect(tracerouteRequestScheduler.getStatus().active).toMatchObject({ sourceId: 'source-b', priority: 'campaign' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tracerouteRequestScheduler.getStatus().active).toBeNull();
  });

  it('rechecks campaign reservations for ordinary work queued before the campaign began', async () => {
    await first.sendTraceroute(10);
    const pending = expect(second.sendTraceroute(20)).rejects.toMatchObject({ code: 'TRACEROUTE_CAMPAIGN_ACTIVE' });
    tracerouteCampaignCoordinator.reserve('manager-test-campaign', ['source-b']);
    completeActive();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(secondState.transport.send).not.toHaveBeenCalled();
  });

  it('removes an aborted campaign from the queue without affecting the active source', async () => {
    await first.sendTraceroute(10);
    const controller = new AbortController();
    const pending = expect(second.sendCampaignTraceroute(20, 0, 'retry', 5_000, () => true, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'TRACEROUTE_REQUEST_CANCELLED' });
    controller.abort();
    await pending;
    expect(secondState.transport.send).not.toHaveBeenCalled();
    expect(tracerouteRequestScheduler.getStatus()).toMatchObject({ active: { sourceId: 'source-a' }, queue: [] });
  });

  it('does not transmit a campaign cancelled during its asynchronous dispatch check', async () => {
    const controller = new AbortController();
    let authorize!: () => void;
    const pending = expect(second.sendCampaignTraceroute(20, 0, 'campaign', 5_000, () => true, {
      signal: controller.signal,
      onDispatch: () => new Promise<void>(resolve => { authorize = resolve; }),
    })).rejects.toMatchObject({ code: 'TRACEROUTE_REQUEST_CANCELLED' });
    controller.abort();
    authorize();
    await pending;
    expect(secondState.transport.send).not.toHaveBeenCalled();
    expect(tracerouteRequestScheduler.getStatus().active).toBeNull();
  });

});
