import React, { useState, useEffect } from "react";

export const TEAM = ["Michiel", "Jaap", "Kent", "Grant", "Johnny", "John", "Louise"];
const KEY = "backstage-user";
const CHANGE_EVENT = "michael-user-changed";

function setStoredUser(val: string) {
  localStorage.setItem(KEY, val);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getCurrentUser(): string {
  return localStorage.getItem(KEY) || "Anonymous";
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

export function UserPicker() {
  const user = useCurrentUser();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setStoredUser(e.target.value);
  }

  return (
    <div className="user-picker">
      <span className="user-picker-val">{user}</span>
      <span className="user-picker-caret">▾</span>
      <select
        className="user-picker-select"
        value={user}
        onChange={handleChange}
        aria-label="Current user"
      >
        {!TEAM.includes(user) && <option value={user}>{user}</option>}
        {TEAM.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function UserGate({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();

  if (user !== "Anonymous") return <>{children}</>;

  return (
    <div className="user-gate-overlay">
      <div className="user-gate-card">
        <h2>Who are you?</h2>
        <div className="user-gate-grid">
          {TEAM.map((name) => (
            <button
              key={name}
              className="user-gate-btn"
              onClick={() => setStoredUser(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
