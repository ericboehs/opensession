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
Configure all lifecycle hooks on port `8080` with paths under
`/aws/lambda-microvms/runtime/v1/`, then put the resulting image ARN in
`awsLambdaMicrovm.imageIdentifier`.

The control daemon exposes structured exec, detached background exec, and file
write operations. Every request is protected by Lambda's mandatory, expiring,
port-scoped JWE token; the provider mints these through the AWS SDK.

Lambda MicroVM runtime disk survives suspend/resume but is deleted at the hard
eight-hour lifetime. This provider therefore rotates before expiry only when
the repository is clean and fully pushed, then starts a fresh engine in the new
VM. Automatic idle suspension is off by default because an agent's outbound
WebSocket does not count as endpoint activity; `idleSuspendSeconds` opts in.
Browser previews are not yet
supported because their endpoint requires authentication headers; exposing them
needs a tailnet-gated OpenSession reverse proxy with token refresh.

Do not attach a general-purpose execution role. Agent code controls the VM and
can use every permission in `executionRoleArn`; if runtime AWS access is needed,
use a dedicated least-privilege role.
