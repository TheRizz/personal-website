import type { GameEvent } from "~/lib/games/volley/engine";

// Little synthesised blips for the volleyball game; no audio files to load.

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

function tone(frequency: number, duration: number, type: OscillatorType, volume = 0.12, slide = 1) {
  if (!context || context.state !== "running") return;
  const start = context.currentTime;
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

export function playEvent(event: GameEvent) {
  switch (event.type) {
    case "touch":
      tone(event.side === 0 ? 420 : 360, 0.09, "square", 0.08, 1.6);
      break;
    case "net":
      tone(140, 0.12, "triangle", 0.15, 0.7);
      break;
    case "wall":
      tone(220, 0.06, "triangle", 0.08);
      break;
    case "monkey-arrives":
      tone(900, 0.12, "sawtooth", 0.05, 1.5);
      setTimeout(() => tone(1100, 0.12, "sawtooth", 0.05, 1.4), 130);
      break;
    case "monkey-catch":
      tone(1200, 0.08, "sawtooth", 0.05, 1.3);
      break;
    case "monkey-spike":
      tone(260, 0.16, "square", 0.12, 0.5);
      break;
    case "rally-over":
      if (event.scored) {
        tone(523, 0.12, "triangle", 0.12);
        setTimeout(() => tone(784, 0.2, "triangle", 0.12), 110);
      } else tone(330, 0.22, "triangle", 0.1, 0.8);
      break;
    case "win":
      [523, 659, 784, 1047].forEach((frequency, index) =>
        setTimeout(() => tone(frequency, 0.22, "triangle", 0.12), index * 140),
      );
      break;
  }
}
