import type { GameEvent } from "@site/tycoon-core";

// Synthesised blips, no audio files. Muted by default (docs/04-pipeline-tycoon.md §1); the
// choice lives in settings.ts.

let context: AudioContext | null = null;

/** Creates or resumes the audio context; call from a tap or key press so browsers allow it. */
export function unlockAudio() {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
  } catch {
    context = null;
  }
}

function tone(
  frequency: number,
  duration: number,
  type: OscillatorType,
  volume = 0.06,
  slide = 1,
  delay = 0,
) {
  if (!context || context.state !== "running") return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * slide, start + duration);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

/** A soft two-note chime when a golden packet appears (catching it plays the brighter run). */
export function playGoldenChime() {
  tone(1319, 0.25, "sine", 0.035);
  tone(1760, 0.35, "sine", 0.03, 1, 0.12);
}

export function playEvent(event: GameEvent) {
  switch (event.type) {
    case "click":
      tone(660 + Math.random() * 80, 0.05, "square", 0.03, 1.3);
      break;
    case "buy":
      tone(440, 0.07, "triangle", 0.06, 1.5);
      tone(660, 0.09, "triangle", 0.05, 1.2, 0.06);
      break;
    case "upgrade":
      [523, 659, 784].forEach((f, i) => tone(f, 0.1, "triangle", 0.05, 1, i * 0.06));
      break;
    case "golden":
      [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, "sine", 0.06, 1, i * 0.07));
      break;
    case "achievement":
      tone(880, 0.15, "sine", 0.05, 1.5);
      break;
    case "migrate":
      tone(220, 0.6, "sawtooth", 0.04, 4);
      break;
    case "ending":
      [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(f, 0.4, "triangle", 0.05, 1, i * 0.15));
      break;
    case "dropped":
      break;
  }
}
