/** A player's look. Everyone plays the same, as in Powa Volley's Classic mode. */
export interface Character {
  id: string;
  name: string;
  /** Body colour and darker outline on the canvas. */
  color: string;
  shade: string;
}

export const CHARACTERS = [
  { id: "blaze", name: "Blaze", color: "#ff7a45", shade: "#c2410c" },
  { id: "zip", name: "Zip", color: "#facc15", shade: "#a16207" },
  { id: "bruno", name: "Bruno", color: "#a78bfa", shade: "#6d28d9" },
  { id: "misty", name: "Misty", color: "#5eead4", shade: "#0f766e" },
  { id: "rio", name: "Rio", color: "#60a5fa", shade: "#1d4ed8" },
  { id: "kiki", name: "Kiki", color: "#f472b6", shade: "#be185d" },
] as const satisfies readonly Character[];

export function characterById(id: string): Character {
  return CHARACTERS.find((character) => character.id === id) ?? CHARACTERS[0];
}
