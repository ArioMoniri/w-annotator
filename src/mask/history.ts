import type { Patch } from './patch';

/** Undo and redo for mask edits. One step is everything painted in one stroke. */
export class History {
  private done: Patch[][] = [];
  private undone: Patch[][] = [];
  private pending: Patch[] = [];

  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  add(patch: Patch): void {
    this.pending.push(patch);
  }

  commit(): void {
    if (this.pending.length === 0) return;
    this.done.push(this.pending);
    this.pending = [];
    this.undone = [];
    if (this.done.length > this.limit) this.done.shift();
  }

  /** Patches to apply with their `before` side, newest first. */
  undo(): Patch[] | null {
    this.commit();
    const step = this.done.pop();
    if (!step) return null;
    this.undone.push(step);
    return [...step].reverse();
  }

  /** Patches to apply with their `after` side, in the order they happened. */
  redo(): Patch[] | null {
    const step = this.undone.pop();
    if (!step) return null;
    this.done.push(step);
    return [...step];
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.pending = [];
  }
}
