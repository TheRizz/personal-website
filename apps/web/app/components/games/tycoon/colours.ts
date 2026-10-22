/** One neon colour per tier, cheapest first; shared by the scene and the shop. */
export const TIER_COLOURS = [
  0x22d3ee, 0x34d399, 0xa3e635, 0xfacc15, 0xfb923c, 0xf472b6, 0xc084fc, 0x818cf8, 0x60a5fa,
  0xe2e8f0,
] as const;

export const TIER_HEX = TIER_COLOURS.map((c) => `#${c.toString(16).padStart(6, "0")}`);
