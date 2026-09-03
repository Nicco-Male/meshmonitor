export type TracerouteCampaignBehavior = 'continue' | 'stop-on-success';

export type TracerouteCampaignStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled';

export type TracerouteCampaignJobStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'timeout'
  | 'error'
  | 'skipped'
  | 'cancelled';

export interface TracerouteCampaignTargetInput {
  nodeNum: number;
  nodeId?: string;
  name?: string;
}

export interface CreateTracerouteCampaignInput {
  targets: TracerouteCampaignTargetInput[];
  sourceIds: string[];
  recentSuccessHours: number;
  behavior: TracerouteCampaignBehavior;
  timeoutSeconds: number;
  delaySeconds: number;
}

export interface TracerouteCampaignSource {
  id: string;
  name: string;
  localNodeNum: number;
}

export interface TracerouteCampaignResult {
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  timestamp: number;
  hopCount: number | null;
}

export interface TracerouteCampaignJob {
  id: string;
  target: TracerouteCampaignTargetInput;
  sourceId: string;
  sourceName: string;
  localNodeNum: number;
  order: number;
  recentSuccessAt: number | null;
  status: TracerouteCampaignJobStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: TracerouteCampaignResult;
}

export interface TracerouteCampaign {
  id: string;
  retryOfCampaignId?: string;
  ownerId: number;
  status: TracerouteCampaignStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  config: CreateTracerouteCampaignInput;
  sources: TracerouteCampaignSource[];
  jobs: TracerouteCampaignJob[];
  progress: {
    total: number;
    completed: number;
    successful: number;
    failed: number;
    skipped: number;
  };
}
