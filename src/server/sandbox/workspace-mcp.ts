/**
 * opensession-workspace — the "hands" half of an engine-outside-sandbox run.
 *
 * The OpenCode model loop, provider auth, and conversation state stay on the
 * OpenSession host. These explicit tools execute against the session's
 * Sandbox handle, so the model can work in Docker/Daytona/Modal/etc. without
 * receiving provider credentials or a host mount of the remote filesystem.
 *
 * Callers MUST also set RunAgentOpts.disableLocalWorkspaceTools. Otherwise
 * OpenCode's built-in read/write/edit/bash tools would still target the
 * engine's neutral host cwd and create a dangerous split-brain workspace.
 */

import { dirname, isAbsolute, posix } from "path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "../inprocess-mcp";
import type { Sandbox } from "./provider";

const OUTPUT_LIMIT = 120_000;
const EDIT_FILE_LIMIT = 5 * 1024 * 1024;

function shellQuoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

function text(value: string, isError = false) {
  return {
    content: [{ type: "text" as const, text: value }],
    ...(isError ? { isError: true } : {}),
  };
}

function clipped(value: string): string {
  if (value.length <= OUTPUT_LIMIT) return value;
  return `${value.slice(0, OUTPUT_LIMIT)}\n\n[output truncated after ${OUTPUT_LIMIT} characters]`;
}

function workspacePath(sandbox: Sandbox, input: string): string {
  const value = input.trim();
  if (!value || value === ".") return sandbox.cwd;
  return isAbsolute(value) ? posix.normalize(value) : posix.resolve(sandbox.cwd, value);
}

async function writeContent(sandbox: Sandbox, path: string, content: string) {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  const parent = dirname(path);
  return sandbox.exec([
    "sh",
    "-lc",
    `mkdir -p -- ${shellQuoteWord(parent)} && printf '%s' ${shellQuoteWord(encoded)} | base64 -d > ${shellQuoteWord(path)}`,
  ]);
}

function commandResult(result: { exitCode: number; stdout: string; stderr: string }) {
  const chunks = [
    `exit code: ${result.exitCode}`,
    result.stdout ? `stdout:\n${clipped(result.stdout)}` : "",
    result.stderr ? `stderr:\n${clipped(result.stderr)}` : "",
  ].filter(Boolean);
  return text(chunks.join("\n\n"), result.exitCode !== 0);
}

type SandboxSource = Sandbox | (() => Promise<Sandbox>);

async function resolved(source: SandboxSource): Promise<Sandbox> {
  return typeof source === "function" ? source() : source;
}

