import { Router, type Request, type Response } from 'express';
import type { User } from '../../types/auth.js';
import type { CreateTracerouteCampaignInput } from '../../types/tracerouteCampaign.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { hasPermission, optionalAuth } from '../auth/authMiddleware.js';
import {
  tracerouteCampaignService,
  TracerouteCampaignError,
} from '../services/tracerouteCampaignService.js';

const router = Router();
router.use(optionalAuth());

async function resolveCampaignUser(req: Request): Promise<User | undefined> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const user = await databaseService.validateApiTokenAsync(header.slice(7));
    if (user?.isActive) return user;
  }
  return req.user;
}

async function requireCampaignUser(req: Request, res: Response): Promise<User | null> {
  const user = await resolveCampaignUser(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
    return null;
  }
  return user;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const user = await requireCampaignUser(req, res);
    if (!user) return;

    const input = req.body as CreateTracerouteCampaignInput;
    const sourceIds = Array.isArray(input?.sourceIds)
      ? [...new Set(input.sourceIds.filter((id): id is string => typeof id === 'string'))]
      : [];
    for (const sourceId of sourceIds) {
      if (!await hasPermission(user, 'traceroute', 'write', sourceId)) {
        return res.status(403).json({
          error: `Insufficient traceroute permission for source ${sourceId}`,
          code: 'FORBIDDEN',
          required: { resource: 'traceroute', action: 'write', sourceId },
        });
      }
    }

    const campaign = await tracerouteCampaignService.create(input, user.id);
    return res.status(202).json(campaign);
  } catch (error) {
    if (error instanceof TracerouteCampaignError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error('Error starting traceroute campaign:', error);
    return res.status(500).json({ error: 'Failed to start traceroute campaign' });
  }
});

router.get('/active', async (req: Request, res: Response) => {
  try {
    const user = await requireCampaignUser(req, res);
    if (!user) return;
    return res.json({ campaign: tracerouteCampaignService.getActive(user.id, user.isAdmin) });
  } catch (error) {
    logger.error('Error reading active traceroute campaign:', error);
    return res.status(500).json({ error: 'Failed to read traceroute campaign' });
  }
});

router.get('/latest', async (req: Request, res: Response) => {
  try {
    const user = await requireCampaignUser(req, res);
    if (!user) return;
    return res.json({ campaign: tracerouteCampaignService.getLatest(user.id, user.isAdmin) });
  } catch (error) {
    logger.error('Error reading latest traceroute campaign:', error);
    return res.status(500).json({ error: 'Failed to read traceroute campaign' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = await requireCampaignUser(req, res);
    if (!user) return;
    const campaign = tracerouteCampaignService.get(req.params.id, user.id, user.isAdmin);
    if (!campaign) return res.status(404).json({ error: 'Traceroute campaign not found' });
    return res.json(campaign);
  } catch (error) {
    logger.error('Error reading traceroute campaign:', error);
    return res.status(500).json({ error: 'Failed to read traceroute campaign' });
  }
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const user = await requireCampaignUser(req, res);
    if (!user) return;
    const campaign = tracerouteCampaignService.cancel(req.params.id, user.id, user.isAdmin);
    if (!campaign) return res.status(404).json({ error: 'Traceroute campaign not found' });
    return res.json(campaign);
  } catch (error) {
    logger.error('Error cancelling traceroute campaign:', error);
    return res.status(500).json({ error: 'Failed to cancel traceroute campaign' });
  }
});

export default router;
