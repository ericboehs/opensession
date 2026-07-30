/**
 * opensession-nodes — lets a session run a command on an attached execution node.
 *
 * The case this exists for: an iOS build needs macOS with Xcode, a Windows build
 * needs MSVC, and the server is on Linux. Sandboxes do not help — they are
 * ephemeral Linux containers. A node is a persistent machine someone attached on
 * purpose with `opensession connect`.
 *
 * Wired exactly like opensession-sessions and opensession-repos: **interactive
 * runs only, never automations.** That gate is the main thing standing between
 * "an agent can build on the Mac" and "untrusted ticket text can run commands on
 * the Mac". The run-rpc builder fails closed for automation-owned sessions, so
 * even a resumed automation session cannot reach these tools.
 *
 * A command here runs as the node's user with that user's privileges. There is
 * no sandbox on the far side — attaching a node is a deliberate act of trust,
 * and the tool description says so to the model as well as to the reader.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { listNodes } from "../../server/nodes";
import { execOnNode, isNodeConnected } from "../../server/node-ws";

/** Resolve by id, exact name, or unique capability — models are given names. */
function resolveNode(query: string): { id: string; name: string } | { error: string } {
  const wanted = query.trim();
  if (!wanted) return { error: "name a node (see list_nodes)" };

  const nodes = listNodes();
  if (!nodes.length) {
    return { error: "no nodes are attached — run `opensession nodes pair` on the server" };
  }

  const byId = nodes.find((n) => n.id === wanted);
  if (byId) return { id: byId.id, name: byId.name };

  const byName = nodes.filter((n) => n.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return { id: byName[0].id, name: byName[0].name };
  if (byName.length > 1) {
    return { error: `'${wanted}' matches ${byName.length} nodes — use the node id` };
  }

  const byCapability = nodes.filter((n) =>
    n.capabilities.some((c) => c.toLowerCase() === wanted.toLowerCase()),
  );
  if (byCapability.length === 1) return { id: byCapability[0].id, name: byCapability[0].name };
  if (byCapability.length > 1) {
    return {
      error:
        `'${wanted}' matches ${byCapability.length} nodes by capability ` +
        `(${byCapability.map((n) => n.name).join(", ")}) — name one`,
    };
  }

  return {
    error: `no node called '${wanted}'. Attached: ${nodes.map((n) => n.name).join(", ") || "none"}`,
  };
}

export function createNodesMcpServer() {
  return createSdkMcpServer({
    name: "opensession-nodes",
    version: "1.0.0",
    tools: [
      tool(
        "list_nodes",
        "List machines attached to this OpenSession server that can run commands " +
          "(macOS, Linux, Windows). Use this when work needs a platform or toolchain " +
          "this server does not have — an Xcode build, a Windows compile, a specific " +
          "GPU. Shows which are online right now.",
        {},
        async () => {
          const nodes = listNodes();
          if (!nodes.length) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "No execution nodes are attached.\n\n" +
                    "An operator attaches one by running `opensession nodes pair` on the " +
                    "server and `opensession connect` on the target machine.",
                },
              ],
            };
          }

          const lines = nodes.map((n) => {
            const online = isNodeConnected(n.id);
            const seen = n.lastSeenAt ? ` last seen ${n.lastSeenAt}` : "";
            return (
              `- ${n.name} (${n.platform}/${n.arch}) — ${online ? "ONLINE" : "offline"}${online ? "" : seen}\n` +
              `    id: ${n.id}\n` +
              `    can: ${n.capabilities.join(", ") || "nothing detected"}`
            );
          });

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${nodes.length} node(s):\n\n${lines.join("\n")}\n\n` +
                  "Only ONLINE nodes can run commands. Use run_on_node with the name or id.",
              },
            ],
          };
        },
      ),

      tool(
        "run_on_node",
        "Run a shell command on an attached machine and wait for it to finish. " +
          "Use for work that cannot happen on this server — building an iOS app on a " +
          "Mac, compiling on Windows. The command runs as that machine's user with " +
          "their privileges and is NOT sandboxed, so treat it exactly as you would a " +
          "command on your own machine: no destructive operations, and nothing you " +
          "could not justify to the machine's owner.",
        {
          node: z
            .string()
            .describe("Node name, id, or a unique capability such as 'xcode' (see list_nodes)"),
          command: z.string().describe("Shell command, run through bash -lc"),
          cwd: z.string().optional().describe("Working directory on the node"),
          timeoutSeconds: z
            .number()
            .optional()
            .describe("Give up after this long (default 600, max 3600)"),
        },
        async (args: {
          node: string;
          command: string;
          cwd?: string;
          timeoutSeconds?: number;
        }) => {
          const resolved = resolveNode(args.node);
          if ("error" in resolved) {
            return { content: [{ type: "text" as const, text: resolved.error }] };
          }
          if (!isNodeConnected(resolved.id)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${resolved.name} is attached but not currently online, so nothing can ` +
                    `run on it. Someone needs to start \`opensession node run\` there ` +
                    `(it may be a laptop that is asleep).`,
                },
              ],
            };
          }

          const timeoutMs = Math.min(Math.max((args.timeoutSeconds ?? 600) * 1000, 1_000), 3_600_000);

          try {
            const result = await execOnNode(resolved.id, args.command, {
              cwd: args.cwd,
              timeoutMs,
            });

            const parts = [`${resolved.name}: exit ${result.code}${result.timedOut ? " (TIMED OUT)" : ""}`];
            if (result.stdout.trim()) parts.push(`\nstdout:\n${result.stdout.trimEnd()}`);
            if (result.stderr.trim()) parts.push(`\nstderr:\n${result.stderr.trimEnd()}`);
            if (!result.stdout.trim() && !result.stderr.trim()) parts.push("\n(no output)");

            return { content: [{ type: "text" as const, text: parts.join("\n") }] };
          } catch (err) {
            return {
              content: [
                { type: "text" as const, text: `could not run on ${resolved.name}: ${(err as Error).message}` },
              ],
            };
          }
        },
      ),
    ],
  });
}