export function createRemoteWorkspaceMcpServer(source: SandboxSource) {
  return createSdkMcpServer({
    name: "opensession-workspace",
    version: "1.0.0",
    tools: [
      tool(
        "execute",
        "Run a shell command inside the session sandbox, in the remote workspace root. Use this for builds, tests, git, package managers, and other commands. The command never runs on the OpenSession host.",
        {
          command: z.string().min(1).describe("Shell command to run inside the sandbox."),
        },
        async ({ command }) => {
          const sandbox = await resolved(source);
          const result = await sandbox.exec(["sh", "-lc", command]);
          return commandResult(result);
        },
      ),
      tool(
        "read_file",
        "Read a UTF-8 text file from the sandbox workspace with line numbers. Relative paths resolve from the remote workspace root.",
        {
          path: z.string().min(1),
          offset: z.number().int().min(1).default(1).describe("First line to return (1-based)."),
          limit: z.number().int().min(1).max(5000).default(1000).describe("Maximum lines to return."),
        },
        async ({ path, offset, limit }) => {
          const sandbox = await resolved(source);
          const target = workspacePath(sandbox, path);
          const end = offset + limit - 1;
          const result = await sandbox.exec([
            "sh",
            "-lc",
            `sed -n ${shellQuoteWord(`${offset},${end}p`)} ${shellQuoteWord(target)} | nl -ba -v ${offset}`,
          ]);
          return commandResult(result);
        },
      ),
      tool(
        "write_file",
        "Create or replace a UTF-8 text file in the sandbox workspace. Parent directories are created automatically.",
        {
          path: z.string().min(1),
          content: z.string(),
        },
        async ({ path, content }) => {
          const sandbox = await resolved(source);
          const target = workspacePath(sandbox, path);
          const result = await writeContent(sandbox, target, content);
          if (result.exitCode !== 0) return commandResult(result);
          return text(`Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${target}.`);
        },
      ),
      tool(
        "edit_file",
        "Replace one exact text occurrence in a UTF-8 file inside the sandbox. Fails when the old text is missing or occurs more than once, so edits cannot silently hit the wrong location.",
        {
          path: z.string().min(1),
          old_text: z.string().min(1),
          new_text: z.string(),
        },
        async ({ path, old_text, new_text }) => {
          const sandbox = await resolved(source);
          const target = workspacePath(sandbox, path);
          const size = await sandbox.exec(["wc", "-c", target]);
          const bytes = Number.parseInt(size.stdout.trim(), 10);
          if (size.exitCode !== 0 || !Number.isFinite(bytes)) return commandResult(size);
          if (bytes > EDIT_FILE_LIMIT) {
            return text(
              `Refusing to edit ${target}: ${bytes} bytes exceeds the ${EDIT_FILE_LIMIT}-byte edit_file limit. Use execute with a purpose-built script instead.`,
              true,
            );
          }
          const encoded = await sandbox.exec(["base64", target]);
          if (encoded.exitCode !== 0) return commandResult(encoded);
          const current = Buffer.from(encoded.stdout.replace(/\s/g, ""), "base64").toString("utf-8");
          const first = current.indexOf(old_text);
          const second = first < 0 ? -1 : current.indexOf(old_text, first + old_text.length);
          if (first < 0) return text(`old_text was not found in ${target}.`, true);
          if (second >= 0) {
            return text(`old_text occurs more than once in ${target}; include more context.`, true);
          }
          const next = current.slice(0, first) + new_text + current.slice(first + old_text.length);
          const written = await writeContent(sandbox, target, next);
          if (written.exitCode !== 0) return commandResult(written);
          return text(`Updated ${target}.`);
        },
      ),
      tool(
        "grep",
        "Search file contents inside the sandbox workspace with ripgrep. Returns file paths, line numbers, and matching lines.",
        {
          pattern: z.string().min(1),
          path: z.string().default("."),
          glob: z.string().optional().describe("Optional ripgrep glob such as '*.ts' or '!dist/**'."),
        },
        async ({ pattern, path, glob }) => {
          const sandbox = await resolved(source);
          const target = workspacePath(sandbox, path);
          const args = ["rg", "-n", "--hidden", "--glob", "!.git/**"];
          if (glob) args.push("--glob", glob);
          args.push("--", pattern, target);
          const result = await sandbox.exec(args);
          // ripgrep uses 1 for a clean "no matches" result.
          if (result.exitCode === 1 && !result.stderr) return text("No matches.");
          return commandResult(result);
        },
      ),
      tool(
        "glob",
        "List files in the sandbox workspace matching a ripgrep glob, such as 'src/**/*.ts'.",
        {
          pattern: z.string().min(1),
          path: z.string().default("."),
        },
        async ({ pattern, path }) => {
          const sandbox = await resolved(source);
          const target = workspacePath(sandbox, path);
          const result = await sandbox.exec([
            "rg",
            "--files",
            "--hidden",
            "--glob",
            "!.git/**",
            "--glob",
            pattern,
            target,
          ]);
          if (result.exitCode === 1 && !result.stderr) return text("No matching files.");
          return commandResult(result);
        },
      ),
    ],
  });
}

export function remoteWorkspaceInstructions(sandbox: Sandbox): string {
  return [
    "## Remote sandbox workspace",
    "",
    `Your coding workspace is ${sandbox.cwd} inside the ${sandbox.provider} sandbox.`,
    "Your model loop runs outside that sandbox. OpenCode's local filesystem and shell tools are disabled.",
    "Use the opensession-workspace tools for every file read, search, edit, command, build, test, and git operation.",
    "Do not infer workspace state from the engine's host cwd; it is an empty control directory and is not the user's repository.",
  ].join("\n");
}
