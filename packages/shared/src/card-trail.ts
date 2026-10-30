// The cards a feature card was opened through, for its back strip (apps/web/README.md#cross-references):
// shared by the transit engine and the cycling map, so both modes go back the same way.

/** A stack of the cards the showing one was opened from, oldest first, each with its title. */
export class CardTrail<T> {
  private entries: { target: T; label: string }[] = [];

  /** The showing card (`here`, titled `label`) opens another: going back returns to it. */
  push(here: T, label: string): void {
    this.entries.push({ target: here, label });
  }

  /** The card to go back to, removed from the trail; undefined when there is none. */
  pop(): T | undefined {
    return this.entries.pop()?.target;
  }

  /** Forget every card: a selection made from the map, not from a card. */
  clear(): void {
    this.entries = [];
  }

  /** The title of the card `pop()` returns, for the back strip. */
  get backLabel(): string | undefined {
    return this.entries.at(-1)?.label;
  }
}
