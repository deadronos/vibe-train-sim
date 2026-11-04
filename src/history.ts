// Undo and redo stacks of whole-map snapshots.
const LIMIT = 40;

export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  /** Records the state before an edit. A new edit abandons anything that could be redone. */
  push(state: string) {
    this.undoStack.push(state);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Returns the state to restore, or null if there is nothing to undo. */
  undo(current: string): string | null {
    const s = this.undoStack.pop();
    if (s === undefined) return null;
    this.redoStack.push(current);
    return s;
  }

  /** Returns the state to restore, or null if there is nothing to redo. */
  redo(current: string): string | null {
    const s = this.redoStack.pop();
    if (s === undefined) return null;
    this.undoStack.push(current);
    return s;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
