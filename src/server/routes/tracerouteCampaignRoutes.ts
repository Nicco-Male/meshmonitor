import { Router, type Request, type Response } from 'express';
import type { User } from '../../types/auth.js';
import type { TracerouteCampaign } from '../../types/tracerouteCampaign.js';
import { logger } from '../../utils/logger.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import {
  canAccessCampaignSource,
  tracerouteCampaignService,
  TracerouteCampaignError,
  validateTracerouteCampaignInput,
} from '../services/tracerouteCampaignService.js';

const router = Router();
router.use(requireAuth());

// Ownership alone does not grant access to a source or to historical results
// after a channel grant is revoked. Check both initial and attempted channels.
async function authorizeCampaign(user: User, campaign: TracerouteCampaign, action: 'read' | 'write'): Promise<void> {
  const channels = new Map<string, Set<number>>();
  for (const source of campaign.sources) channels.set(source.id, new Set([source.channel]));
  for (const job of campaign.jobs) {
    if (job.channel !== undefined) channels.get(job.sourceId)?.add(job.channel);
  }
  for (const [sourceId, sourceChannels] of channels) {
    for (const channel of sourceChannels) {
      if (!await canAccessCampaignSource(user, sourceId, action, channel)) {
        throw new TracerouteCampaignError('Insufficient campaign source or channel permission', 403, 'FORBIDDEN');
      }
    }
  }
}

function handleError(res: Response, error: unknown): Response {
  if (error instanceof TracerouteCampaignError) return fail(res, error.status, error.code, error.message);
  logger.error('Traceroute campaign request failed:', error);
  return fail(res, 500, 'CAMPAIGN_REQUEST_FAILED', 'Failed to process traceroute campaign');
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const input = validateTracerouteCampaignInput(req.body);
    for (const sourceId of input.sourceIds) {
      if (!await canAccessCampaignSource(user, sourceId, 'write')) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient traceroute permission for a selected source');
      }
    }
    // The service also checks the resolved channel and rechecks permission
    // before each attempt, including work queued after this HTTP request ends.
    return ok(res.status(202), await tracerouteCampaignService.create(input, user.id));
  } catch (error) {
    return handleError(res, error);
  }
});

for (const selector of ['active', 'latest'] as const) {
  router.get(`/${selector}`, async (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const campaign = selector === 'active'
        ? tracerouteCampaignService.getActive(user.id, user.isAdmin)
        : tracerouteCampaignService.getLatest(user.id, user.isAdmin);
      if (campaign) await authorizeCampaign(user, campaign, 'read');
      return ok(res, { campaign });
    } catch (error) {
      return handleError(res, error);
    }
  });
}

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const campaign = tracerouteCampaignService.get(req.params.id, user.id, user.isAdmin);
    if (!campaign) return fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Traceroute campaign not found');
    await authorizeCampaign(user, campaign, 'read');
    return ok(res, campaign);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const original = tracerouteCampaignService.get(req.params.id, user.id, user.isAdmin);
    if (!original) return fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Traceroute campaign not found');
    await authorizeCampaign(user, original, 'read');
    // Only failed attempts are recreated. Their current write/channel grants
    // are checked by the service when resolving the retry's source set.
    const campaign = await tracerouteCampaignService.retry(original.id, user.id, user.isAdmin);
    return ok(res.status(202), campaign);
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const original = tracerouteCampaignService.get(req.params.id, user.id, user.isAdmin);
    if (!original) return fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Traceroute campaign not found');
    await authorizeCampaign(user, original, 'write');
    return ok(res, tracerouteCampaignService.cancel(original.id, user.id, user.isAdmin));
  } catch (error) {
    return handleError(res, error);
  }
});

export default router;
