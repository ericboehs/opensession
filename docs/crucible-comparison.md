# Crucible (John Soutar) vs OpenSession — comparison & adoption plan

Investigated 2026-07-09 (read-only clone review). Crucible = tellahq/crucible: governed,
sandboxed AI agent sessions on K8s — Kata microVM isolation, Temporal-durable sessions,
DynamoDB config, S3 Object Lock audit. ~21.5k LOC Bun/TS, heavily tested, built
2026-07-02→08, NOT production-live yet (CI manual-only; warmspaces untested on real EKS).
Single engine (Claude Agent SDK). A service you run on a cluster, not a library.

## The unique takes (verdicts)

1. **Credential airlock** — agent pod NEVER holds secrets; a trusted airlock pod injects
   the model token at the network boundary; CNI NetworkPolicy means a prompt-injected
   agent "cannot call what it cannot reach". VS ours: minimal-env + ro mounts INSIDE the
   container. Theirs survives a compromised process, ours a compromised prompt.
   Verdict: better on security, heavy complexity; adopt as the PATTERN for open-source
   multi-tenant later, not now.
2. **Compiled default-deny grants** (broker → CompiledGrant, shared pure PEP, compile-time
   rejection of mis-scopes) with a **reversibility axis** (irreversible/external writes
   force-upgrade to approval) and **hash-bound approvals** (decision carries hash of exact
   action+args — what was approved is what executes, exactly once). VS ours: hand-kept
   allowlists + deniedTools + Stripe confirm cards. Verdict: their primitives
   (reversibility + hash-bound approval) are concretely better — port them; skip the
   broker/compiler until scopes have many authors.
3. **Warmspaces / golden snapshots** (the flagged bit): CSI VolumeSnapshot of the BUILT
   WORKSPACE, keyed `golden-<repo>@<sha>`, validated GREEN by a no-agent build job
   (readiness = the job's exit code, never the agent's claim; worker-authoritative pinned
   SHA; GC to newest 3; capability-gated off cleanly). VS our Workstream S: docker-commit
   of the CONTAINER LAYER, per-session, unvalidated. Verdict: genuinely complementary —
   theirs snapshots the built repo across sessions; ours snapshots toolchain per session.
   Port the pattern (repo@sha-keyed, build-validated docker images), not the CSI code.
4. **Temporal-durable sessions** — park idle at ~0 cost, exactly-once signals, durable
   wake timers, a "silent housekeeping turn" before idle teardown. Verdict: don't adopt
   Temporal; port the housekeeping-turn + durable-wake patterns into our idle-stop.
5. **Declassification-gated web research** — confidential lane (tools, no internet) +
   open lane (internet, no tools/data); deterministic identifier scrub before a question
   crosses; answers re-enter framed as untrusted data. We have nothing like it.
   Verdict: small self-contained port (declassify.ts) when agents-with-web run over
   sensitive data.

## Main differences (one line each)
Isolation: Kata microVM vs docker/daytona. Credentials: airlock-outside vs ro-mounts-inside.
Snapshots: validated workspace@sha vs per-session container layer. Durability: Temporal vs
run journal. Governance: compiled grants vs hand-kept lists. Engines: Claude-only vs
Claude+Codex+OpenCode(-first). Deploy: EKS+Temporal+DynamoDB vs one Docker host.
Maturity: 6 days old vs dogfooded daily.

## Adoption plan (ordered)
1. **M — Golden repo@sha build-validated snapshots** as a new snapshot mode in
   src/server/sandbox/ (no-agent build run of a repo-declared contract → on green,
   commit a repo@sha-keyed image reused across sessions; GC N; capability-gated).
2. **M — Reversibility axis + hash-bound approvals** generalizing STRIPE_CONFIRM_TOOLS —
   NOTE: this is also the shape of the confirm-parity the opencode automation
   migration is gated on. Consider vendoring/sharing crucible's packages/schema
   (grant/enforce) — ask John about extracting it as a library.
3. **S–M — Per-repo build contract** (.crucible.yml-style; feeds #1; replaces
   previewCommand/depsInstall config sprawl with a repo-owned file).
4. **L, LATER — Airlock pattern** for open-source multi-tenant.
5. **S, LATER — Declassify bridge**; **S — housekeeping turn + durable wake** in idle-stop.

**Crucible as a 4th SandboxProvider: NO** — it's a control plane, not a sandbox backend;
wrapping it means adopting Temporal+DynamoDB+EKS. Kata-grade isolation is what our
Daytona/E2B adapters are for.

**Not taking:** the Temporal/DynamoDB/EKS stack (contradicts one-box self-host);
the grant compiler service; S3 WORM audit (ours isn't the weak point); the Atlas routing
layer (product inspiration only). And treat all of it as unproven-in-prod — validate
anything borrowed.

## Open questions (for Michiel/John)
1. Replace, coexist, or parallel bet vs OpenSession? Changes adopt-from vs converge-toward.
2. Warmspaces on real EKS: exercised? warm vs cold timings on the fat image?
3. Why single-engine? deliberate or not-yet?
4. BYO setup-token + airlock vs the Jun-2026 subscription-billing changes — holding up?
5. Extract packages/schema (grant/enforce) as a shared governance library?
