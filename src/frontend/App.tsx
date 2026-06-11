import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar";
import { SessionViewer } from "./components/SessionViewer";
import { NewSession } from "./components/NewSession";
import { Home } from "./components/Home";
import { Automations } from "./components/Automations";
import { Wiki } from "./components/Wiki";
import { Connections } from "./components/Connections";
import { Archived } from "./components/Archived";
import { UserPicker, UserGate } from "./components/UserPicker";
import { useSessions } from "./hooks/useSessions";
import { useWebSocket } from "./hooks/useWebSocket";
import type { UnifiedSession } from "./lib/types";
import "./styles/global.css";

type Route =
  | { view: "home" }
  | { view: "new"; prompt?: string }
  | { view: "session"; id: string }
  | { view: "automations" }
  | { view: "wiki"; path: string | null }
  | { view: "connections" }
  | { view: "archived" };

function parseRoute(pathname: string): Route {
  const sessionMatch = pathname.match(/^\/backstage\/session\/(.+)$/);
  if (sessionMatch) return { view: "session", id: decodeURIComponent(sessionMatch[1]) };
  if (pathname === "/backstage/new") return { view: "new" };
  if (pathname === "/backstage/automations") return { view: "automations" };
  if (pathname === "/backstage/connections") return { view: "connections" };
  if (pathname === "/backstage/archived") return { view: "archived" };
  const wikiMatch = pathname.match(/^\/backstage\/wiki(?:\/(.*))?$/);
  if (wikiMatch) return { view: "wiki", path: wikiMatch[1] ? decodeURIComponent(wikiMatch[1]) : null };
  return { view: "home" };
}

function routePath(route: Route): string {
  switch (route.view) {
    case "session":
      return `/backstage/session/${encodeURIComponent(route.id)}`;
    case "new":
      return route.prompt
        ? `/backstage/new?prompt=${encodeURIComponent(route.prompt)}`
        : "/backstage/new";
    case "automations":
      return "/backstage/automations";
    case "connections":
      return "/backstage/connections";
    case "archived":
      return "/backstage/archived";
    case "wiki":
      return route.path
        ? `/backstage/wiki/${route.path.split("/").map(encodeURIComponent).join("/")}`
        : "/backstage/wiki";
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

  // When a session is created from the New Session form or Ask box, jump straight into it
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
      ? sessions.find((s) => s.id === route.id || s.aliasIds?.includes(route.id)) || null
      : null;

  const activeView =
    route.view === "automations" || route.view === "wiki" || route.view === "connections"
      ? route.view
      : ("sessions" as const);

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
              <span className="app-title-text">Michael</span>
            </a>
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
              activeView={activeView}
              onNavigate={(view) =>
                navigate(
                  view === "sessions"
                    ? { view: "home" }
                    : view === "wiki"
                      ? { view: "wiki", path: null }
                      : { view }
                )
              }
              onSelect={(s) => navigate({ view: "session", id: s.id })}
              onNewSession={() => navigate({ view: "new" })}
              onOpenArchived={() => navigate({ view: "archived" })}
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
            ) : route.view === "automations" ? (
              <Automations onOpenSession={(id) => navigate({ view: "session", id })} />
            ) : route.view === "connections" ? (
              <Connections />
            ) : route.view === "archived" ? (
              <Archived
                sessions={sessions}
                onSelect={(s) => navigate({ view: "session", id: s.id })}
                onChanged={refresh}
              />
            ) : route.view === "wiki" ? (
              <Wiki
                docPath={route.path}
                onNavigate={(path) => navigate({ view: "wiki", path })}
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
                onNewSession={(prompt) => navigate({ view: "new", prompt })}
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
