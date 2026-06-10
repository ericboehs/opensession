/**
 * Short-lived AWS credentials for agent runs.
 *
 * The backstage service cgroup denies the EC2 metadata endpoint
 * (IPAddressDeny in backstage.service), so neither the main process nor any
 * agent child can reach IMDS directly — that's the per-child isolation that
 * keeps untrusted ticket text from minting the instance role itself.
 *
 * To still hand AWS to runs that need it, the *main* process mints a bounded
 * snapshot of the instance-role's temporary credentials and injects them into
 * the child's env. The mint escapes the cgroup via a transient systemd unit
 * (`systemd-run --pipe`, run as ubuntu via passwordless sudo) so it — and only
 * it — can reach IMDS. The child receives a fixed, expiring copy in its env; it
 * cannot refresh them or read any other instance metadata.
 *
 * Scope today == the michael-ai instance role (AWS-managed ReadOnlyAccess):
 * account-wide read, no writes. To narrow this, point the helper at an
 * sts:AssumeRole of a tighter role instead of vending the instance creds.
 */

const REGION = process.env.AGENT_AWS_REGION || "us-east-2"; // tella prod (tella-app-prod)

interface ImdsCreds {
  AccessKeyId: string;
  SecretAccessKey: string;
  Token: string;
  Expiration: string; // ISO 8601
}

// IMDSv2 dance, run inside a transient unit that is NOT in the backstage cgroup
// (so the IMDS deny doesn't apply). Emits only the credentials JSON on stdout.
const FETCH_SCRIPT = [
  'TOKEN=$(curl -s -m 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")',
  '[ -z "$TOKEN" ] && exit 11',
  'ROLE=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/)',
  '[ -z "$ROLE" ] && exit 12',
  'curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/iam/security-credentials/$ROLE"',
].join("\n");

let cache: { env: Record<string, string>; expiresAt: number } | null = null;
const REFRESH_SKEW_MS = 5 * 60_000; // refresh 5 min before expiry

async function fetchInstanceCreds(): Promise<ImdsCreds | null> {
  try {
    const proc = Bun.spawn(
      [
        "sudo", "-n", "systemd-run", "--pipe", "--collect", "--quiet",
        "--uid=ubuntu", "--gid=ubuntu",
        "/bin/bash", "-c", FETCH_SCRIPT,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      console.error(`[aws-creds] mint helper exited ${code}: ${err.trim().slice(0, 200)}`);
      return null;
    }
    const creds = JSON.parse(out.trim());
    if (!creds.AccessKeyId || !creds.SecretAccessKey || !creds.Token) {
      console.error("[aws-creds] mint helper returned no usable credentials");
      return null;
    }
    return creds as ImdsCreds;
  } catch (e: any) {
    console.error("[aws-creds] failed to mint credentials:", e?.message || e);
    return null;
  }
}

/**
 * AWS env vars to inject into an agent child, or {} if minting failed (the run
 * still proceeds — it just has no AWS, and `aws` calls will error visibly
 * rather than us swallowing the problem). Cached until shortly before expiry.
 */
export async function getAgentAwsEnv(): Promise<Record<string, string>> {
  if (cache && Date.now() < cache.expiresAt - REFRESH_SKEW_MS) return cache.env;

  const creds = await fetchInstanceCreds();
  if (!creds) return cache?.env ?? {}; // fall back to a still-valid cache if any

  const env = {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.Token,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
  };
  cache = { env, expiresAt: new Date(creds.Expiration).getTime() };
  console.log(`[aws-creds] minted agent credentials, expire ${creds.Expiration}`);
  return env;
}
