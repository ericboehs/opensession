/** Public-ingress configuration, discovery and managed exposure helpers. */
import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { networkInterfaces } from "os";
import { isIP } from "net";
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
  health: "ready" | "waiting_dns" | "unreachable" | "not_configured";
  localUrl: string;
  hostname: string;
  server: { ipv4: string[]; ipv6: string[] };
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

/** Custom-domain setup asks for a domain, not URL syntax. HTTPS is fixed by
 * the ingress contract and Caddy provisions it, so adding a scheme is busywork. */
export function normalizeCustomIngressOrigin(value: string): string {
  const trimmed = value.trim();
  return normalizeIngressOrigin(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
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
  if (process.env.OPENSESSION_PUBLIC_IPV4) a.add(process.env.OPENSESSION_PUBLIC_IPV4.trim());
  if (process.env.OPENSESSION_PUBLIC_IPV6) aaaa.add(process.env.OPENSESSION_PUBLIC_IPV6.trim());
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || isBlockedAddress(entry.address)) continue;
      if (entry.family === "IPv4") a.add(entry.address);
      else if (entry.family === "IPv6") aaaa.add(entry.address);
    }
  }
  return {
    a: [...a].filter((address) => isIP(address) === 4 && !isBlockedAddress(address)),
    aaaa: [...aaaa].filter((address) => isIP(address) === 6 && !isBlockedAddress(address)),
  };
}

async function metadataValue(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<string> {
  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return "";
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/** Discover a NATed cloud VM's public address without sending instance data to
 * an internet "what is my IP" service. These are fixed link-local metadata
 * endpoints for AWS, GCP, and Azure; unsupported providers simply time out. */
async function cloudMetadataPublicIpv4(): Promise<string[]> {
  const aws = (async () => {
    const token = await metadataValue(
      "http://169.254.169.254/latest/api/token",
      { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      "PUT",
    );
    return metadataValue(
      "http://169.254.169.254/latest/meta-data/public-ipv4",
      token ? { "X-aws-ec2-metadata-token": token } : {},
    );
  })();
  const [awsAddress, gcpAddress, azureAddress] = await Promise.all([
    aws,
    metadataValue(
      "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
      { "Metadata-Flavor": "Google" },
    ),
    metadataValue(
      "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text",
      { Metadata: "true" },
    ),
  ]);
  return [...new Set([awsAddress, gcpAddress, azureAddress])]
    .filter((address) => isIP(address) === 4 && !isBlockedAddress(address));
}

async function publicServerAddresses(): Promise<{ a: string[]; aaaa: string[] }> {
  const direct = publicInterfaceAddresses();
  const metadata = direct.a.length ? [] : await cloudMetadataPublicIpv4();
  return { a: [...new Set([...direct.a, ...metadata])], aaaa: direct.aaaa };
}

async function currentDns(hostname: string): Promise<{ a: string[]; aaaa: string[] }> {
  if (!hostname) return { a: [], aaaa: [] };
  const [a, aaaa] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return { a, aaaa };
}

async function ingressHealth(origin: string): Promise<"ready" | "unreachable" | "not_configured"> {
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

export function publicIngressHealth(
  exposure: IngressExposure | null,
  probed: "ready" | "unreachable" | "not_configured",
  dns: { a: string[]; aaaa: string[] },
  server: { a: string[]; aaaa: string[] },
): IngressStatus["health"] {
  if (exposure !== "custom" || probed !== "unreachable") return probed;
  const expectedAddresses = [...server.a, ...server.aaaa];
  const resolvedAddresses = [...dns.a, ...dns.aaaa];
  const dnsPointsHere = expectedAddresses.length
    ? resolvedAddresses.some((address) => expectedAddresses.includes(address))
    : resolvedAddresses.length > 0;
  return dnsPointsHere ? probed : "waiting_dns";
}

export async function publicIngressStatus(canManage: boolean): Promise<IngressStatus> {
  const configured = configuredIngress();
  let hostname = "";
  try { hostname = new URL(configured.publicBaseUrl).hostname; } catch {}
  const [dns, tsName, probedHealth, serverAddresses] = await Promise.all([
    currentDns(hostname),
    tailscaleDnsName(),
    ingressHealth(configured.publicBaseUrl),
    publicServerAddresses(),
  ]);
  const health = publicIngressHealth(configured.exposure, probedHealth, dns, serverAddresses);
  const tunnelId = configured.cloudflareTunnelId;
  return {
    canManage,
    publicBaseUrl: configured.publicBaseUrl,
    exposure: configured.exposure,
    health,
    localUrl: `http://127.0.0.1:${PUBLIC_INGRESS_PORT}`,
    hostname,
    server: { ipv4: serverAddresses.a, ipv6: serverAddresses.aaaa },
    dns: {
      ...dns,
      suggested: [
        ...serverAddresses.a.map((address) => `A ${hostname || "ingress.example.com"} ${address}`),
        ...serverAddresses.aaaa.map((address) => `AAAA ${hostname || "ingress.example.com"} ${address}`),
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
  // Funnel starting and its public edge becoming reachable are separate facts.
  // Persist the successful command immediately so a slow edge does not leave a
  // running Funnel reported as an entirely failed setup. The UI probes health.
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
  const origin = normalizeCustomIngressOrigin(originValue);
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
    try {
      await savePublicIngress({ publicBaseUrl: origin, exposure: "custom" });
    } catch (error) {
      await rollback();
      throw error;
    }
    // DNS may intentionally be the operator's next step. Caddy keeps retrying
    // certificate issuance after propagation, while status reports waiting_dns.
    // Do not roll back a valid listener merely because the public edge is not
    // reachable in the first few seconds.
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
