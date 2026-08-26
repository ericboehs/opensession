const { describe, expect, test } = require("bun:test");
const { commandFrame, validID } = require("./native-dictation");

describe("native dictation protocol", () => {
  test("frames Float32 audio for the Swift helper", () => {
    const samples = new Float32Array([0.25, -0.5]);
    const frame = commandFrame(1, samples);
    expect(frame[0]).toBe(1);
    expect(frame.readUInt32LE(1)).toBe(samples.byteLength);
    expect(frame.readFloatLE(5)).toBeCloseTo(0.25);
    expect(frame.readFloatLE(9)).toBeCloseTo(-0.5);
  });

  test("frames a payload-free stop command", () => {
    expect([...commandFrame(2)]).toEqual([2, 0, 0, 0, 0]);
  });

  test("accepts generated request IDs and rejects IPC junk", () => {
    expect(validID("25e5a2a1-65b7-40b5-b0ef-583a2677d595")).toBe(true);
    expect(validID("../helper")).toBe(false);
    expect(validID(42)).toBe(false);
  });
});
