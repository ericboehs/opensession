import { useState } from "react";
import type { SessionSafetyState } from "../lib/types";
import { Button } from "../ui/button";
import { IconShieldCheck } from "./icons";

export function SessionSafetyNotice({
  safety,
  onContinue,
  onRepair,
}: {
  safety: SessionSafetyState;
  onContinue: () => void;
  onRepair?: () => Promise<void>;
}) {
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="session-safety-title"
      className="mx-auto my-4 w-full max-w-[52rem] rounded-xl bg-yellow-soft p-4 text-fg phone:my-3 phone:rounded-lg"
    >
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-panel text-yellow">
          <IconShieldCheck size={22} />
        </div>
        <h2
          id="session-safety-title"
          className="m-0 text-item-title font-semibold"
        >
          Paused for safety
        </h2>
      </div>
      <p className="mt-3 text-pretty text-body leading-relaxed text-dim">
        {safety.explanation}
      </p>
      {repairError && (
        <p role="alert" className="mt-3 text-supporting text-red">
          {repairError}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2 phone:flex-col phone:items-stretch">
        {onRepair && safety.repairAvailable ? (
          <>
            <Button
              variant="primary"
              size="lg"
              disabled={repairing}
              onClick={() => {
                setRepairing(true);
                setRepairError(null);
                void onRepair()
                  .catch((error) =>
                    setRepairError(
                      error instanceof Error
                        ? error.message
                        : "This session could not be recovered safely.",
                    ),
                  )
                  .finally(() => setRepairing(false));
              }}
            >
              {repairing ? "Recovering" : "Continue in this session"}
            </Button>
            <Button size="lg" disabled={repairing} onClick={onContinue}>
              Continue in a new session
            </Button>
          </>
        ) : (
          <Button variant="primary" size="lg" onClick={onContinue}>
            Continue in a new session
          </Button>
        )}
      </div>
    </section>
  );
}
