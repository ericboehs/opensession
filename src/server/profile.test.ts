import { afterEach, describe, expect, test } from "bun:test";
import { isLocalProfile, localProfileUser, localRequestAllowed } from "./profile";

const savedProfile = process.env.OPENSESSION_PROFILE;
const savedUser = process.env.OPENSESSION_LOCAL_USER;

afterEach(() => {
  if (savedProfile === undefined) delete process.env.OPENSESSION_PROFILE;
  else process.env.OPENSESSION_PROFILE = savedProfile;
  if (savedUser === undefined) delete process.env.OPENSESSION_LOCAL_USER;
  else process.env.OPENSESSION_LOCAL_USER = savedUser;
});

describe("local profile", () => {
  test("is enabled only by the exact local value", () => {
    delete process.env.OPENSESSION_PROFILE;
    expect(isLocalProfile()).toBe(false);
    process.env.OPENSESSION_PROFILE = "production";
    expect(isLocalProfile()).toBe(false);
    process.env.OPENSESSION_PROFILE = "LOCAL";
    expect(isLocalProfile()).toBe(false);
    process.env.OPENSESSION_PROFILE = "local";
    expect(isLocalProfile()).toBe(true);
  });

  test("uses the explicit local user verbatim", () => {
    process.env.OPENSESSION_PROFILE = "local";
    process.env.OPENSESSION_LOCAL_USER = "Ada Lovelace";
    expect(localProfileUser()).toBe("Ada Lovelace");
  });

  test("accepts only same-origin loopback browser requests", () => {
    expect(localRequestAllowed(new Request("http://127.0.0.1:3850/api/health"))).toBe(true);
    expect(
      localRequestAllowed(
        new Request("http://localhost:3850/api/health", {
          headers: { Origin: "http://localhost:3850" },
        }),
      ),
    ).toBe(true);
    expect(
      localRequestAllowed(
        new Request("http://127.0.0.1:3850/api/repos", {
          headers: { Origin: "https://attacker.example" },
        }),
      ),
    ).toBe(false);
    expect(localRequestAllowed(new Request("http://192.168.1.2:3850/api/health"))).toBe(false);
  });
});
