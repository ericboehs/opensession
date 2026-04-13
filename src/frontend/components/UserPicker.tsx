import React, { useState, useEffect } from "react";

const TEAM = ["Michiel", "Jaap", "Kent", "Grant", "Johnny", "Louise"];

export function UserPicker() {
  const [user, setUser] = useState(
    () => localStorage.getItem("backstage-user") || ""
  );

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    setUser(val);
    localStorage.setItem("backstage-user", val);
  }

  return (
    <select className="user-picker" value={user} onChange={handleChange}>
      {TEAM.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

export function UserGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState(
    () => localStorage.getItem("backstage-user") || ""
  );

  if (user) return <>{children}</>;

  return (
    <div className="user-gate-overlay">
      <div className="user-gate-card">
        <h2>Who are you?</h2>
        <div className="user-gate-grid">
          {TEAM.map((name) => (
            <button
              key={name}
              className="user-gate-btn"
              onClick={() => {
                localStorage.setItem("backstage-user", name);
                setUser(name);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function getCurrentUser(): string {
  return localStorage.getItem("backstage-user") || "Anonymous";
}
