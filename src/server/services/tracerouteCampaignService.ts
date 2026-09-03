import { randomUUID } from 'node:crypto';
import databaseService from '../../services/database.js';
import type { DbTraceroute } from '../../db/types.js';
import type {
  CreateTracerouteCampaignInput,
  TracerouteCampaign,
  TracerouteCampaignJob,
  TracerouteCampaignResult,
  TracerouteCampaignSource,
  TracerouteCampaignTargetInput,
} from '../../types/tracerouteCampaign.js';
import { logger } from '../../utils/logger.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';
import { resolveBroadcastChannel } from '../utils/resolveDestinationChannel.js';
import { tracerouteCampaignCoordinator } from './tracerouteCampaignCoordinator.js';

const MAX_TARGETS = 100;
const MAX_SOURCES = 20;
const MAX_RETAINED_CAMPAIGNS = 20;

interface CampaignManager extends ISourceManager {
  sendCampaignTraceroute(destination: number, channel?: number): Promise<void>;
}

interface CampaignSourceRecord {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

export interface TracerouteCampaignDependencies {
  now(): number;
  createId(): string;
  getSources(): Promise<CampaignSourceRecord[]>;
  getManager(sourceId: string): CampaignManager | undefined;
  getRecentTraceroutes(
    sourceId: string,
    localNodeNum: number,
    targetNodeNum: number,
    sinceTimestamp: number,
  ): Promise<DbTraceroute[]>;
  resolveChannel(manager: CampaignManager): Promise<number>;
  subscribe(listener: (event: DataEvent) => void): () => void;
  reserveSources(campaignId: string, sourceIds: string[]): void;
  releaseSources(campaignId: string): void;
}

export class TracerouteCampaignError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TracerouteCampaignError';
  }
}

export function hasTracerouteResponsePayload(trace: Partial<DbTraceroute>): boolean {
  return [trace.route, trace.routeBack, trace.snrTowards, trace.snrBack]
    .some((value) => value !== null && value !== undefined);
}

