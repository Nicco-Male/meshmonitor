/**
 * Coordinates traceroute traffic while a campaign owns one or more sources.
 *
 * Campaign requests use a dedicated MeshtasticManager method. Every ordinary
 * traceroute path goes through sendTraceroute(), which consults this registry
 * and therefore cannot overlap a campaign attempt on the same source.
 */
export class TracerouteCampaignBusyError extends Error {
  readonly code = 'TRACEROUTE_CAMPAIGN_ACTIVE';

  constructor(public readonly sourceId: string) {
    super(`A traceroute campaign is active on source ${sourceId}`);
    this.name = 'TracerouteCampaignBusyError';
  }
}

export function isTracerouteCampaignBusyError(error: unknown): error is TracerouteCampaignBusyError {
  return error instanceof TracerouteCampaignBusyError
    || (typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'TRACEROUTE_CAMPAIGN_ACTIVE');
}

export class TracerouteCampaignCoordinator {
  private readonly reservations = new Map<string, string>();

  reserve(campaignId: string, sourceIds: string[]): void {
    const conflict = sourceIds.find((sourceId) => {
      const owner = this.reservations.get(sourceId);
      return owner !== undefined && owner !== campaignId;
    });
    if (conflict) throw new TracerouteCampaignBusyError(conflict);

    for (const sourceId of sourceIds) {
      this.reservations.set(sourceId, campaignId);
    }
  }

  release(campaignId: string): void {
    for (const [sourceId, owner] of this.reservations) {
      if (owner === campaignId) this.reservations.delete(sourceId);
    }
  }

  isReserved(sourceId: string): boolean {
    return this.reservations.has(sourceId);
  }

  assertAvailable(sourceId: string): void {
    if (this.isReserved(sourceId)) throw new TracerouteCampaignBusyError(sourceId);
  }
}

export const tracerouteCampaignCoordinator = new TracerouteCampaignCoordinator();
