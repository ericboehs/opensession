/** Public-ingress configuration, discovery and managed exposure helpers. */
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { networkInterfaces } from "os";
import { join } from "path";
import { tmpdir } from "os";
import { resolve4, resolve6 } from "dns/promises";
import {
  configuredIngress,
  configuredServer,
  type IngressExposure,
} from "./config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "./config-mutation";
import { isBlockedAddress } from "./shared/network-address";
import { caddyIngressSnippet, upsertCaddyIngress } from "./sandbox/caddy-ingress";
import { stateDir } from "./paths";
import { writeFileAtomic } from "./shared/atomic-write";

export const PUBLIC_INGRESS_PORT = 3860;
const CADDYFILE = process.env.OPENSESSION_CADDYFILE || "/etc/caddy/Caddyfile";
const CLOUDFLARE_TOKEN_PATH = stateDir("cloudflared-tunnel-token");
const runtime = globalThis as typeof globalThis & {
  __opensessionCloudflared?: ReturnType<typeof Bun.spawn>;
  __opensessionCloudflaredRestart?: ReturnType<typeof setTimeout>;
};

export interface IngressStatus {
  canManage: boolean;
  publicBaseUrl: string;
  exposure: IngressExposure | null;
  health: "ready" | "unreachable" | "not_configured";
  localUrl: string;
  hostname: string;
  dns: { a: string[]; aaaa: string[]; suggested: string[] };
  tailscale: { installed: boolean; dnsName: string; suggestedUrl: string };
  cloudflare: {
    installed: boolean;
    tunnelId: string;
    cnameTarget: string;
    connectorTarget: string;
    tokenConfigured: boolean;
    connectorRunning: boolean;
  };
  custom: { caddyInstalled: boolean; generatedConfig: string };
}

export function normalizeIngressOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Public ingress URL is required");
  if (trimmed.length > 2048 || /[\r\n\0]/.test(trimmed)) {
    throw new Error("Public ingress URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Public ingress URL must be a full HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Public ingress URL must use HTTPS");
  if (parsed.port || parsed.username || parsed.password) {
    throw new Error("Public ingress URL must use the default HTTPS port and no credentials");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Public ingress URL must not include a path, query, or fragment");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isBlockedAddress(host)
  ) {
    throw new Error("Public ingress must be reachable from the public internet");
  }
  const appHost = (() => {
    try { return new URL(configuredServer().publicBaseUrl).hostname.toLowerCase(); }
    catch { return ""; }
  })();
  if (host === appHost) {
    throw new Error("Public ingress must use a different hostname from the private app");
  }
  return parsed.origin;
}

