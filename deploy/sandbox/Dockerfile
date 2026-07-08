# backstage-runner — prebaked image for the Docker sandbox provider (sandboxes-plan.md §5 Phase 1)
#
# Contains the exact toolchain a Backstage runner needs to execute an agent run
# inside a container: bun (pinned to host), node LTS, git, gh, ripgrep, the Claude
# Code CLI (pinned to host, at the identical host path), and the backstage runner
# bundle with node_modules — which vendors the codex binary (@openai/codex-linux-x64)
# and the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
#
# PATH PARITY IS LOAD-BEARING. The runner config points at
# /home/ubuntu/.local/bin/claude and /home/ubuntu/projects/tella-backstage, and the
# session worktree is bind-mounted at its identical host path. So this image must
# reproduce those absolute paths exactly and run as uid 1000 (host `ubuntu`) so
# bind-mounted files keep sane ownership.
#
# Build context is the REPO ROOT (see build.sh); a root .dockerignore trims it.

FROM ubuntu:24.04

# --- version pins (bump these when the host bumps; see README) ---
ARG BUN_VERSION=1.3.14
ARG CLAUDE_VERSION=2.1.204
ARG NODE_MAJOR=20

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# --- system packages ---
# ripgrep lives in universe (enabled by default in the ubuntu image). python3 +
# build-essential are for worktrees whose `bun install` builds native deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        unzip \
        xz-utils \
        python3 \
        build-essential \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js LTS (NodeSource) ---
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- GitHub CLI (official apt repo) ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- Bun (pinned), installed system-wide ---
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/bun bash -s "bun-v${BUN_VERSION}" \
    && ln -s /usr/local/bun/bin/bun /usr/local/bin/bun \
    && ln -s /usr/local/bun/bin/bun /usr/local/bin/bunx \
    && bun --version

# --- run as the host-matching uid 1000 user `ubuntu` (ships in ubuntu:24.04) ---
# Prepare the exact absolute paths the runner expects, owned by ubuntu.
RUN mkdir -p /home/ubuntu/.local/bin \
             /home/ubuntu/.claude \
             /home/ubuntu/projects/tella-backstage \
    && chown -R ubuntu:ubuntu /home/ubuntu

# Minimal ~/.claude so settingSources:["user"] doesn't error.
RUN echo '{}' > /home/ubuntu/.claude/settings.json \
    && chown ubuntu:ubuntu /home/ubuntu/.claude/settings.json

ENV HOME=/home/ubuntu \
    PATH=/home/ubuntu/.local/bin:/usr/local/bun/bin:/usr/local/bin:/usr/bin:/bin

USER ubuntu

# --- Claude Code CLI (pinned to host version, installed at the identical host path) ---
# The official installer drops the binary under ~/.local/share/claude and symlinks
# ~/.local/bin/claude -> it, matching /home/ubuntu/.local/bin/claude on the host.
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && /home/ubuntu/.local/bin/claude --version

# --- backstage runner bundle ---
# Deps first for layer caching: only re-installs when package.json / bun.lock change.
WORKDIR /home/ubuntu/projects/tella-backstage
COPY --chown=ubuntu:ubuntu package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source at the identical absolute path (worktrees are bind-mounted separately).
COPY --chown=ubuntu:ubuntu tsconfig.json backstage.ts ./
COPY --chown=ubuntu:ubuntu src ./src

WORKDIR /home/ubuntu

# Containers are started long-lived and `docker exec`'d into (one per session).
CMD ["sleep", "infinity"]
