/** True when the focused element was removed (focus fell back to <body>). */
export function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}