async function command(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function tailscaleDnsName(): Promise<string> {
  const binary = Bun.which("tailscale");
  if (!binary) return "";
  const result = await command([binary, "status", "--json"]);
  if (result.code !== 0) return "";
  try {
    const parsed = JSON.parse(result.stdout);
    return String(parsed?.Self?.DNSName || "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

function publicInterfaceAddresses(): { a: string[]; aaaa: string[] } {
  const a = new Set<string>();
  const aaaa = new Set<string>();
  if (process.env.OPENSESSION_PUBLIC_IPV4) a.add(process.env.OPENSESSION_PUBLIC_IPV4);
  if (process.env.OPENSESSION_PUBLIC_IPV6) aaaa.add(process.env.OPENSESSION_PUBLIC_IPV6);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || isBlockedAddress(entry.address)) continue;
      if (entry.family === "IPv4") a.add(entry.address);
      else if (entry.family === "IPv6") aaaa.add(entry.address);
    }
  }
  return { a: [...a], aaaa: [...aaaa] };
}

async function currentDns(hostname: string): Promise<{ a: string[]; aaaa: string[] }> {
  if (!hostname) return { a: [], aaaa: [] };
  const [a, aaaa] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return { a, aaaa };
}

async function ingressHealth(origin: string): Promise<IngressStatus["health"]> {
  if (!origin) return "not_configured";
  try {
    const response = await fetch(`${origin}/ingress-health`, {
      signal: AbortSignal.timeout(6_000),
    });
    return response.ok && (await response.text()).trim() === "ok" ? "ready" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function publicIngressStatus(canManage: boolean): Promise<IngressStatus> {
  const configured = configuredIngress();
  let hostname = "";
  try { hostname = new URL(configured.publicBaseUrl).hostname; } catch {}
  const [dns, tsName, health] = await Promise.all([
    currentDns(hostname),
    tailscaleDnsName(),
    ingressHealth(configured.publicBaseUrl),
  ]);
  const direct = publicInterfaceAddresses();
  // Existing DNS is a useful exact answer on cloud hosts whose public address
  // is NATed and therefore absent from networkInterfaces (EC2 is common).
  const suggestedAddresses = direct.a.length || direct.aaaa.length ? direct : dns;
  const tunnelId = configured.cloudflareTunnelId;
  return {
    canManage,
    publicBaseUrl: configured.publicBaseUrl,
    exposure: configured.exposure,
    health,
    localUrl: `http://127.0.0.1:${PUBLIC_INGRESS_PORT}`,
    hostname,
    dns: {
      ...dns,
      suggested: [
        ...suggestedAddresses.a.map((address) => `A ${hostname || "ingress.example.com"} ${address}`),
        ...suggestedAddresses.aaaa.map((address) => `AAAA ${hostname || "ingress.example.com"} ${address}`),
      ],
    },
    tailscale: {
      installed: Bun.which("tailscale") !== null,
      dnsName: tsName,
      suggestedUrl: tsName ? `https://${tsName}` : "",
    },
    cloudflare: {
      installed: Bun.which("cloudflared") !== null,
      tunnelId,
      cnameTarget: tunnelId ? `${tunnelId}.cfargotunnel.com` : "<tunnel-id>.cfargotunnel.com",
      connectorTarget: `http://127.0.0.1:${PUBLIC_INGRESS_PORT}`,
      tokenConfigured: existsSync(CLOUDFLARE_TOKEN_PATH),
      connectorRunning: cloudflareConnectorRunning(),
    },
    custom: {
      caddyInstalled: Bun.which("caddy") !== null,
      generatedConfig: caddyIngressSnippet(configured.publicBaseUrl || "https://ingress.example.com"),
    },
  };
}

export async function savePublicIngress(input: {
  publicBaseUrl: string;
  exposure: IngressExposure;
  cloudflareTunnelId?: string;
}): Promise<void> {
  const publicBaseUrl = normalizeIngressOrigin(input.publicBaseUrl);
  if (!(["tailscale", "cloudflare", "custom"] as string[]).includes(input.exposure)) {
    throw new Error("Unknown exposure method");
  }
  const cloudflareTunnelId = (input.cloudflareTunnelId || "").trim();
  if (input.exposure === "cloudflare" && !/^[0-9a-f-]{36}$/i.test(cloudflareTunnelId)) {
    throw new Error("Cloudflare tunnel ID must be a UUID");
  }
  await withConfigMutationLock(async () => {
    const raw = rawConfig();
    raw.ingress = {
      publicBaseUrl,
      exposure: input.exposure,
      ...(cloudflareTunnelId ? { cloudflareTunnelId } : {}),
    };
    // The public origin has one owner now. Remove the retired webhook origin
    // instead of leaving two values that can drift.
    if (raw.server && typeof raw.server === "object" && !Array.isArray(raw.server)) {
      delete (raw.server as Record<string, unknown>).webhookBaseUrl;
      delete (raw.server as Record<string, unknown>).webhookPort;
    }
    persistRawConfig(raw);
  });
  if (input.exposure !== "cloudflare") {
    if (runtime.__opensessionCloudflaredRestart) {
      clearTimeout(runtime.__opensessionCloudflaredRestart);
      runtime.__opensessionCloudflaredRestart = undefined;
    }
    runtime.__opensessionCloudflared?.kill();
    runtime.__opensessionCloudflared = undefined;
  }
}

export async function enableTailscaleFunnel(): Promise<string> {
  const binary = Bun.which("tailscale");
  if (!binary) throw new Error("Tailscale is not installed on this server");
  const dnsName = await tailscaleDnsName();
  if (!dnsName) throw new Error("Tailscale is not connected or has no HTTPS hostname");
  const result = await command([
    binary,
    "funnel",
    "--bg",
    "--yes",
    "--https=443",
    `http://127.0.0.1:${PUBLIC_INGRESS_PORT}`,
  ]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not enable Tailscale Funnel");
  const origin = normalizeIngressOrigin(`https://${dnsName}`);
  let healthy = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await ingressHealth(origin) === "ready") {
      healthy = true;
      break;
    }
    await Bun.sleep(1_000);
  }
  if (!healthy) throw new Error("Funnel started, but the public health check did not become ready");
  await savePublicIngress({ publicBaseUrl: origin, exposure: "tailscale" });
  return origin;
}

function cloudflareConnectorRunning(): boolean {
  return runtime.__opensessionCloudflared?.exitCode === null;
}

/** Start or reuse the named Cloudflare connector. Called explicitly at boot
 * and after Settings stores a token; importing this module has no effects. */
export function ensureCloudflareTunnel(): boolean {
  if (configuredIngress().exposure !== "cloudflare") return false;
  if (cloudflareConnectorRunning()) return true;
  const binary = Bun.which("cloudflared");
  if (!binary || !existsSync(CLOUDFLARE_TOKEN_PATH)) return false;
  if (runtime.__opensessionCloudflaredRestart) {
    clearTimeout(runtime.__opensessionCloudflaredRestart);
    runtime.__opensessionCloudflaredRestart = undefined;
  }
  const child = Bun.spawn(
    [binary, "tunnel", "--no-autoupdate", "run", "--token-file", CLOUDFLARE_TOKEN_PATH],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env },
  );
  runtime.__opensessionCloudflared = child;
  console.log("[public-ingress] Cloudflare Tunnel connector started");
  void child.exited.then((code) => {
    if (runtime.__opensessionCloudflared !== child) return;
    runtime.__opensessionCloudflared = undefined;
    console.error(`[public-ingress] Cloudflare Tunnel connector exited (${code})`);
    if (configuredIngress().exposure === "cloudflare") {
      runtime.__opensessionCloudflaredRestart = setTimeout(() => ensureCloudflareTunnel(), 5_000);
    }
  });
  return true;
}

export async function configureCloudflareTunnel(input: {
  publicBaseUrl: string;
  tunnelId: string;
  token?: string;
}): Promise<void> {
  const token = (input.token || "").trim();
  if (/\s/.test(token) || token.length > 4096) throw new Error("Cloudflare tunnel token is invalid");
  if (!token && !existsSync(CLOUDFLARE_TOKEN_PATH)) {
    throw new Error("Cloudflare tunnel token is required");
  }
  if (!Bun.which("cloudflared")) throw new Error("cloudflared is not installed on this server");
  if (token) writeFileAtomic(CLOUDFLARE_TOKEN_PATH, `${token}\n`, 0o600);
  await savePublicIngress({
    publicBaseUrl: input.publicBaseUrl,
    exposure: "cloudflare",
    cloudflareTunnelId: input.tunnelId,
  });
  if (!ensureCloudflareTunnel()) throw new Error("Could not start the Cloudflare Tunnel connector");
}

export async function installManagedCaddy(originValue: string): Promise<void> {
  const origin = normalizeIngressOrigin(originValue);
  const caddy = Bun.which("caddy");
  const sudo = Bun.which("sudo");
  if (!caddy || !sudo) throw new Error("Caddy and sudo are required for managed custom domains");
  let current: string;
  try { current = readFileSync(CADDYFILE, "utf8"); }
  catch { throw new Error(`Could not read ${CADDYFILE}`); }
  const scratch = mkdtempSync(join(tmpdir(), `opensession-ingress-${randomBytes(4).toString("hex")}-`));
  const staged = join(scratch, "Caddyfile");
  const backup = `${CADDYFILE}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runSudo = (args: string[]) => command([sudo, "-n", ...args]);
  const rollback = async () => {
    await runSudo(["cp", "-p", backup, CADDYFILE]);
    await runSudo(["systemctl", "reload", "caddy"]);
  };
  try {
    await Bun.write(staged, upsertCaddyIngress(current, origin));
    if ((await runSudo(["cp", "-p", CADDYFILE, backup])).code !== 0) {
      throw new Error("Could not back up the Caddyfile");
    }
    if ((await runSudo(["install", "-m", "0644", staged, CADDYFILE])).code !== 0) {
      await rollback();
      throw new Error("Could not install the managed Caddy route; the prior Caddyfile was restored");
    }
    const validate = await runSudo([caddy, "validate", "--config", CADDYFILE, "--adapter", "caddyfile"]);
    if (validate.code !== 0) {
      await rollback();
      throw new Error(validate.stderr.trim() || "Caddy rejected the generated configuration");
    }
    const reload = await runSudo(["systemctl", "reload", "caddy"]);
    if (reload.code !== 0) {
      await rollback();
      throw new Error(reload.stderr.trim() || "Caddy reload failed");
    }
    let healthy = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await ingressHealth(origin) === "ready") {
        healthy = true;
        break;
      }
      await Bun.sleep(1_000);
    }
    if (!healthy) {
      await rollback();
      throw new Error("The public health check failed; the prior Caddyfile was restored");
    }
    await savePublicIngress({ publicBaseUrl: origin, exposure: "custom" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
