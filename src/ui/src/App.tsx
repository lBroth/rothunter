import { useEffect, useState } from 'react';
import { Dashboard } from './pages/Dashboard.js';
import { FindingDetail } from './pages/FindingDetail.js';
import { ScanRunning } from './pages/ScanRunning.js';
import { Findings } from './pages/Findings.js';
import { History as HistoryPage } from './pages/History.js';
import { Symbols } from './pages/Symbols.js';
import { Settings } from './pages/Settings.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { LiveScanBanner } from './components/LiveScanBanner.js';
import { Toaster } from './components/Toaster.js';
import { listScans, startScan } from './lib/api.js';
import { useHistoryRoute } from './lib/history.js';

export function App(): JSX.Element {
  const { route, setRoute } = useHistoryRoute();
  const [latestScanId, setLatestScanId] = useState<string | null>(null);
  const [liveScanId, setLiveScanId] = useState<string | null>(null);
  const [pendingScan, setPendingScan] = useState<boolean>(false);

  useEffect(() => {
    listScans()
      .then((scans) => {
        if (scans.length === 0) return;
        const first = scans[0]!;
        if (first.state === 'done' || first.state === 'error') {
          setLatestScanId(first.scanId);
        } else {
          // Track the in-flight scan for the global banner. Don't auto-
          // redirect — let the user stay where they are.
          setLiveScanId(first.scanId);
        }
      })
      .catch(() => {
        // backend unreachable — empty state on dashboard
      });
  }, []);

  const onStartScan = async (): Promise<void> => {
    setPendingScan(true);
    try {
      const { scanId } = await startScan({});
      setLiveScanId(scanId);
      setRoute({ name: 'running', scanId });
    } finally {
      setPendingScan(false);
    }
  };

  const onLiveDone = (): void => {
    if (liveScanId) setLatestScanId(liveScanId);
    setLiveScanId(null);
  };

  return (
    <div className="min-h-screen flex bg-bg text-ink">
      <Sidebar route={route} onNavigate={setRoute} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          lastScanId={latestScanId}
          onRunScan={onStartScan}
          onHome={() => setRoute({ name: 'dashboard' })}
          pending={pendingScan}
        />
        {liveScanId && route.name !== 'running' && (
          <LiveScanBanner
            scanId={liveScanId}
            onOpen={() => setRoute({ name: 'running', scanId: liveScanId })}
            onDone={onLiveDone}
          />
        )}
        <main className="flex-1 overflow-y-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
          {route.name === 'dashboard' && (
            <Dashboard
              scanId={latestScanId}
              onOpenFinding={(fp) => setRoute({ name: 'finding', fingerprint: fp })}
              onScanStarted={(sid) => setRoute({ name: 'running', scanId: sid })}
              onOpenFindings={(filter) =>
                setRoute({ name: 'findings', detector: filter?.detector, directory: filter?.directory })
              }
            />
          )}
          {route.name === 'finding' && (
            <FindingDetail
              fingerprint={route.fingerprint}
              onBack={() => setRoute({ name: 'findings' })}
              onOpenFinding={(fp) => setRoute({ name: 'finding', fingerprint: fp })}
            />
          )}
          {route.name === 'running' && (
            <ScanRunning
              scanId={route.scanId}
              onDone={() => {
                setLatestScanId(route.scanId);
                setLiveScanId((id) => (id === route.scanId ? null : id));
                setRoute({ name: 'dashboard' });
              }}
            />
          )}
          {route.name === 'findings' && (
            <Findings
              scanId={route.scanId ?? latestScanId}
              initialDetector={route.detector}
              initialDirectory={route.directory}
              onOpenFinding={(fp) => setRoute({ name: 'finding', fingerprint: fp })}
            />
          )}
          {route.name === 'symbols' && <Symbols />}
          {route.name === 'history' && (
            <HistoryPage onOpenScan={(sid) => setRoute({ name: 'findings', scanId: sid })} />
          )}
          {route.name === 'settings' && <Settings />}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
