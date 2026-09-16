import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { logger } from '../../utils/logger.js';

export type TracerouteRequestPriority =
  | 'manual'
  | 'campaign'
  | 'automation'
  | 'automatic'
  | 'retry';

const PRIORITY_RANK: Record<TracerouteRequestPriority, number> = {
  manual: 0,
  campaign: 10,
  automation: 20,
  automatic: 30,
  retry: 40,
};

export interface TracerouteSchedulerRequest {
  sourceId: string;
  localNodeNum: number;
  destination: number;
  channel: number;
  priority?: TracerouteRequestPriority;
  timeoutMs?: number;
  send: () => Promise<void>;
  shouldDispatch?: () => boolean;
  signal?: AbortSignal;
}

interface PendingTraceroute extends TracerouteSchedulerRequest {
  id: number;
  priority: TracerouteRequestPriority;
  enqueuedAt: number;
  dispatchPromise: Promise<void>;
  resolveDispatch: () => void;
  rejectDispatch: (error: unknown) => void;
}

export interface TracerouteSchedulerStatusEntry {
  sourceId: string;
  localNodeNum: number;
  destination: number;
  channel: number;
  priority: TracerouteRequestPriority;
  enqueuedAt: number;
  startedAt?: number;
}

export interface TracerouteSchedulerStatus {
  maxActive: 1;
  cooldownMs: number;
  active: TracerouteSchedulerStatusEntry | null;
  queue: TracerouteSchedulerStatusEntry[];
}

export class TracerouteRequestCancelledError extends Error {
  readonly code = 'TRACEROUTE_REQUEST_CANCELLED';

  constructor() {
    super('Traceroute request cancelled before dispatch');
    this.name = 'TracerouteRequestCancelledError';
  }
}

/**
 * Global Meshtastic traceroute arbiter.
 *
 * MeshMonitor can have many TCP sources attached to the same RF mesh. Source-local
 * rate limits are not enough in that setup: two radios can inject traceroutes at
 * the same time and collide on a shared relay. This scheduler therefore allows
 * exactly one in-flight Meshtastic traceroute across all sources. The slot is held
 * until a matching traceroute:complete event arrives or the request times out,
 * then a short RF cooldown is applied before dispatching the next queued request.
 */
export class TracerouteRequestScheduler {
  private readonly queue: PendingTraceroute[] = [];
  private active: (PendingTraceroute & { startedAt: number }) | null = null;
  private activeTimeout: NodeJS.Timeout | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private nextId = 1;

  constructor(
    private readonly cooldownMs = 5_000,
    private readonly defaultTimeoutMs = 75_000,
  ) {}

