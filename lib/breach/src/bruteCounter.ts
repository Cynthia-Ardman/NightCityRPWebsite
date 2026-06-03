// Counts the number of valid Breach Protocol paths that satisfy a combined
// daemon pattern in a numeric matrix. Ported verbatim (pure) from the
// cyberpunk2077-hacking-solver fork (lib/bruteCounter.ts).

export interface Coord {
  x: number;
  y: number;
}

export enum Dir {
  Horizontal,
  Vertical,
}

interface SearchPoint {
  patternPtr: number;
  used: boolean[][];
  stepsSoFar: Coord[];
  allowedDir: Dir;
  x: number;
  y: number;
}

function make2dArray<T>(yLen: number, xLen: number, fillValue: T): T[][] {
  const arr = new Array<T[]>(yLen);
  for (let y = 0; y < yLen; y++) {
    arr[y] = new Array<T>(xLen).fill(fillValue);
  }
  return arr;
}

function clone2d<T>(arr: T[][]): T[][] {
  return arr.map((subarr) => subarr.slice());
}

function markUsed(arr: boolean[][], x: number, y: number) {
  const copy = clone2d(arr);
  copy[y][x] = true;
  return copy;
}

function* walkAllowedDir(searchPoint: SearchPoint, yLen: number, xLen: number) {
  const { used, allowedDir } = searchPoint;

  if (allowedDir === Dir.Vertical) {
    const { x } = searchPoint;
    for (let y = 0; y < yLen; y++) {
      if (used[y][x]) continue;
      yield { x, y };
    }
  } else {
    const { y } = searchPoint;
    for (let x = 0; x < xLen; x++) {
      if (used[y][x]) continue;
      yield { x, y };
    }
  }
}

export function countSolutions(pattern: number[], matrix: number[][]): number {
  const yLen = matrix.length;
  const xLen = matrix[0].length;
  const queue: SearchPoint[] = [
    {
      patternPtr: 0,
      used: make2dArray(yLen, xLen, false),
      stepsSoFar: [],
      x: 0,
      y: 0,
      allowedDir: Dir.Horizontal,
    },
  ];

  let isInitial = true;
  let count = 0;

  while (queue.length > 0) {
    const searchPoint = queue.shift()!;
    const { patternPtr, used, stepsSoFar, allowedDir } = searchPoint;

    if (patternPtr === pattern.length) {
      count++;
      continue;
    }

    for (const { x, y } of walkAllowedDir(searchPoint, yLen, xLen)) {
      if (matrix[y][x] === pattern[patternPtr]) {
        queue.push({
          patternPtr: patternPtr + 1,
          used: markUsed(used, x, y),
          stepsSoFar: stepsSoFar.concat({ x, y }),
          allowedDir:
            allowedDir === Dir.Vertical ? Dir.Horizontal : Dir.Vertical,
          x,
          y,
        });
      } else if (isInitial) {
        queue.push({
          patternPtr,
          used: markUsed(used, x, y),
          stepsSoFar: stepsSoFar.concat({ x, y }),
          allowedDir:
            allowedDir === Dir.Vertical ? Dir.Horizontal : Dir.Vertical,
          x,
          y,
        });
      }
    }

    isInitial = false;
  }

  return count;
}
