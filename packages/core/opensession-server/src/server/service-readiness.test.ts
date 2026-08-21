import { expect, test } from "bun:test";
import { serviceReadiness, setServiceReadiness } from "./service-readiness";

test("readiness follows recovery and shutdown phases", () => {
  setServiceReadiness("recovering");
  expect(serviceReadiness().phase).toBe("recovering");
  setServiceReadiness("ready");
  expect(serviceReadiness().phase).toBe("ready");
  setServiceReadiness("draining");
  expect(serviceReadiness().phase).toBe("draining");
});
