import { logger } from '../../utils/logger.js';
import { MIN_TRACEROUTE_INTERVAL_MS } from '../constants/meshtastic.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';

export type TraceroutePriority = 'manual' | 'campaign' | 'automatic' | 'retry';

export interface TracerouteScheduleOptions {
  priority?: TraceroutePriority;
  /**
   * Sources in the same RF domain are serialized. Until per-source RF-domain
   * configuration is exposed in the UI, every Meshtastic source intentionally
   * falls back to the same conservative domain.
   */
  rfDomain?: string;
  /** How long the RF-domain lock is held while waiting for a response. */
  timeoutMs?: number;
  /**
   * Optional owner used by higher-level jobs (for example a campaign) so work
   * that has not transmitted yet can be removed when that owner is cancelled.
   */
  ownerKey?: string;
}

export interface EnqueueTracerouteRequest extends TracerouteScheduleOptions {
  sourceId: string;
  localNodeNum: number;
  destination: number;
  channel: number;
  send: () => Promise<void>;
}

interface ScheduledTraceroute {
  id: number;
  sourceId: string;
  localNodeNum: number;
  destination: number;
  channel: number;
  priority: TraceroutePriority;
  rfDomain: string;
  timeoutMs: number;
  ownerKey?: string;
  enqueuedAt: number;
  dispatchedAt?: number;
  timeoutHandle?: NodeJS.Timeout;
  finished: boolean;
  dispatchPromise: Promise<void>;
  resolveDispatch: () => void;
  rejectDispatch: (error: unknown) => void;
  send: () => Promise<void>;
}

export interface TracerouteSchedulerSnapshotJob {
  sourceId: string;
  localNodeNum: number;
  destination: number;
  channel: number;
  priority: TraceroutePriority;
  rfDomain: string;
  ownerKey?: string;
  enqueuedAt: number;
  dispatchedAt?: number;
}

export interface TracerouteSchedulerSnapshotDomain {
  rfDomain: string;
  active: TracerouteSchedulerSnapshotJob | null;
  queue: TracerouteSchedulerSnapshotJob[];
}

const DEFAULT_RF_DOMAIN = 'meshtastic';
const DEFAULT_RESPONSE_TIMEOUT_MS = 75_000;
const DOMAIN_COOLDOWN_MS = 5_000;

const PRIORITY_WEIGHT: Record<TraceroutePriority, number> = {
  manual: 400,
  campaign: 300,
  automatic: 200,
  retry: 100,
};

function asSnapshotJob(job: ScheduledTraceroute): TracerouteSchedulerSnapshotJob {
  return {
    sourceId: job.sourceId,
    localNodeNum: job.localNodeNum,
    destination: job.destination,
    channel: job.channel,
    priority: job.priority,
    rfDomain: job.rfDomain,
    ownerKey: job.ownerKey,
    enqueuedAt: job.enqueuedAt,
    dispatchedAt: job.dispatchedAt,
  };
}

/**
 * Global traceroute arbiter.
 *
 * It intentionally serializes all Meshtastic traceroutes by RF domain rather
 * than by TCP source. Multiple TCP gateways can hear the same RF mesh and can
 * therefore collide even when they are independent connections.
 *
 * enqueue() resolves when the request is actually transmitted. The RF-domain
 * lock remains held until a matching traceroute:complete event arrives or the
 * response timeout expires, so existing APIs keep their "request sent" promise
 * semantics while subsequent requests cannot overlap the in-flight trace.
 */
export class TracerouteSchedulerService {
  private nextId = 1;
  private readonly queues = new Map<string, ScheduledTraceroute[]>();
  private readonly activeByDomain = new Map<string, ScheduledTraceroute>();
  private readonly jobsByKey = new Map<string, ScheduledTraceroute>();
  private readonly lastDispatchBySource = new Map<string, number>();
  private readonly domainAvailableAt = new Map<string, number>();
  private readonly wakeTimers = new Map<string, { timer: NodeJS.Timeout; dueAt: number }>();
  private disposed = false;

  constructor() {
    dataEventEmitter.on('data', this.handleDataEvent);
  }

