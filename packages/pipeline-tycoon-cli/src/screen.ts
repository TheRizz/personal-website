// A grid of styled characters, turned into ANSI escapes in one pass. Colour depth is chosen once
// (truecolor, 256 colours, 16 colours or none) so the same frame works in any terminal.

export interface Style {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export type ColorMode = "truecolor" | "256" | "16" | "none";

export function detectColorMode(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  forced: boolean | null,
): ColorMode {
  if (forced === false || "NO_COLOR" in env) return "none";
  if (!isTTY && forced !== true) return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if ((env.TERM ?? "").includes("256")) return "256";
  if (env.TERM_PROGRAM === "Apple_Terminal") return "256";
  if (process.platform === "win32") return "truecolor";
  return "16";
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function to256([r, g, b]: [number, number, number]): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

function to16([r, g, b]: [number, number, number]): number {
  const bright = Math.max(r, g, b) > 200;
  const bit = (v: number) => (v > 110 ? 1 : 0);
  const index = bit(r) | (bit(g) << 1) | (bit(b) << 2);
  return (bright ? 90 : 30) + (index === 0 ? 7 : index);
}

export function styleCode(style: Style | undefined, mode: ColorMode): string {
  if (!style || mode === "none") return "";
  const parts: string[] = [];
  if (style.bold) parts.push("1");
  if (style.dim) parts.push("2");
  if (style.inverse) parts.push("7");
  if (style.fg) {
    const color = rgb(style.fg);
    if (mode === "truecolor") parts.push(`38;2;${color.join(";")}`);
    else if (mode === "256") parts.push(`38;5;${to256(color)}`);
    else parts.push(String(to16(color)));
  }
  return parts.length ? `\x1b[${parts.join(";")}m` : "";
}

export class Canvas {
  private chars: string[];
  private styles: (Style | undefined)[];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.chars = Array<string>(width * height).fill(" ");
    this.styles = Array<Style | undefined>(width * height).fill(undefined);
  }

  put(x: number, y: number, ch: string, style?: Style) {
    const cx = Math.round(x);
    const cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) return;
    this.chars[cy * this.width + cx] = ch;
    this.styles[cy * this.width + cx] = style;
  }

  get(x: number, y: number): string {
    return this.chars[Math.round(y) * this.width + Math.round(x)] ?? " ";
  }

  /** Writes text from (x, y), clipped to `maxWidth` (or the canvas edge). */
  text(x: number, y: number, value: string, style?: Style, maxWidth = Infinity) {
    const glyphs = [...value];
    const room = Math.min(maxWidth, this.width - Math.round(x));
    glyphs.slice(0, Math.max(0, room)).forEach((ch, i) => this.put(x + i, y, ch, style));
  }

  /** Plain text of each row, for tests. */
  lines(): string[] {
    return Array.from({ length: this.height }, (_, y) =>
      this.chars.slice(y * this.width, (y + 1) * this.width).join(""),
    );
  }

  /** The whole canvas as one string of ANSI-styled rows. */
  toAnsi(mode: ColorMode): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = "";
      let current = "";
      for (let x = 0; x < this.width; x++) {
        const code = styleCode(this.styles[y * this.width + x], mode);
        if (code !== current) {
          row += current ? `\x1b[0m${code}` : code;
          current = code;
        }
        row += this.chars[y * this.width + x];
      }
      rows.push(current ? `${row}\x1b[0m` : row);
    }
    return rows.join("\r\n");
  }
}
