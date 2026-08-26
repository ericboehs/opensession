# AWS Lambda MicroVM image

This directory is the image payload required by the experimental
`lambda-microvm` sandbox provider. Lambda MicroVMs build an ARM64 snapshot from
an S3 zip containing this `Dockerfile` and `control.py`.

Package and upload:

```sh
cd deploy/sandbox/lambda-microvm
zip -r /tmp/opensession-lambda-microvm.zip Dockerfile control.py
aws s3 cp /tmp/opensession-lambda-microvm.zip s3://YOUR_BUCKET/opensession/lambda-microvm.zip
```

Create the image with the AWS CLI, following the build-role and base-image ARN
steps in the [Lambda MicroVM image guide](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html).
Set `hooks.port` to `8080`. Set `microvmHooks.run`, `resume`, `suspend`, and
`terminate`, plus `microvmImageHooks.ready` and `validate`, to `ENABLED`. AWS
invokes their fixed routes under `/aws/lambda-microvms/runtime/v1/`. Put the
resulting image ARN in `awsLambdaMicrovm.imageIdentifier`.

This provider is not live-certified, so it is hidden from the picker and
rejected for new sessions. Run its live certification matrix after provisioning
the image:

```sh
bun run deploy/sandbox/conformance.ts lambda-microvm
```

The Open Session host needs ambient AWS credentials for the MicroVM lifecycle
and token APIs, plus `iam:PassRole` when `executionRoleArn` is set. The VM must
also be able to reach a configured public ingress or `callbackBaseUrl`.

The control daemon exposes structured exec, detached background exec, and file
write operations. Every request is protected by Lambda's mandatory, expiring,
port-scoped JWE token; the provider mints these through the AWS SDK.

Lambda MicroVM runtime disk survives suspend/resume but is discarded when the
VM terminates. Open Session requests an eight-hour lifetime by default;
`maximumDurationSeconds` can shorten it, with an effective range of one to eight
hours. On `ensure()`, once the VM is within `min(30 minutes, 10% of its
configured lifetime)` of expiry, the provider rotates only if the branch has an
upstream, the worktree is clean, and no local commits are ahead. It does not
rotate proactively during an active turn.

Automatic idle suspension is off by default because an agent's outbound
WebSocket does not count as endpoint activity; `idleSuspendSeconds` opts in.
Browser previews use Open Session's authenticated outbound Portal relay rather
than the raw AWS endpoint. The relay uses the same configured public ingress or
VM-reachable `callbackBaseUrl`.

Do not attach a general-purpose execution role. Agent code controls the VM and
can use every permission in `executionRoleArn`; if runtime AWS access is needed,
use a dedicated least-privilege role.