  enqueue(request: EnqueueTracerouteRequest): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Traceroute scheduler is disposed'));
    }
    if (!request.sourceId) {
      return Promise.reject(new Error('Traceroute sourceId is required'));
    }
    if (!Number.isInteger(request.localNodeNum) || request.localNodeNum <= 0) {
      return Promise.reject(new Error('Traceroute local node number is invalid'));
    }
    if (!Number.isInteger(request.destination) || request.destination <= 0 || request.destination >= 0xffffffff) {
      return Promise.reject(new Error('Traceroute destination is invalid'));
    }

    const rfDomain = request.rfDomain?.trim() || DEFAULT_RF_DOMAIN;
    const priority = request.priority ?? 'manual';
    const timeoutMs = Number.isFinite(request.timeoutMs)
      ? Math.max(5_000, Math.min(300_000, Number(request.timeoutMs)))
      : DEFAULT_RESPONSE_TIMEOUT_MS;
    const key = this.jobKey(rfDomain, request.sourceId, request.localNodeNum, request.destination);
    const duplicate = this.jobsByKey.get(key);
    if (duplicate) {
      // A manual request that joins an owned queued job makes that job shared,
      // so cancelling the original campaign must not discard the manual request.
      if (!request.ownerKey) duplicate.ownerKey = undefined;
      if (PRIORITY_WEIGHT[priority] > PRIORITY_WEIGHT[duplicate.priority]) {
        duplicate.priority = priority;
        this.sortQueue(duplicate.rfDomain);
      }
      logger.debug(
        `🧭 Traceroute scheduler: deduplicated ${request.sourceId} -> !${request.destination.toString(16).padStart(8, '0')} (${rfDomain})`,
      );
      return duplicate.dispatchPromise;
    }

    let resolveDispatch!: () => void;
    let rejectDispatch!: (error: unknown) => void;
    const dispatchPromise = new Promise<void>((resolve, reject) => {
      resolveDispatch = resolve;
      rejectDispatch = reject;
    });

    const job: ScheduledTraceroute = {
      id: this.nextId++,
      sourceId: request.sourceId,
      localNodeNum: request.localNodeNum,
      destination: request.destination,
      channel: request.channel,
      priority,
      rfDomain,
      timeoutMs,
      ownerKey: request.ownerKey,
      enqueuedAt: Date.now(),
      finished: false,
      dispatchPromise,
      resolveDispatch,
      rejectDispatch,
      send: request.send,
    };

    const queue = this.queues.get(rfDomain) ?? [];
    queue.push(job);
    this.queues.set(rfDomain, queue);
    this.jobsByKey.set(key, job);
    this.sortQueue(rfDomain);

    logger.debug(
      `🧭 Traceroute scheduler: queued ${request.sourceId} -> !${request.destination.toString(16).padStart(8, '0')} priority=${priority} domain=${rfDomain}`,
    );

    void this.drain(rfDomain);
    return dispatchPromise;
  }

  /**
   * Remove work owned by a cancelled higher-level operation if it has not yet
   * transmitted. An already-active RF packet cannot be unsent and therefore
   * keeps its lock until response/timeout.
   */
  cancelQueuedByOwner(ownerKey: string): number {
    let cancelled = 0;
    for (const [rfDomain, queue] of this.queues) {
      const keep: ScheduledTraceroute[] = [];
      for (const job of queue) {
        if (job.ownerKey === ownerKey) {
          cancelled += 1;
          job.finished = true;
          this.jobsByKey.delete(this.jobKey(job.rfDomain, job.sourceId, job.localNodeNum, job.destination));
          job.rejectDispatch(new TracerouteScheduleCancelledError(ownerKey));
        } else {
          keep.push(job);
        }
      }
      this.queues.set(rfDomain, keep);
      void this.drain(rfDomain);
    }
    return cancelled;
  }

  getSnapshot(): TracerouteSchedulerSnapshotDomain[] {
    const domains = new Set<string>([
      ...this.queues.keys(),
      ...this.activeByDomain.keys(),
    ]);
    return [...domains].sort().map((rfDomain) => ({
      rfDomain,
      active: this.activeByDomain.has(rfDomain)
        ? asSnapshotJob(this.activeByDomain.get(rfDomain)!)
        : null,
      queue: (this.queues.get(rfDomain) ?? []).map(asSnapshotJob),
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    dataEventEmitter.off('data', this.handleDataEvent);
    for (const { timer } of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    for (const active of this.activeByDomain.values()) {
      if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
    }
  }

  private readonly handleDataEvent = (event: DataEvent): void => {
    if (event.type !== 'traceroute:complete' || !event.sourceId) return;
    const trace = event.data as { fromNodeNum?: unknown; toNodeNum?: unknown };
    const from = Number(trace.fromNodeNum);
    const to = Number(trace.toNodeNum);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;

    for (const active of this.activeByDomain.values()) {
      if (active.sourceId !== event.sourceId || active.dispatchedAt === undefined) continue;
      const endpointsMatch =
        (from === active.localNodeNum && to === active.destination)
        || (from === active.destination && to === active.localNodeNum);
      if (!endpointsMatch) continue;

      this.finishActive(active, 'response');
      return;
    }
  };

  private sortQueue(rfDomain: string): void {
    const queue = this.queues.get(rfDomain);
    if (!queue) return;
    queue.sort((a, b) =>
      PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]
      || a.id - b.id);
  }

  private async drain(rfDomain: string): Promise<void> {
    if (this.disposed || this.activeByDomain.has(rfDomain)) return;

    const queue = this.queues.get(rfDomain);
    if (!queue || queue.length === 0) return;

    const now = Date.now();
    const domainReadyAt = this.domainAvailableAt.get(rfDomain) ?? 0;
    if (domainReadyAt > now) {
      this.armWake(rfDomain, domainReadyAt);
      return;
    }

    let eligibleIndex = -1;
    let earliestSourceReadyAt = Number.POSITIVE_INFINITY;
    for (let index = 0; index < queue.length; index += 1) {
      const job = queue[index];
      const lastDispatch = this.lastDispatchBySource.get(job.sourceId);
      const sourceReadyAt = lastDispatch === undefined
        ? now
        : lastDispatch + MIN_TRACEROUTE_INTERVAL_MS;
      if (sourceReadyAt <= now) {
        eligibleIndex = index;
        break;
      }
      earliestSourceReadyAt = Math.min(earliestSourceReadyAt, sourceReadyAt);
    }

    if (eligibleIndex < 0) {
      if (Number.isFinite(earliestSourceReadyAt)) this.armWake(rfDomain, earliestSourceReadyAt);
      return;
    }

    this.clearWake(rfDomain);
    const [job] = queue.splice(eligibleIndex, 1);
    this.activeByDomain.set(rfDomain, job);

    try {
      await job.send();
      if (job.finished) return;

      job.dispatchedAt = Date.now();
      this.lastDispatchBySource.set(job.sourceId, job.dispatchedAt);
      job.resolveDispatch();

      logger.debug(
        `🧭 Traceroute scheduler: dispatched ${job.sourceId} -> !${job.destination.toString(16).padStart(8, '0')} domain=${rfDomain}`,
      );

      if (job.finished) return;
      job.timeoutHandle = setTimeout(() => {
        logger.warn(
          `🧭 Traceroute scheduler: response timeout for ${job.sourceId} -> !${job.destination.toString(16).padStart(8, '0')} domain=${rfDomain}`,
        );
        this.finishActive(job, 'timeout');
      }, job.timeoutMs);
    } catch (error) {
      job.rejectDispatch(error);
      this.finishActive(job, 'send-error');
    }
  }

  private finishActive(job: ScheduledTraceroute, reason: 'response' | 'timeout' | 'send-error'): void {
    if (job.finished) return;
    const active = this.activeByDomain.get(job.rfDomain);
    if (!active || active.id !== job.id) return;

    job.finished = true;
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    this.activeByDomain.delete(job.rfDomain);
    this.jobsByKey.delete(this.jobKey(job.rfDomain, job.sourceId, job.localNodeNum, job.destination));

    if (reason !== 'send-error') {
      this.domainAvailableAt.set(job.rfDomain, Date.now() + DOMAIN_COOLDOWN_MS);
    }

    logger.debug(
      `🧭 Traceroute scheduler: released ${job.rfDomain} after ${reason} (${job.sourceId} -> !${job.destination.toString(16).padStart(8, '0')})`,
    );

    void this.drain(job.rfDomain);
  }

  private armWake(rfDomain: string, dueAt: number): void {
    const existing = this.wakeTimers.get(rfDomain);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.wakeTimers.delete(rfDomain);
      void this.drain(rfDomain);
    }, Math.max(1, dueAt - Date.now()));
    this.wakeTimers.set(rfDomain, { timer, dueAt });
  }

  private clearWake(rfDomain: string): void {
    const existing = this.wakeTimers.get(rfDomain);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.wakeTimers.delete(rfDomain);
  }

  private jobKey(rfDomain: string, sourceId: string, localNodeNum: number, destination: number): string {
    return `${rfDomain}:${sourceId}:${localNodeNum}:${destination}`;
  }
}

export class TracerouteScheduleCancelledError extends Error {
  readonly code = 'TRACEROUTE_SCHEDULE_CANCELLED';

  constructor(public readonly ownerKey: string) {
    super(`Queued traceroute cancelled for owner ${ownerKey}`);
    this.name = 'TracerouteScheduleCancelledError';
  }
}

export const tracerouteSchedulerService = new TracerouteSchedulerService();