export function orderSourcesByRecentSuccess<T extends { selectedOrder: number; recentSuccessAt: number | null }>(
  sources: T[],
): T[] {
  return [...sources].sort((a, b) => {
    if (a.recentSuccessAt !== null && b.recentSuccessAt !== null) {
      return b.recentSuccessAt - a.recentSuccessAt || a.selectedOrder - b.selectedOrder;
    }
    if (a.recentSuccessAt !== null) return -1;
    if (b.recentSuccessAt !== null) return 1;
    return a.selectedOrder - b.selectedOrder;
  });
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseHopCount(route: unknown): number | null {
  if (typeof route !== 'string') return null;
  try {
    const parsed = JSON.parse(route);
    return Array.isArray(parsed) ? parsed.length + 1 : null;
  } catch {
    return null;
  }
}

function asResult(trace: Partial<DbTraceroute>): TracerouteCampaignResult {
  const route = asNullableString(trace.route);
  return {
    route,
    routeBack: asNullableString(trace.routeBack),
    snrTowards: asNullableString(trace.snrTowards),
    snrBack: asNullableString(trace.snrBack),
    timestamp: Number(trace.timestamp) || Date.now(),
    hopCount: parseHopCount(route),
  };
}

function cleanTarget(target: TracerouteCampaignTargetInput): TracerouteCampaignTargetInput {
  return {
    nodeNum: Number(target.nodeNum),
    ...(typeof target.nodeId === 'string' && target.nodeId.trim()
      ? { nodeId: target.nodeId.trim().slice(0, 32) }
      : {}),
    ...(typeof target.name === 'string' && target.name.trim()
      ? { name: target.name.trim().slice(0, 100) }
      : {}),
  };
}

function copyCampaign(campaign: TracerouteCampaign): TracerouteCampaign {
  return JSON.parse(JSON.stringify(campaign)) as TracerouteCampaign;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Traceroute request failed';
}

export class TracerouteCampaignService {
  private readonly campaigns = new Map<string, TracerouteCampaign>();
  private activeCampaignId: string | null = null;
  private creating = false;
  private cancelCurrentWait: (() => void) | null = null;

  constructor(private readonly deps: TracerouteCampaignDependencies) {}

  async create(input: CreateTracerouteCampaignInput, ownerId: number): Promise<TracerouteCampaign> {
    this.assertCanStart();
    this.creating = true;
    let reservedCampaignId: string | null = null;

    try {
      const config = this.validateInput(input);
      const sources = await this.resolveSources(config.sourceIds);
      const campaignId = this.deps.createId();
      this.reserveSources(campaignId, config.sourceIds);
      reservedCampaignId = campaignId;

      const cutoff = this.deps.now() - config.recentSuccessHours * 60 * 60 * 1000;
      const jobs: TracerouteCampaignJob[] = [];
      for (const target of config.targets) {
        const priorities = await Promise.all(sources.map(async (source, selectedOrder) => {
          const traces = await this.deps.getRecentTraceroutes(source.id, source.localNodeNum, target.nodeNum, cutoff);
          const recentSuccess = traces.find((trace) =>
            Number(trace.timestamp) >= cutoff && hasTracerouteResponsePayload(trace));
          return {
            source,
            selectedOrder,
            recentSuccessAt: recentSuccess ? Number(recentSuccess.timestamp) : null,
          };
        }));

        for (const priority of orderSourcesByRecentSuccess(priorities)) {
          jobs.push({
            id: this.deps.createId(),
            target,
            sourceId: priority.source.id,
            sourceName: priority.source.name,
            localNodeNum: priority.source.localNodeNum,
            order: jobs.length,
            recentSuccessAt: priority.recentSuccessAt,
            status: 'queued',
          });
        }
      }

      const campaign: TracerouteCampaign = {
        id: campaignId,
        ownerId,
        status: 'queued',
        createdAt: this.deps.now(),
        config,
        sources,
        jobs,
        progress: {
          total: jobs.length,
          completed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
      };

      this.launchReservedCampaign(campaign);
      reservedCampaignId = null;
      return copyCampaign(campaign);
    } finally {
      if (reservedCampaignId) this.deps.releaseSources(reservedCampaignId);
      this.creating = false;
    }
  }

  get(id: string, ownerId: number, isAdmin = false): TracerouteCampaign | null {
    const campaign = this.campaigns.get(id);
    if (!campaign || (!isAdmin && campaign.ownerId !== ownerId)) return null;
    return copyCampaign(campaign);
  }

  getActive(ownerId: number, isAdmin = false): TracerouteCampaign | null {
    if (!this.activeCampaignId) return null;
    return this.get(this.activeCampaignId, ownerId, isAdmin);
  }

  getLatest(ownerId: number, isAdmin = false): TracerouteCampaign | null {
    const campaigns = [...this.campaigns.values()].reverse();
    const campaign = campaigns.find((candidate) => isAdmin || candidate.ownerId === ownerId);
    return campaign ? copyCampaign(campaign) : null;
  }

  async retry(id: string, ownerId: number, isAdmin = false): Promise<TracerouteCampaign | null> {
    const original = this.campaigns.get(id);
    if (!original || (!isAdmin && original.ownerId !== ownerId)) return null;
    if (original.status !== 'completed' && original.status !== 'cancelled') {
      throw new TracerouteCampaignError(
        'The traceroute campaign is still running',
        409,
        'CAMPAIGN_NOT_FINISHED',
      );
    }

    const failedJobs = original.jobs.filter((job) => job.status === 'timeout' || job.status === 'error');
    if (failedJobs.length === 0) {
      throw new TracerouteCampaignError(
        'The traceroute campaign has no failed attempts to retry',
        400,
        'NO_FAILED_ATTEMPTS',
      );
    }

    this.assertCanStart();
    this.creating = true;
    let reservedCampaignId: string | null = null;

    try {
      const sourceIds = [...new Set(failedJobs.map((job) => job.sourceId))];
      const sources = await this.resolveSources(sourceIds);
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const campaignId = this.deps.createId();
      this.reserveSources(campaignId, sourceIds);
      reservedCampaignId = campaignId;

      const targets = [...new Map(failedJobs.map((job) => [
        job.target.nodeNum,
        cleanTarget(job.target),
      ] as const)).values()];
      const jobs: TracerouteCampaignJob[] = failedJobs.map((job, order) => {
        const source = sourceById.get(job.sourceId)!;
        return {
          id: this.deps.createId(),
          target: cleanTarget(job.target),
          sourceId: source.id,
          sourceName: source.name,
          localNodeNum: source.localNodeNum,
          order,
          recentSuccessAt: job.recentSuccessAt,
          status: 'queued',
        };
      });
      const campaign: TracerouteCampaign = {
        id: campaignId,
        retryOfCampaignId: original.id,
        ownerId,
        status: 'queued',
        createdAt: this.deps.now(),
        config: {
          ...original.config,
          targets,
          sourceIds,
        },
        sources,
        jobs,
        progress: {
          total: jobs.length,
          completed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
      };

      this.launchReservedCampaign(campaign);
      reservedCampaignId = null;
      return copyCampaign(campaign);
    } finally {
      if (reservedCampaignId) this.deps.releaseSources(reservedCampaignId);
      this.creating = false;
    }
  }

  cancel(id: string, ownerId: number, isAdmin = false): TracerouteCampaign | null {
    const campaign = this.campaigns.get(id);
    if (!campaign || (!isAdmin && campaign.ownerId !== ownerId)) return null;
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      return copyCampaign(campaign);
    }

    campaign.status = 'cancelled';
    const now = this.deps.now();
    for (const job of campaign.jobs) {
      if (job.status === 'queued') {
        job.status = 'cancelled';
        job.completedAt = now;
        job.error = 'Campaign cancelled';
      }
    }
    this.refreshProgress(campaign);
    this.cancelCurrentWait?.();
    return copyCampaign(campaign);
  }

  private assertCanStart(): void {
    if (this.creating || this.activeCampaignId !== null) {
      throw new TracerouteCampaignError(
        'Another traceroute campaign is already running',
        409,
        'CAMPAIGN_ALREADY_RUNNING',
      );
    }
  }

  private async resolveSources(sourceIds: string[]): Promise<TracerouteCampaignSource[]> {
    const sourceRows = await this.deps.getSources();
    const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
    return sourceIds.map((sourceId) => {
      const source = sourceById.get(sourceId);
      if (!source || !source.enabled || source.type !== 'meshtastic_tcp') {
        throw new TracerouteCampaignError(
          `Source ${sourceId} is not an enabled Meshtastic TCP source`,
          400,
          'INVALID_CAMPAIGN_SOURCE',
        );
      }

      const manager = this.deps.getManager(sourceId);
      const status = manager?.getStatus();
      const localNodeNum = manager?.getLocalNodeInfo()?.nodeNum;
      if (!manager || manager.sourceType !== 'meshtastic_tcp' || !status?.connected || !localNodeNum) {
        throw new TracerouteCampaignError(
          `Source ${source.name} is not connected or has no local node information`,
          409,
          'CAMPAIGN_SOURCE_UNAVAILABLE',
        );
      }
      return { id: source.id, name: source.name, localNodeNum };
    });
  }

  private reserveSources(campaignId: string, sourceIds: string[]): void {
    try {
      this.deps.reserveSources(campaignId, sourceIds);
    } catch (error) {
      throw new TracerouteCampaignError(
        errorMessage(error),
        409,
        'CAMPAIGN_SOURCE_BUSY',
      );
    }
  }

  private launchReservedCampaign(campaign: TracerouteCampaign): void {
    this.campaigns.set(campaign.id, campaign);
    this.activeCampaignId = campaign.id;
    this.pruneHistory();
    void this.run(campaign.id)
      .catch((error) => {
        logger.error(`Traceroute campaign ${campaign.id} failed unexpectedly:`, error);
        this.failCampaign(campaign, errorMessage(error));
      })
      .finally(() => this.deps.releaseSources(campaign.id));
  }

  private validateInput(input: CreateTracerouteCampaignInput): CreateTracerouteCampaignInput {
    if (!input || !Array.isArray(input.targets) || input.targets.length === 0) {
      throw new TracerouteCampaignError('Select at least one target node', 400, 'NO_CAMPAIGN_TARGETS');
    }
    if (input.targets.length > MAX_TARGETS) {
      throw new TracerouteCampaignError(`A campaign supports at most ${MAX_TARGETS} targets`, 400, 'TOO_MANY_TARGETS');
    }
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length === 0) {
      throw new TracerouteCampaignError('Select at least one source', 400, 'NO_CAMPAIGN_SOURCES');
    }
    if (input.sourceIds.length > MAX_SOURCES) {
      throw new TracerouteCampaignError(`A campaign supports at most ${MAX_SOURCES} sources`, 400, 'TOO_MANY_SOURCES');
    }

    const targets = [...new Map(input.targets.map((target) => {
      const clean = cleanTarget(target);
      return [clean.nodeNum, clean] as const;
    })).values()];
    if (targets.some((target) =>
      !Number.isInteger(target.nodeNum) || target.nodeNum <= 0 || target.nodeNum >= 0xffffffff)) {
      throw new TracerouteCampaignError('Every target must have a valid unicast node number', 400, 'INVALID_CAMPAIGN_TARGET');
    }

    const sourceIds = [...new Set(input.sourceIds.filter((id): id is string =>
      typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))];
    if (sourceIds.length === 0) {
      throw new TracerouteCampaignError('Select at least one source', 400, 'NO_CAMPAIGN_SOURCES');
    }
    if (input.behavior !== 'continue' && input.behavior !== 'stop-on-success') {
      throw new TracerouteCampaignError('Invalid campaign behavior', 400, 'INVALID_CAMPAIGN_BEHAVIOR');
    }

    const recentSuccessHours = Number(input.recentSuccessHours);
    const timeoutSeconds = Number(input.timeoutSeconds);
    const delaySeconds = Number(input.delaySeconds);
    if (!Number.isFinite(recentSuccessHours) || recentSuccessHours < 1 || recentSuccessHours > 720) {
      throw new TracerouteCampaignError('Recent-success window must be between 1 and 720 hours', 400, 'INVALID_RECENT_WINDOW');
    }
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 300) {
      throw new TracerouteCampaignError('Timeout must be between 5 and 300 seconds', 400, 'INVALID_CAMPAIGN_TIMEOUT');
    }
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > 300) {
      throw new TracerouteCampaignError('Delay must be between 0 and 300 seconds', 400, 'INVALID_CAMPAIGN_DELAY');
    }

    return {
      targets,
      sourceIds,
      behavior: input.behavior,
      recentSuccessHours,
      timeoutSeconds,
      delaySeconds,
    };
  }

  private async run(id: string): Promise<void> {
    const campaign = this.campaigns.get(id);
    if (!campaign) return;
    campaign.status = 'running';
    campaign.startedAt = this.deps.now();

    for (let index = 0; index < campaign.jobs.length; index += 1) {
      const job = campaign.jobs[index];
      if (String(campaign.status) === 'cancelled') break;

      const targetAlreadySucceeded = campaign.config.behavior === 'stop-on-success'
        && campaign.jobs.some((candidate) =>
          candidate.target.nodeNum === job.target.nodeNum && candidate.status === 'success');
      if (targetAlreadySucceeded) {
        this.finishJob(job, 'skipped', 'Skipped after the first successful source');
        this.refreshProgress(campaign);
        continue;
      }
      if (job.localNodeNum === job.target.nodeNum) {
        this.finishJob(job, 'skipped', 'Target is the source local node');
        this.refreshProgress(campaign);
        continue;
      }

      await this.runJob(campaign, job);
      this.refreshProgress(campaign);

      if (String(campaign.status) !== 'cancelled' && campaign.config.delaySeconds > 0) {
        const successfulTargets = new Set(campaign.jobs
          .filter((candidate) => candidate.status === 'success')
          .map((candidate) => candidate.target.nodeNum));
        const hasPendingAttempt = campaign.jobs.slice(index + 1).some((candidate) =>
          candidate.status === 'queued'
          && candidate.localNodeNum !== candidate.target.nodeNum
          && (campaign.config.behavior !== 'stop-on-success'
            || !successfulTargets.has(candidate.target.nodeNum)));
        if (hasPendingAttempt) {
          await this.waitForDelay(campaign.config.delaySeconds * 1000);
        }
      }
    }

    if (String(campaign.status) === 'cancelled') {
      const now = this.deps.now();
      for (const job of campaign.jobs) {
        if (job.status === 'queued' || job.status === 'running') {
          job.status = 'cancelled';
          job.completedAt = now;
          job.error = 'Campaign cancelled';
        }
      }
    } else {
      campaign.status = 'completed';
    }
    campaign.completedAt = this.deps.now();
    this.refreshProgress(campaign);
    if (this.activeCampaignId === campaign.id) this.activeCampaignId = null;
    this.cancelCurrentWait = null;
  }

  private async runJob(campaign: TracerouteCampaign, job: TracerouteCampaignJob): Promise<void> {
    const manager = this.deps.getManager(job.sourceId);
    if (!manager || manager.sourceType !== 'meshtastic_tcp' || !manager.getStatus().connected) {
      this.finishJob(job, 'error', 'Source disconnected before this attempt');
      return;
    }

    const localNodeNum = manager.getLocalNodeInfo()?.nodeNum;
    if (!localNodeNum) {
      this.finishJob(job, 'error', 'Local node information is unavailable');
      return;
    }

    job.status = 'running';
    job.startedAt = this.deps.now();
    const waiter = this.waitForTraceroute(
      job.sourceId,
      localNodeNum,
      job.target.nodeNum,
      campaign.config.timeoutSeconds * 1000,
    );
    this.cancelCurrentWait = waiter.cancel;

    try {
      const channel = await this.deps.resolveChannel(manager);
      if (String(campaign.status) === 'cancelled') {
        waiter.cancel();
        this.cancelCurrentWait = null;
        this.finishJob(job, 'cancelled', 'Campaign cancelled');
        return;
      }
      await manager.sendCampaignTraceroute(job.target.nodeNum, channel);
    } catch (error) {
      waiter.cancel();
      this.cancelCurrentWait = null;
      this.finishJob(job, campaign.status === 'cancelled' ? 'cancelled' : 'error', errorMessage(error));
      return;
    }

    const outcome = await waiter.promise;
    this.cancelCurrentWait = null;
    if (outcome.kind === 'success') {
      job.result = asResult(outcome.trace);
      this.finishJob(job, 'success');
    } else if (outcome.kind === 'cancelled') {
      this.finishJob(job, 'cancelled', 'Campaign cancelled');
    } else {
      this.finishJob(job, 'timeout', `No traceroute response within ${campaign.config.timeoutSeconds} seconds`);
    }
  }

  private waitForTraceroute(
    sourceId: string,
    localNodeNum: number,
    targetNodeNum: number,
    timeoutMs: number,
  ): {
    promise: Promise<{ kind: 'success'; trace: Partial<DbTraceroute> } | { kind: 'timeout' } | { kind: 'cancelled' }>;
    cancel: () => void;
  } {
    let finish: (result: { kind: 'success'; trace: Partial<DbTraceroute> } | { kind: 'timeout' } | { kind: 'cancelled' }) => void;
    let settled = false;
    let unsubscribe = () => {};
    let timeout: NodeJS.Timeout;
    const promise = new Promise<{ kind: 'success'; trace: Partial<DbTraceroute> } | { kind: 'timeout' } | { kind: 'cancelled' }>((resolve) => {
      finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(result);
      };
      unsubscribe = this.deps.subscribe((event) => {
        if (event.type !== 'traceroute:complete' || event.sourceId !== sourceId) return;
        const trace = event.data as Partial<DbTraceroute>;
        const from = Number(trace.fromNodeNum);
        const to = Number(trace.toNodeNum);
        const endpointsMatch =
          (from === localNodeNum && to === targetNodeNum)
          || (from === targetNodeNum && to === localNodeNum);
        if (endpointsMatch && hasTracerouteResponsePayload(trace)) {
          finish({ kind: 'success', trace });
        }
      });
      timeout = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    });
    return { promise, cancel: () => finish({ kind: 'cancelled' }) };
  }

  private waitForDelay(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cancelCurrentWait = null;
        resolve();
      }, delayMs);
      this.cancelCurrentWait = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.cancelCurrentWait = null;
        resolve();
      };
    });
  }

  private finishJob(
    job: TracerouteCampaignJob,
    status: TracerouteCampaignJob['status'],
    error?: string,
  ): void {
    job.status = status;
    job.completedAt = this.deps.now();
    if (error) job.error = error;
  }

  private refreshProgress(campaign: TracerouteCampaign): void {
    const terminal = new Set(['success', 'timeout', 'error', 'skipped', 'cancelled']);
    campaign.progress = {
      total: campaign.jobs.length,
      completed: campaign.jobs.filter((job) => terminal.has(job.status)).length,
      successful: campaign.jobs.filter((job) => job.status === 'success').length,
      failed: campaign.jobs.filter((job) => job.status === 'timeout' || job.status === 'error').length,
      skipped: campaign.jobs.filter((job) => job.status === 'skipped' || job.status === 'cancelled').length,
    };
  }

  private failCampaign(campaign: TracerouteCampaign, message: string): void {
    const now = this.deps.now();
    campaign.status = 'completed';
    campaign.completedAt = now;
    for (const job of campaign.jobs) {
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'error';
        job.error = message;
        job.completedAt = now;
      }
    }
    this.refreshProgress(campaign);
    if (this.activeCampaignId === campaign.id) this.activeCampaignId = null;
    this.cancelCurrentWait?.();
    this.cancelCurrentWait = null;
  }

  private pruneHistory(): void {
    if (this.campaigns.size <= MAX_RETAINED_CAMPAIGNS) return;
    for (const [id, campaign] of this.campaigns) {
      if (this.campaigns.size <= MAX_RETAINED_CAMPAIGNS) break;
      if (id !== this.activeCampaignId && campaign.status !== 'queued' && campaign.status !== 'running') {
        this.campaigns.delete(id);
      }
    }
  }
}

const defaultDependencies: TracerouteCampaignDependencies = {
  now: () => Date.now(),
  createId: () => randomUUID(),
  getSources: () => databaseService.sources.getAllSources(),
  getManager: (sourceId) => {
    const manager = sourceManagerRegistry.getManager(sourceId);
    return manager && isMeshtasticManager(manager) ? manager : undefined;
  },
  getRecentTraceroutes: async (sourceId, localNodeNum, targetNodeNum, sinceTimestamp) => {
    const trace = await databaseService.traceroutes.getLatestSuccessfulTracerouteByNodes(
      localNodeNum,
      targetNodeNum,
      sinceTimestamp,
      sourceId,
    );
    return trace ? [trace] : [];
  },
  resolveChannel: (manager) => resolveBroadcastChannel(manager, databaseService),
  subscribe: (listener) => {
    dataEventEmitter.on('data', listener);
    return () => dataEventEmitter.off('data', listener);
  },
  reserveSources: (campaignId, sourceIds) => tracerouteCampaignCoordinator.reserve(campaignId, sourceIds),
  releaseSources: (campaignId) => tracerouteCampaignCoordinator.release(campaignId),
};

export const tracerouteCampaignService = new TracerouteCampaignService(defaultDependencies);
