import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./components/Dashboard";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { UserPicker, UserGate } from "./components/UserPicker";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

type Route =
  | { page: "dashboard" }
  | { page: "session"; session: UnifiedSession }
  | { page: "new" };

function App() {
  const { sessions, loading, refresh } = useSessions();
  const { connected, send, addHandler } = useWebSocket();
  const [route, setRoute] = useState<Route>({ page: "dashboard" });

  // Hash-based routing
  useEffect(() => {
    function onHash() {
      const hash = location.hash.slice(1) || "/";
      if (hash.startsWith("/session/")) {
        const sessionId = decodeURIComponent(hash.slice("/session/".length));
        const session = sessions.find((s) => s.id === sessionId);
        if (session) {
          setRoute({ page: "session", session });
          return;
        }
      }
      if (hash === "/new") {
        setRoute({ page: "new" });
        return;
      }
      setRoute({ page: "dashboard" });
    }
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, [sessions]);

  function navigate(hash: string) {
    location.hash = hash;
  }

  return (
    <UserGate>
    <div className="app">
      <header className="app-header">
        <h1
          className="app-title"
          onClick={() => navigate("/")}
          style={{ cursor: "pointer" }}
        >
          Backstage
        </h1>
        <div className="app-header-right">
          <span className={`connection-dot ${connected ? "connected" : "disconnected"}`} />
          <UserPicker />
        </div>
      </header>

      <main className="app-main">
        {route.page === "dashboard" && (
          <Dashboard
            sessions={sessions}
            loading={loading}
            onSelectSession={(s) => navigate(`/session/${encodeURIComponent(s.id)}`)}
            onNewSession={() => navigate("/new")}
            onRefresh={refresh}
          />
        )}
        {route.page === "session" && (
          <SessionViewer
            session={route.session}
            onBack={() => navigate("/")}
            send={send}
            addHandler={addHandler}
            connected={connected}
          />
        )}
        {route.page === "new" && (
          <NewSession
            onBack={() => navigate("/")}
            send={send}
            connected={connected}
          />
        )}
      </main>
    </div>
    </UserGate>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
