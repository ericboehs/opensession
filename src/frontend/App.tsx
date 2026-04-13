import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { UserPicker, UserGate } from "./components/UserPicker";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

function App() {
  const { sessions, loading, refresh } = useSessions();
  const { connected, send, addHandler } = useWebSocket();
  const [selected, setSelected] = useState<UnifiedSession | null>(null);
  const [showNew, setShowNew] = useState(false);

  // Keep selected session in sync with latest data
  const currentSession = selected
    ? sessions.find((s) => s.id === selected.id) || selected
    : null;

  function handleSelect(session: UnifiedSession) {
    setSelected(session);
    setShowNew(false);
  }

  function handleNewSession() {
    setShowNew(true);
    setSelected(null);
  }

  return (
    <UserGate>
      <div className="app">
        <header className="app-header">
          <h1 className="app-title">Backstage</h1>
          <div className="app-header-right">
            <span className={`connection-dot ${connected ? "connected" : "disconnected"}`} />
            <UserPicker />
          </div>
        </header>

        <div className="app-body">
          <Sidebar
            sessions={sessions}
            selectedId={currentSession?.id || null}
            onSelect={handleSelect}
            onNewSession={handleNewSession}
          />

          <main className="detail-pane">
            {showNew ? (
              <NewSession
                onBack={() => setShowNew(false)}
                send={send}
                connected={connected}
              />
            ) : currentSession ? (
              <SessionViewer
                key={currentSession.id}
                session={currentSession}
                onBack={() => setSelected(null)}
                send={send}
                addHandler={addHandler}
                connected={connected}
              />
            ) : (
              <div className="detail-empty">
                <div className="detail-empty-inner">
                  <div className="detail-empty-title">Backstage</div>
                  <div className="detail-empty-sub">
                    {loading ? "Loading sessions..." : `${sessions.length} sessions`}
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </UserGate>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
