import React from "react";

const TEAM = ["Michiel", "Jaap", "Kent", "Grant", "Johnny", "Louise"];

export function UserPicker() {
  const [user, setUser] = React.useState(
    () => localStorage.getItem("backstage-user") || ""
  );

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    setUser(val);
    localStorage.setItem("backstage-user", val);
  }

  return (
    <select className="user-picker" value={user} onChange={handleChange}>
      <option value="">Select user...</option>
      {TEAM.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

export function getCurrentUser(): string {
  return localStorage.getItem("backstage-user") || "Anonymous";
}
