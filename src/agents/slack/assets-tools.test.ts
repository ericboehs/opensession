import { describe, expect, test } from "bun:test";
import { formatImportedAssetMessage, isVideoAssetPath } from "./assets-tools";

describe("isVideoAssetPath", () => {
	test("recognizes common video extensions", () => {
		expect(isVideoAssetPath("demo.mp4")).toBe(true);
		expect(isVideoAssetPath("clip.WEBM")).toBe(true);
		expect(isVideoAssetPath("/abs/path/recording.mov")).toBe(true);
	});

	test("does not treat images or other files as video", () => {
		expect(isVideoAssetPath("screenshot.png")).toBe(false);
		expect(isVideoAssetPath("report.html")).toBe(false);
		expect(isVideoAssetPath("no-extension")).toBe(false);
	});
});

describe("formatImportedAssetMessage (import_remote_asset output)", () => {
	test("prints a BACKSTAGE_VIDEO marker with the local absolute path for video imports", () => {
		const msg = formatImportedAssetMessage({
			remoteAbsPath: "/Users/runner/ws/.build/opensession/artifacts/demo.mp4",
			localRelPath: "demo.mp4",
			localAbsPath: "/home/ubuntu/.opensession-assets/bks-1/demo.mp4",
			size: 1234,
		});
		expect(msg).toContain(
			"Imported /Users/runner/ws/.build/opensession/artifacts/demo.mp4",
		);
		expect(msg).toContain("demo.mp4");
		expect(msg).toContain("BACKSTAGE_VIDEO: /home/ubuntu/.opensession-assets/bks-1/demo.mp4");
		// jsonl-parser.ts's VIDEO_MARKER requires the marker on its own line,
		// with no trailing text after the path.
		const markerLine = msg.split("\n").find((l) => l.startsWith("BACKSTAGE_VIDEO:"));
		expect(markerLine).toBe("BACKSTAGE_VIDEO: /home/ubuntu/.opensession-assets/bks-1/demo.mp4");
	});

	test("omits the video marker for non-video imports (e.g. images)", () => {
		const msg = formatImportedAssetMessage({
			remoteAbsPath: "/Users/runner/ws/screenshot.png",
			localRelPath: "screenshot.png",
			localAbsPath: "/home/ubuntu/.opensession-assets/bks-1/screenshot.png",
			size: 42,
		});
		expect(msg).not.toContain("BACKSTAGE_VIDEO");
		expect(msg).toContain("visible in this session's Assets tab now");
	});
});
