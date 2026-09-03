import { useLocation, useNavigate } from 'react-router-dom';
import TracerouteCampaignPanel from '../components/Dashboard/TracerouteCampaignPanel';
import { UiIcon } from '../components/icons';
import {
  useDashboardSources,
  useDashboardUnifiedData,
  useSourceStatuses,
} from '../hooks/useDashboardData';
import { appBasename } from '../init';
import type { TracerouteCampaignTargetInput } from '../types/tracerouteCampaign';
import '../styles/dashboard.css';

interface TracerouteCampaignLocationState {
  initialTarget?: TracerouteCampaignTargetInput;
}

export default function TracerouteCampaignPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: sources = [] } = useDashboardSources();
  const sourceStatuses = useSourceStatuses(sources.map((source) => source.id));
  const unifiedData = useDashboardUnifiedData(sources, true);
  const initialTarget = (location.state as TracerouteCampaignLocationState | null)?.initialTarget ?? null;

  const returnToDashboard = () => {
    void navigate('/', { state: { showList: true } });
  };

  return (
    <div className="traceroute-campaign-page">
      <header className="traceroute-campaign-page-nav">
        <button type="button" className="traceroute-campaign-back" onClick={returnToDashboard}>
          <UiIcon name="back" size={16} /> Torna alla mappa
        </button>
        <div className="traceroute-campaign-brand">
          <img src={`${appBasename}/logo.png`} alt="" />
          <span>MeshMonitor</span>
        </div>
      </header>

      <main className="traceroute-campaign-page-main">
        {unifiedData.isError && (
          <div className="traceroute-campaign-load-error" role="alert">
            Impossibile caricare i nodi Unified. Riprova tra qualche secondo.
          </div>
        )}
        {unifiedData.isLoading && unifiedData.nodes.length === 0 && (
          <div className="traceroute-campaign-loading" role="status">Caricamento nodi…</div>
        )}
        <TracerouteCampaignPanel
          nodes={unifiedData.nodes}
          sources={sources}
          sourceStatuses={sourceStatuses}
          initialTarget={initialTarget}
        />
      </main>
    </div>
  );
}
