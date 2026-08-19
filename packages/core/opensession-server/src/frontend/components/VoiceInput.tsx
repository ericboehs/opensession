import React, { useEffect, useRef, useState } from "react";
import { transcribeClip } from "../lib/api";
import { IconCheck, IconMic, IconPlus, IconX } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { PRODUCT_NAME } from "../lib/brand";
import { paletteIconBtn } from "../lib/palette-classes";

type Phase = "idle" | "recording" | "transcribing";

/** Dictation is capped — this is a session input, not a memo recorder. */
const MAX_SECONDS = 120;
const BAR_COUNT = 72;

/* The recording bar's chrome. Every variant is written out in full rather than
   composed from a fragment: Tailwind scans source text, so a class assembled
   from a variable is never generated. */

const OVERLAY =
	"absolute inset-x-0 bottom-0 z-[6] flex h-[54px] items-center gap-2.5 rounded-b-xl border-t border-line bg-raised py-0 pl-3 pr-3.5";

/* Waveform bars. Colour lives on the variant, never alongside a second colour
   utility on the same element — two of those don't compose, the sheet's order
   decides the winner. Bars without a sample yet are a 2px baseline dot; live
   ones get their height inline from the level meter. */
const WAVE_BAR_IDLE = "mx-auto h-0.5 w-0.5 min-w-0 max-w-0.5 flex-1 rounded-xs bg-faint";
const WAVE_BAR_LIVE =
	"mx-auto h-0.5 w-0.5 min-w-0 max-w-0.5 flex-1 rounded-xs bg-dim transition-[height] duration-[90ms] ease-linear";

/* Plain glyph buttons — no fill, no border; the ✓ picks up the accent. */
const GLYPH_CANCEL =
	"inline-flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-dim transition-colors hover:bg-hover hover:text-fg";
const GLYPH_ACCEPT =
	"inline-flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-fg transition-colors hover:bg-hover hover:text-accent";

/* The `voice-spinner` hook is gone: base.css's reduced-motion block used to
   name it to pin the rotation to a constant 0.8s, but that block now matches
   `[class*="animate-spin"]` — the utility itself — and pins the same 0.8s, so
   the name earned nothing. Measured both ways, plain and under emulated
   reduced motion, before removing it. The border is written one side at a time
   on purpose — a `border-color` shorthand next to a `border-top-color` is the
   same two-utilities-one-property race as the waveform colours above. */
const SPINNER =
	"h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-l-line-strong border-r-line-strong border-b-line-strong border-t-dim [animation-duration:0.8s]";

/**
 * Wispr-Flow-style dictation control shared by the session Composer and the
 * New-session palette. Idle it's just a mic button; tapping it swaps the whole
 * input surface for a compact recording bar (+ lead, live waveform, cancel ×,
 * accept ↑), then a "Transcribing…" bar while the clip runs through
 * /api/transcribe, and finally hands the text to `onText`.
 *
 * The bar renders as an absolutely-positioned overlay filling the nearest
 * positioned ancestor, so the host container must be positioned: `.composer`
 * in the session view, and the palette's Modal.Content, whose `variant="palette"`
 * carries `relative` for exactly this.
 */
