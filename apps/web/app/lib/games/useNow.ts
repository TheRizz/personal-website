import { useSyncExternalStore } from "react";

// One shared clock value, refreshed by whichever components are subscribed.
let now = 0;

function subscribe(onTick: () => void) {
  const tick = () => {
    now = Date.now();
    onTick();
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

const noSubscribe = () => () => {};
const getNow = () => now;

/** The current time in ms, refreshed every second while `active` (0 before the first tick). */
export function useNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : noSubscribe, getNow, getNow);
}
