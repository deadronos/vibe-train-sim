import type { Dir, Exit, Network, Side, SignalType } from './network';

export type Aspect = 'red' | 'yellow' | 'green';

export const keyOf = (node: number, side: Side) => `${node}:${side}`;

/** A piece of track ahead. start and end are distances from the walk origin to its entry and exit nodes. */
export interface AheadPiece {
  seg: number;
  dir: Dir;
  start: number;
  end: number;
  exit: Exit;
}

export interface NextSignal {
  key: string;
  node: number;
  side: Side;
  dist: number;
}

export interface SignalRoute {
  diverging: boolean;
  dir: 'straight' | 'left' | 'right';
  index: number;
  count: number;
  speed: number;
}

export interface SignalIndication {
  type: SignalType;
  aspect: Aspect;
  callingOn: boolean;
  route: SignalRoute | null;
}

/**
 * Walks the track forward along routes chosen by pick. visit returns undefined to carry on,
 * or any other value (including null) to stop and return it. Stops on a loop, dead end, range or maxSteps.
 */
export function walkTrack<T>(
  net: Network,
  pick: (seg: number, node: number, side: Side) => number | undefined,
  startSeg: number,
  startDir: Dir,
  startDist: number,
  range: number,
  maxSteps: number,
  visit: (p: AheadPiece) => T | null | undefined,
): T | null {
  let seg = startSeg;
  let dir = startDir;
  let start = startDist;
  const seen = new Set<number>();
  while (start < range && !seen.has(seg) && seen.size < maxSteps) {
    seen.add(seg);
    const exit = net.exit(seg, dir);
    const end = start + net.geom.get(seg)!.length;
    const r = visit({ seg, dir, start, end, exit });
    if (r !== undefined) return r;
    const nx = pick(seg, exit.node, exit.side);
    if (nx === undefined) return null;
    dir = net.entryDir(nx, exit.node, exit.side);
    seg = nx;
    start = end;
  }
  return null;
}
