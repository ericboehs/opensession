# Screenshots

All were captured from an isolated demo instance. Start one with
`WEBAPP_PORT=3900 ./.agents/start.sh`; the script sets `OPENSESSION_DEV=1`,
`OPENSESSION_DEMO=1` and an isolated `OPENSESSION_STATE_DIR`. Everything in
frame is synthetic: fictional teammates, a fictional `acme-todo` repo and a
fictional PR #128.

**Naming note:** These captures predate the **Home** to **Pull requests** and
**Create workspace** to **New session** renames. The current interface uses the
latter names.

## A session, mid-run

The transcript streams as the agent works — plan, tool calls, a command that
failed, and the recovery. The composer queues your next prompt behind the
running turn.

![](screenshots/session-running.png)

## When the agent needs you

A question pauses the run and surfaces as a card: pick an option or write your
own answer, and the turn continues.

![](screenshots/session-needs-input.png)

## The work it produced

Repository-backed code sessions show their branch and working-tree status.
When a PR exists, the session also shows its merge state, checks and changed
files without leaving the session.

![](screenshots/session-pr.png)

## Changes

The working-tree diff next to the transcript that produced it.

![](screenshots/session-changes.png)

## Reviewing the pull request

The full review surface: conversation, commits, checks and a split-view diff,
with line comments batched into one review.

![](screenshots/pr-review.png)

## Pull requests

Pull requests across your repos, with search and filters for person, workspace
and repo. The sidebar groups work into needs input, in progress, ready to merge,
backlog and done.

![](screenshots/home.png)

## Starting work

Pick a repo, a branch mode, a model and an effort level, then describe the job.

![](screenshots/new-session.png)

## Automations

Scheduled and webhook-triggered agent runs, each with its own history.

![](screenshots/automations.png)

## On a phone

The same UI, installed as a PWA — read a running session and steer it from
anywhere.

<img src="screenshots/mobile.png" width="320" alt="">
