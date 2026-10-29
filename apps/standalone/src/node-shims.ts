/**
 * Minimal stand-ins for the Node built-ins the shared code imports, used
 * only in the browser build. File-system calls are no-ops because the
 * standalone demo keeps everything in memory.
 */

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();
  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set?.size) return false;
    for (const fn of [...set]) fn(...args);
    return true;
  }
  setMaxListeners(): this {
    return this;
  }
}

export const existsSync = () => false;
export const mkdirSync = () => undefined;
export const readFileSync = () => {
  throw new Error("no file system in the browser demo");
};
export const writeFileSync = () => undefined;
export const renameSync = () => undefined;
export const readFile = async () => {
  throw new Error("no file system in the browser demo");
};
export const dirname = (p: string) => p.replace(/\/[^/]*$/, "");
export const join = (...p: string[]) => p.join("/");
export const extname = (p: string) => /\.[^./]*$/.exec(p)?.[0] ?? "";
export default { EventEmitter };