  enqueue(request: TracerouteSchedulerRequest): Promise<void> {
    if (request.signal?.aborted) return Promise.reject(new TracerouteRequestCancelledError());
    const priority = request.priority ?? 'manual';
    const existing = this.findDuplicate(request);
    if (existing) {
      logger.debug(
        `[TraceScheduler] deduplicated ${request.sourceId} -> ${request.destination} ch${request.channel} (${priority})`,
      );
      return existing.dispatchPromise;
    }

    let resolveDispatch!: () => void;
    let rejectDispatch!: (error: unknown) => void;
    const dispatchPromise = new Promise<void>((resolve, reject) => {
      resolveDispatch = resolve;
      rejectDispatch = reject;
    });

    const job: PendingTraceroute = {
      ...request,
      id: this.nextId++,
      priority,
      enqueuedAt: Date.now(),
      dispatchPromise,
      resolveDispatch,
      rejectDispatch,
    };
    this.queue.push(job);
    this.sortQueue();

    // Cancelling a campaign removes only its unsent job, never a different
    // caller's duplicate or an already transmitted request's RF reservation.
    const onAbort = () => {
      const index = this.queue.findIndex(candidate => candidate.id === job.id);
      if (index >= 0) {
        this.queue.splice(index, 1);
        job.rejectDispatch(new TracerouteRequestCancelledError());
      }
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => request.signal?.removeEventListener('abort', onAbort);
    void dispatchPromise.then(detach, detach);

    logger.debug(
      `[TraceScheduler] queued #${job.id} ${job.sourceId} -> ${job.destination} ch${job.channel} (${job.priority}); depth=${this.queue.length}`,
    );
    void this.pump();
    return dispatchPromise;
  }

  hasPendingForSource(sourceId: string): boolean {
    return this.active?.sourceId === sourceId
      || this.queue.some((job) => job.sourceId === sourceId);
  }

  /** Drop unsent work on disconnect; an already transmitted trace still owns RF. */
  cancelPendingForSource(sourceId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].sourceId === sourceId) {
        const [job] = this.queue.splice(i, 1);
        job.rejectDispatch(new TracerouteRequestCancelledError());
      }
    }
  }

  getStatus(sourceId?: string): TracerouteSchedulerStatus {
    const toStatus = (job: PendingTraceroute & { startedAt?: number }): TracerouteSchedulerStatusEntry => ({
      sourceId: job.sourceId,
      localNodeNum: job.localNodeNum,
      destination: job.destination,
      channel: job.channel,
      priority: job.priority,
      enqueuedAt: job.enqueuedAt,
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    });
    return {
      maxActive: 1,
      cooldownMs: this.cooldownMs,
      active: this.active && (sourceId === undefined || this.active.sourceId === sourceId)
        ? toStatus(this.active) : null,
      queue: this.queue.filter(job => sourceId === undefined || job.sourceId === sourceId).map(toStatus),
    };
  }

  handleDataEvent(event: DataEvent): void {
    if (event.type !== 'traceroute:complete' || !this.active) return;
    // All upstream completion emitters identify their source. An unscoped or
    // other-source observation must not release another radio's active slot.
    if (event.sourceId !== this.active.sourceId) return;

    const trace = event.data as { fromNodeNum?: number; toNodeNum?: number; channel?: number | null };
    if (!trace || (trace.channel != null && trace.channel !== this.active.channel)) return;
    const from = Number(trace.fromNodeNum);
    const to = Number(trace.toNodeNum);
    const matches =
      (from === this.active.localNodeNum && to === this.active.destination)
      || (from === this.active.destination && to === this.active.localNodeNum);
    if (!matches) return;

    this.releaseActive('complete', true);
  }

  private findDuplicate(request: TracerouteSchedulerRequest): PendingTraceroute | null {
    const matches = (job: PendingTraceroute) =>
      job.sourceId === request.sourceId
      && job.localNodeNum === request.localNodeNum
      && job.signal === request.signal
      && job.destination === request.destination
      && job.channel === request.channel;
    if (this.active && matches(this.active)) return this.active;
    return this.queue.find(matches) ?? null;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      || a.enqueuedAt - b.enqueuedAt
      || a.id - b.id);
  }

  private async pump(): Promise<void> {
    if (this.active || this.cooldownTimer || this.dispatching) return;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        if (job.signal?.aborted || (job.shouldDispatch && !job.shouldDispatch())) {
          throw new TracerouteRequestCancelledError();
        }
      } catch (error) {
        job.rejectDispatch(error);
        continue;
      }

      this.active = { ...job, startedAt: Date.now() };
      this.dispatching = true;
      logger.debug(
        `[TraceScheduler] dispatch #${job.id} ${job.sourceId} -> ${job.destination} (${job.priority}); remaining=${this.queue.length}`,
      );

      try {
        await job.send();
        job.resolveDispatch();

        if (!this.active || this.active.id !== job.id) return;

        const timeoutMs = Number.isFinite(job.timeoutMs) && Number(job.timeoutMs) > 0
          ? Number(job.timeoutMs)
          : this.defaultTimeoutMs;
        this.activeTimeout = setTimeout(() => {
          if (this.active?.id === job.id) this.releaseActive('timeout', true);
        }, timeoutMs);
      } catch (error) {
        job.rejectDispatch(error);
        if (this.active?.id === job.id) this.releaseActive('send-error', false);
      } finally {
        // A fast completion can arrive while send() is still awaiting local
        // persistence. Never overlap the two send callbacks in that case.
        this.dispatching = false;
        void this.pump();
      }
      return;
    }
  }

  private releaseActive(reason: 'complete' | 'timeout' | 'send-error', cooldown: boolean): void {
    if (!this.active) return;
    const finished = this.active;
    this.active = null;

    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }

    logger.debug(
      `[TraceScheduler] release #${finished.id} ${finished.sourceId} -> ${finished.destination}: ${reason}`,
    );

    if (cooldown && this.cooldownMs > 0) {
      this.cooldownTimer = setTimeout(() => {
        this.cooldownTimer = null;
        void this.pump();
      }, this.cooldownMs);
    } else {
      void this.pump();
    }
  }
}

export const tracerouteRequestScheduler = new TracerouteRequestScheduler();

dataEventEmitter.on('data', (event: DataEvent) => {
  tracerouteRequestScheduler.handleDataEvent(event);
});
