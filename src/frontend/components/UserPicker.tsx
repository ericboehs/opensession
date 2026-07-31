import React, { useState, useEffect } from "react";
import { UserAvatar } from "./UserAvatar";
import { BASE_PATH } from "../lib/base";
import { usePeople } from "../lib/people";

/**
 * Mutable compatibility view for older consumers. `usePeople()` owns the
 * roster and updates this array in place after GET /api/people resolves.
 */
export const TEAM: string[] = [];
// Rename shim: read the new key first, fall back to the legacy one (existing
// browsers + tooling that presets it stay signed in); writes go to the new key.
const KEY = "opensession-user";
const LEGACY_KEY = "backstage-user";
const CHANGE_EVENT = "opensession-user-changed";

function setStoredUser(val: string) {
  localStorage.setItem(KEY, val);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getCurrentUser(): string {
  return (
    localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || "Anonymous"
  );
}

/** Switch the current user (used by the account menu's switcher). */
export function setCurrentUser(name: string) {
  setStoredUser(name);
}

/** Reactive current user — updates when the picker (or another tab) changes it. */
export function useCurrentUser(): string {
  const [user, setUser] = useState(getCurrentUser);

  useEffect(() => {
    const handler = () => setUser(getCurrentUser());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return user;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  local?: boolean;
  /** Server supports the redirect (authorization-code) sign-in. */
  redirect?: boolean;
  login?: string;
  name?: string;
}

// Shared auth state: UserGate fetches /api/auth/status once on load; other
// components (SettingsMenu's account section) read it reactively from here
// instead of re-fetching.
const AUTH_STATUS_EVENT = "opensession-auth-status-changed";
let authStatusCache: AuthStatus | null = null;

function setAuthStatusCache(status: AuthStatus) {
  authStatusCache = status;
  window.dispatchEvent(new Event(AUTH_STATUS_EVENT));
}

/** Reactive sign-in state; null until /api/auth/status answers (or when the
 *  server predates it). `required && authenticated` ⇒ GitHub-verified user. */
export function useAuthStatus(): AuthStatus | null {
  const [status, setStatus] = useState(authStatusCache);
  useEffect(() => {
    const handler = () => setStatus(authStatusCache);
    window.addEventListener(AUTH_STATUS_EVENT, handler);
    return () => window.removeEventListener(AUTH_STATUS_EVENT, handler);
  }, []);
  return status;
}

/** Sign out of the GitHub web session and return to the sign-in screen. */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${BASE_PATH}/api/auth/logout`, { method: "POST" });
  } catch {}
  window.location.reload();
}

/**
 * Identity gate. Default: the historical localStorage name picker. When
 * GitHub web sign-in is active on the server (config
 * integrations.github.userPrAuth), the picker is replaced by a real GitHub
 * sign-in (device flow → HttpOnly cookie) — the server then ignores
 * client-claimed names, so the localStorage value is display-only and is
 * synced to the verified identity here.
 */
export function UserGate({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const roster = usePeople();
  TEAM.splice(0, TEAM.length, ...roster.map(({ name }) => name));
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/auth/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: AuthStatus | null) => {
        if (!body) return; // old server / fetch failed → keep the picker flow
        setAuth(body);
        setAuthStatusCache(body);
        if ((body.local || body.required) && body.authenticated && body.name) {
          const user = body.name.split(" ")[0];
          // Always emit the user-change event after authenticated startup. The
          // per-user sidebar caches hydrate at module load and may have raced
          // auth/network readiness; selecting the same profile manually fixed
          // them only because it emitted this event again.
          setStoredUser(user);
        }
      })
      .catch(() => {});
  }, []);

  if (auth?.required) {
    if (auth.authenticated) return <>{children}</>;
    if (auth.local) return <LocalSessionExpired />;
    return (
      <GithubSignIn
        redirect={auth.redirect === true}
        onSignedIn={(status) => {
          setAuth(status);
          setAuthStatusCache(status);
        }}
      />
    );
  }

  if (auth?.local && auth.authenticated) return <>{children}</>;

  if (user !== "Anonymous") return <>{children}</>;

  return (
    <div className="user-gate-overlay">
      <div className="user-gate-card">
        <h2>Who are you?</h2>
        <div className="user-gate-grid">
          {roster.length ? (
            roster.map(({ name }) => (
              <button
                key={name}
                className="user-gate-btn"
                onClick={() => setStoredUser(name)}
              >
                <UserAvatar name={name} size={36} />
                {name}
              </button>
            ))
          ) : (
            <button
              className="user-gate-btn"
              onClick={() => setStoredUser("Local User")}
            >
              <UserAvatar name="Local User" size={36} />
              Continue locally
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function LocalSessionExpired() {
  return (
    <div className="user-gate-overlay">
      <div className="user-gate-card">
        <h2>GitHub sign-in expired</h2>
        <p className="text-dim">
          Switch to cloud mode, sign in with GitHub, then restart local mode.
        </p>
      </div>
    </div>
  );
}

function GithubSignIn({
  redirect,
  onSignedIn,
}: {
  redirect: boolean;
  onSignedIn: (status: AuthStatus) => void;
}) {
  const [flow, setFlow] = useState<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  // A failed redirect sign-in lands back on /?auth_error=… — surface it.
  const [error, setError] = useState<string | null>(() => {
    try {
      const err = new URLSearchParams(window.location.search).get("auth_error");
      if (err) {
        window.history.replaceState(null, "", window.location.pathname);
        return err;
      }
    } catch {}
    return null;
  });

  // Poll GitHub (via the server) until the device code is authorized.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/auth/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: flow.deviceCode }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (body.status === "ok") {
          if (body.name) setStoredUser(body.name.split(" ")[0]);
          onSignedIn({ required: true, authenticated: true, login: body.login, name: body.name });
          return;
        }
        if (body.status === "slow_down") intervalMs = Math.max(body.interval, 5) * 1000;
        if (body.status === "error" || body.error) {
          setError(body.error || "Sign-in failed");
          setFlow(null);
          return;
        }
      } catch {}
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, onSignedIn]);

  async function start() {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/auth/device`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setFlow(body);
    } catch (e: any) {
      setError(e.message);
    }
    setStarting(false);
  }

  return (
    <div className="user-gate-overlay">
      <div className="user-gate-card" style={{ maxWidth: 380 }}>
        <h2>Sign in</h2>
        {!flow ? (
          <>
            <p style={{ margin: "10px 0 16px", fontSize: 13, opacity: 0.75 }}>
              This workspace uses GitHub sign-in. Your sessions will act as your
              own GitHub account (PRs are authored by you).
            </p>
            {redirect ? (
              <>
                <button
                  className="user-gate-btn"
                  onClick={() => {
                    window.location.href = `${BASE_PATH}/api/auth/login`;
                  }}
                  style={{ width: "100%" }}
                >
                  Sign in with GitHub
                </button>
                <button
                  onClick={start}
                  disabled={starting}
                  style={{
                    marginTop: 10,
                    width: "100%",
                    background: "none",
                    border: "none",
                    fontSize: 13,
                    opacity: 0.6,
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  {starting ? "Starting…" : "Use a device code instead"}
                </button>
              </>
            ) : (
              <button className="user-gate-btn" onClick={start} disabled={starting} style={{ width: "100%" }}>
                {starting ? "Starting…" : "Sign in with GitHub"}
              </button>
            )}
          </>
        ) : (
          <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.7 }}>
            Enter code{" "}
            <strong style={{ fontFamily: "var(--mono, monospace)", letterSpacing: "0.12em" }}>
              {flow.userCode}
            </strong>{" "}
            at{" "}
            <a href={flow.verificationUri} target="_blank" rel="noreferrer">
              {flow.verificationUri.replace(/^https:\/\//, "")}
            </a>
            <br />
            <span style={{ fontSize: 13, opacity: 0.7 }}>Waiting for GitHub…</span>
          </p>
        )}
        {error && (
          <p style={{ marginTop: 10, fontSize: 13, color: "var(--red)" }}>{error}</p>
        )}
      </div>
    </div>
  );
}
