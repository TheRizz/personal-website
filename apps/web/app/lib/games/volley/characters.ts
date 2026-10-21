/** A player's look. Everyone plays the same, as in Powa Volley's Classic mode. */
export interface Character {
  id: string;
  name: string;
  /** Body colour and darker outline on the canvas. */
  color: string;
  shade: string;
}

export const CHARACTERS = [
  { id: "rio", name: "Rio", color: "#2a35e8", shade: "#121a8c" },
  { id: "blaze", name: "Blaze", color: "#e3161b", shade: "#8a0a0d" },
  { id: "kiki", name: "Kiki", color: "#2e9b2e", shade: "#175a17" },
  { id: "misty", name: "Misty", color: "#cfcfcf", shade: "#7a7a7a" },
  { id: "zip", name: "Zip", color: "#f2c412", shade: "#9a7a05" },
  { id: "bruno", name: "Bruno", color: "#7b2fd0", shade: "#46157f" },
] as const satisfies readonly Character[];

export function characterById(id: string): Character {
  return CHARACTERS.find((character) => character.id === id) ?? CHARACTERS[0];
}