export function VoiceInput({
  onText,
  disabled,
  className = paletteIconBtn,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
  /** Classes for the idle mic button. Both hosts pass their own: the
   *  new-session footer so the mic keeps the sizing its neighbours get there,
   *  the composer so it turns into a circle with the "+" in the resting
   *  pill. */
  className?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const acceptRef = useRef(false);
  const timersRef = useRef<number[]>([]);

  function cleanup() {
    timersRef.current.forEach((t) => clearInterval(t));
    timersRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    recRef.current = null;
  }
  useEffect(() => cleanup, []);

  // Errors show as a small bubble above the control; clear themselves.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  async function start() {
    setError(null);
    // getUserMedia only exists in secure contexts — over plain http (the
    // :3850 hostname) the mic simply isn't there.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(`Mic needs HTTPS. Open ${PRODUCT_NAME} at its ts.net URL.`);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setError("Microphone permission denied");
      return;
    }
    streamRef.current = stream;
    // Chrome/Firefox record webm/opus; iOS Safari only does mp4/AAC. The
    // server transcodes whatever container we send.
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
        MediaRecorder.isTypeSupported?.(m),
      ) || "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recRef.current = rec;
    chunksRef.current = [];
    acceptRef.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const accepted = acceptRef.current;
      const blob = new Blob(chunksRef.current, {
        type: rec.mimeType || mime || "audio/webm",
      });
      cleanup();
      if (accepted) void finish(blob);
      else setPhase("idle");
    };

    // Live level meter for the waveform — progressive enhancement, recording
    // works fine without it.
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      timersRef.current.push(
        window.setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setLevels((prev) => [...prev.slice(-(BAR_COUNT - 1)), Math.min(1, rms * 4)]);
        }, 90),
      );
    } catch {
      // no waveform, no problem
    }

    const startedAt = Date.now();
    setLevels([]);
    timersRef.current.push(
      window.setInterval(() => {
        if (Date.now() - startedAt >= MAX_SECONDS * 1000) stop(true);
      }, 1000),
    );
    rec.start(250);
    setPhase("recording");
  }

  function stop(accept: boolean) {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") return;
    acceptRef.current = accept;
    if (accept) setPhase("transcribing");
    rec.stop();
  }

  async function finish(blob: Blob) {
    try {
      const text = await transcribeClip(blob);
      if (text) onText(text);
      else setError("Heard nothing. Try again.");
    } catch (e: any) {
      setError(e?.message || "Transcription failed");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <>
      <Tooltip label="Dictate">
        <button
          type="button"
          className={className}
          onClick={start}
          disabled={disabled || phase !== "idle"}
          aria-label="Dictate"
        >
          <IconMic size={22} />
        </button>
      </Tooltip>
      {error && phase === "idle" && (
        <div className="absolute bottom-[calc(100%+8px)] right-0 z-[7] whitespace-nowrap rounded-control border border-[color-mix(in_srgb,var(--red)_40%,transparent)] bg-red-soft px-[11px] py-[7px] text-supporting font-medium text-red">
          {error}
        </div>
      )}
      {phase !== "idle" && (
        <div className={OVERLAY}>
          <span className="inline-flex shrink-0 items-center text-faint" aria-hidden="true">
            <IconPlus size={22} />
          </span>
          {phase === "recording" ? (
            <>
              {/* Full-width track: baseline dots on the quiet/older left, live
                  bars accumulating on the right by the accept button. */}
              <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden" aria-hidden="true">
                {Array.from({ length: BAR_COUNT }, (_, i) => {
                  const l = levels[levels.length - BAR_COUNT + i];
                  const active = l !== undefined;
                  return (
                    <span
                      key={i}
                      className={active ? WAVE_BAR_LIVE : WAVE_BAR_IDLE}
                      style={{ height: active ? `${16 + l * 84}%` : undefined }}
                    />
                  );
                })}
              </div>
              <Tooltip label="Cancel">
                <button
                  type="button"
                  className={GLYPH_CANCEL}
                  onClick={() => stop(false)}
                  aria-label="Cancel dictation"
                >
                  <IconX size={22} />
                </button>
              </Tooltip>
              <Tooltip label="Stop and transcribe">
                <button
                  type="button"
                  className={GLYPH_ACCEPT}
                  onClick={() => stop(true)}
                  aria-label="Stop and transcribe"
                >
                  <IconCheck size={22} />
                </button>
              </Tooltip>
            </>
          ) : (
            <>
              <span className={SPINNER} aria-hidden="true" />
              <span className="shrink-0 text-label font-medium text-dim">Transcribing…</span>
              <span className="flex-1" />
            </>
          )}
        </div>
      )}
    </>
  );
}
