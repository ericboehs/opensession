import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { Home } from "./components/Home";
import { UserPicker, UserGate } from "./components/UserPicker";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

type Route =
  | { view: "home" }
  | { view: "new" }
  | { view: "session"; id: string };

function parseRoute(pathname: string): Route {
  const sessionMatch = pathname.match(/^\/backstage\/session\/(.+)$/);
  if (sessionMatch) return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
  if (pathname === "/backstage/new") return { view: "new" };
  return { view: "home" };
}

function routePath(route: Route): string {
  switch (route.view) {
    case "session":
      return `/backstage/session/${encodeURIComponent(route.id)}`;
    case "new":
      return "/backstage/new";
    default:
      return "/backstage/";
  }
}

function App() {
  const { sessions, loading, refresh } = useSessions();
  const { connected, send, addHandler } = useWebSocket();
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function navigate(route: Route) {
    history.pushState(null, "", routePath(route));
    setRoute(route);
    setSidebarOpen(false);
  }

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // When a session is created from the New Session form, jump straight into it
  useEffect(() => {
    return addHandler((msg) => {
      if (msg.type === "session_created") {
        refresh();
        navigate({ view: "session", id: msg.id });
      }
    });
  }, [addHandler, refresh]);

  const currentSession: UnifiedSession | null =
    route.view === "session"
      ? sessions.find((s) => s.id === route.id) || null
      : null;

  return (
    <UserGate>
      <div className="app">
        <header className="app-header">
          <div className="app-header-left">
            <button
              className="hamburger"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle sidebar"
            >
              <span /><span /><span />
            </button>
            <a
              className="app-title"
              href="/backstage/"
              onClick={(e) => {
                e.preventDefault();
                navigate({ view: "home" });
              }}
            >
              <span className="app-logo">M</span>
              Michael
            </a>
            <span className="app-subtitle">Tella's coding agent</span>
          </div>
          <div className="app-header-right">
            <span className={`connection-dot ${connected ? "connected" : "disconnected"}`} />
            <UserPicker />
          </div>
        </header>

        <div className="app-body">
          {/* Overlay to close sidebar on mobile */}
          {sidebarOpen && (
            <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
          )}

          <div className={`sidebar-container ${sidebarOpen ? "sidebar-open" : ""}`}>
            <Sidebar
              sessions={sessions}
              selectedId={currentSession?.id || null}
              onSelect={(s) => navigate({ view: "session", id: s.id })}
              onNewSession={() => navigate({ view: "new" })}
            />
          </div>

          <main className="detail-pane">
            {route.view === "new" ? (
              <NewSession
                onBack={() => navigate({ view: "home" })}
                send={send}
                addHandler={addHandler}
                connected={connected}
              />
            ) : route.view === "session" ? (
              currentSession ? (
                <SessionViewer
                  key={currentSession.id}
                  session={currentSession}
                  onBack={() => navigate({ view: "home" })}
                  send={send}
                  addHandler={addHandler}
                  connected={connected}
                />
              ) : (
                <div className="detail-empty">
                  <div className="detail-empty-inner">
                    <div className="detail-empty-title">
                      {loading ? "Loading session…" : "Session not found"}
                    </div>
                    <div className="detail-empty-sub">
                      {loading ? "" : "It may have been deleted."}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <Home
                sessions={sessions}
                loading={loading}
                connected={connected}
                send={send}
                onSelect={(s) => navigate({ view: "session", id: s.id })}
                onNewSession={() => navigate({ view: "new" })}
              />
            )}
          </main>
        </div>
      </div>
    </UserGate>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
