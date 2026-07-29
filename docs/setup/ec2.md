# A clean EC2 box for OpenSession

You do not need AWS to run OpenSession — any Linux box works. This page exists
because "spin up a fresh VM" is the most common way people try it, and there is
one cloud-init trap worth avoiding.

## Sizing

OpenSession runs agent turns, builds frontends and cuts git worktrees, so it
wants memory and disk more than cores.

| Use | Instance | Disk |
| --- | --- | --- |
| Trying it out | `t3.large` (2 vCPU, 8 GB) | 50 GB gp3 |
| A small team | `m7i-flex.xlarge` (4 vCPU, 16 GB) | 200 GB gp3 |
| Heavy use, sandboxes, big repos | `m7i-flex.2xlarge`+ | 500 GB gp3 |

Worktrees and engine state grow steadily; disk is the resource that bites first.

## Launch

This derives the AMI, VPC and subnet for whichever account and region your
credentials point at, so it works as-is:

```bash
KEY="$(cat ~/.ssh/id_ed25519.pub)"        # the key you will SSH in with
MY_IP="$(curl -s https://checkip.amazonaws.com)/32"

AMI=$(aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" \
  --query 'Subnets[0].SubnetId' --output text)

echo "account=$(aws sts get-caller-identity --query Account --output text)"
echo "region=$(aws configure get region)  vpc=$VPC  subnet=$SUBNET  ami=$AMI"

SG=$(aws ec2 create-security-group --group-name opensession \
  --description "OpenSession" --vpc-id "$VPC" --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --protocol tcp --port 22 --cidr "$MY_IP"

aws ec2 run-instances \
  --image-id "$AMI" --instance-type m7i-flex.xlarge \
  --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --associate-public-ip-address \
  --metadata-options "HttpTokens=required" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":200,"VolumeType":"gp3","DeleteOnTermination":true,"Encrypted":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=opensession}]' \
  --user-data "#cloud-config
ssh_authorized_keys:
  - $KEY" \
  --query 'Instances[0].InstanceId' --output text
```

It prints the account and region it resolved before doing anything, so you see
immediately if that is not where you meant to be.

Then get the address:

```bash
aws ec2 describe-instances --instance-ids <id> \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

### The cloud-init trap

Note the user-data above uses the **top-level `ssh_authorized_keys` module**.
The obvious-looking alternative is wrong:

```yaml
# DO NOT DO THIS
#cloud-config
users:
  - name: ubuntu
    ssh_authorized_keys: ["ssh-ed25519 ..."]
```

A `users:` list *replaces* cloud-init's default user definition. The default
carries `sudo: ALL=(ALL) NOPASSWD:ALL` and the standard group memberships, so
redefining `ubuntu` silently strips both. You get a box you can SSH into and
then cannot `sudo` on — `/etc/sudoers.d/` will contain only `README`, and `id`
will show `groups=1000(ubuntu)` and nothing else.

The failure shows up much later, as an unrelated-looking permissions error
while installing a package. If you hit it, the fix is to relaunch — you cannot
grant yourself sudo without sudo.

If you do want to declare users explicitly, keep the default:

```yaml
#cloud-config
users:
  - default
  - name: someone-else
    sudo: ALL=(ALL) NOPASSWD:ALL
```

## Install

```bash
ssh ubuntu@<address>
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/master/install.sh | bash
```

Then follow [install.md](install.md) for accounts and integrations.

## Networking

OpenSession has **no built-in authentication** (see the
[trust model](README.md#trust-model-read-this)). It binds to `127.0.0.1` by
default and trusts everyone who can reach it.

Do not open port 3850 to the internet. The two sane options:

- **Tailscale (recommended).** Install it, then set `HOST` to the box's
  tailnet IP. The UI is reachable from your devices and nothing else.
- **SSH tunnel.** Leave it on `127.0.0.1` and forward it per session:

  ```bash
  ssh -L 3850:127.0.0.1:3850 ubuntu@<address>
  # then open http://127.0.0.1:3850
  ```

The security group above opens **only** port 22, and only to your current IP.

## SSH in to debug

The box stays a normal Linux box — SSH in whenever you want to inspect or
test something. Nothing about the install hides state from you:

```bash
ssh ubuntu@<address>

opensession status          # is it running?
opensession doctor          # what is wrong
opensession logs -f         # follow the service journal
opensession version         # which commit is deployed
```

Useful paths:

| Path | What |
| --- | --- |
| `~/.opensession/src` | the checkout — a normal git repo, edit it |
| `~/.opensession/config.json` | instance config (re-read on change) |
| `~/.opensession.env` | secrets, loaded by the service |
| `~/.opensession-chats/` | session store |
| `~/worktrees/` | per-session git worktrees |

To run it in the foreground and watch it directly:

```bash
opensession stop
opensession start --foreground
```

Frontend edits rebuild live. Backend edits need `opensession restart`.

## Updating

```bash
opensession update           # fast-forward, reinstall deps, restart
opensession update --check   # show what would change, do nothing
```

Fast-forward only: if you have local commits or uncommitted edits, it stops and
tells you rather than rewriting your work.

## Tearing it down

```bash
aws ec2 terminate-instances --instance-ids <id>
aws ec2 delete-security-group --group-id <sg>   # after the instance is gone
```

The root volume is `DeleteOnTermination`, so nothing is left behind. To remove
an install without destroying the box:

```bash
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/master/install.sh | bash -s -- --uninstall
```

That stops and removes the service and the `opensession` command, and leaves
your config, secrets and sessions in place — it tells you where they are.
