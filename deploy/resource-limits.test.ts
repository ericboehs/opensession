import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

describe("host resource-limit deployment", () => {
  test("the aggregate user slice reserves host headroom", async () => {
    const slice = await Bun.file(
      resolve(import.meta.dir, "systemd/user/opensession.slice"),
    ).text();

    expect(slice).toContain("MemoryHigh=72G");
    expect(slice).toContain("MemoryMax=88G");
    expect(slice).toContain("MemorySwapMax=4G");
    expect(slice).toContain("TasksMax=8192");
  });

  test("the coordinator has an independent final fuse", async () => {
    const dropIn = await Bun.file(
      resolve(import.meta.dir, "systemd/opensession.service.d/resources.conf"),
    ).text();

    expect(dropIn).toContain("MemoryHigh=16G");
    expect(dropIn).toContain("MemoryMax=24G");
    expect(dropIn).toContain("OOMPolicy=stop");
  });

  test("the authoritative kernel has an independent memory fuse", async () => {
    const dropIn = await Bun.file(
      resolve(
        import.meta.dir,
        "systemd/opensession-session-kernel.service.d/capacity.conf",
      ),
    ).text();

    expect(dropIn).toContain("MemoryHigh=4G");
    expect(dropIn).toContain("MemoryMax=6G");
    expect(dropIn).toContain("MemorySwapMax=1G");
    expect(dropIn).toContain("OOMPolicy=stop");
    expect(dropIn).not.toContain("EnvironmentFile=");
  });

  test("the host deploy installs all resource-control units", async () => {
    const deploy = await Bun.file(resolve(repoRoot, "deploy/deploy.sh")).text();

    expect(deploy).toContain("deploy/systemd/opensession.service.d/resources.conf");
    expect(deploy).toContain(
      "deploy/systemd/opensession-session-kernel.service.d/capacity.conf",
    );
    expect(deploy).toContain("deploy/systemd/user/opensession.slice");
    expect(deploy).toContain("systemctl --user start opensession.slice");
  });
});
