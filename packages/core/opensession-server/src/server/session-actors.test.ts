import { describe, expect, test } from "bun:test";
import {
	agentActor,
	delegatedActorParent,
	isMachineActor,
	isWorkerActor,
	machineActorLabel,
	workerActor,
} from "./session-actors";

const SESSION = "os-019fe194-5fbe-7000-a81e-d0a656ad77f4";

describe("machine actors", () => {
	// The shapes measured on the live store the day Analytics was reporting 31
	// humans for a 7-person team. Each one used to land in the People table.
	test("recognizes every sentinel our own code mints", () => {
		for (const actor of [
			"auto-continue",
			"system (restart)",
			"Automation",
			"GitHub",
			workerActor(SESSION),
			agentActor(SESSION),
		]) {
			expect(isMachineActor(actor)).toBe(true);
		}
	});

	test("leaves people alone", () => {
		for (const name of ["Kent", "Michiel Westerbeek", "Louise", "", null]) {
			expect(isMachineActor(name)).toBe(false);
		}
	});

	test("matches the agent's own name across an ornament change", () => {
		// The persona was renamed "OS¹" → "OS"; sessions started under the old
		// mark must not become a person on the strength of a superscript.
		expect(isMachineActor("OS¹")).toBe(true);
		expect(isMachineActor("OS")).toBe(true);
	});

	test("a delegated sender names its parent", () => {
		expect(delegatedActorParent(workerActor(SESSION))).toBe(SESSION);
		expect(delegatedActorParent(agentActor(SESSION))).toBe(SESSION);
		expect(delegatedActorParent("worker Kent")).toBe(null);
		expect(delegatedActorParent("Kent")).toBe(null);
	});

	test("worker and agent senders are not interchangeable", () => {
		// Only a worker's report is delivered verbatim; the other is wrapped.
		expect(isWorkerActor(workerActor(SESSION))).toBe(true);
		expect(isWorkerActor(agentActor(SESSION))).toBe(false);
	});

	test("delegated senders collapse to one label, not one row per session", () => {
		expect(machineActorLabel(workerActor(SESSION))).toBe("Worker sessions");
		expect(machineActorLabel(agentActor(SESSION))).toBe("Agent sessions");
		expect(machineActorLabel("auto-continue")).toBe("Auto-continue");
		expect(machineActorLabel("Automation")).toBe("Automation");
	});
});
