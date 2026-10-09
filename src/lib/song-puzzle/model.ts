export interface PuzzlePosition {
  size: number;
  tiles: number[];
  goal: number[];
}
export type TileDirection = "up" | "down" | "left" | "right";
export function goalBoard(size: number, blankPosition = size * size - 1): number[] {
  if (
    !Number.isInteger(size) ||
    size < 3 ||
    size > 8 ||
    !Number.isInteger(blankPosition) ||
    blankPosition < 0 ||
    blankPosition >= size * size
  )
    throw new RangeError("Invalid puzzle dimensions or goal blank");
  let tile = 1;
  return Array.from({ length: size * size }, (_, index) => (index === blankPosition ? 0 : tile++));
}
export function validPosition(value: PuzzlePosition): boolean {
  const { size, tiles, goal } = value;
  const valid = (board: number[]) =>
    Array.isArray(board) &&
    board.length === size * size &&
    new Set(board).size === board.length &&
    board.every((tile) => Number.isInteger(tile) && tile >= 0 && tile < size * size);
  return Number.isInteger(size) && size >= 3 && size <= 8 && valid(tiles) && valid(goal);
}
export function solved(tiles: readonly number[], goal: readonly number[]): boolean {
  return tiles.length === goal.length && tiles.every((tile, index) => tile === goal[index]);
}
export function solvable(position: PuzzlePosition): boolean {
  if (!validPosition(position)) return false;
  const { size, goal, tiles } = position;
  const blank = 0;
  const ranks = new Map(goal.filter((tile) => tile !== blank).map((tile, index) => [tile, index]));
  const sequence = tiles.filter((tile) => tile !== blank).map((tile) => ranks.get(tile)!);
  let inversions = 0;
  for (let i = 0; i < sequence.length; i++)
    for (let j = i + 1; j < sequence.length; j++) if (sequence[i]! > sequence[j]!) inversions++;
  if (size % 2) return inversions % 2 === 0;
  const row = size - Math.floor(tiles.indexOf(blank) / size);
  const goalRow = size - Math.floor(goal.indexOf(blank) / size);
  return (inversions + row) % 2 === goalRow % 2;
}
export function neighbors(blank: number, size: number): number[] {
  const positions: number[] = [];
  if (blank >= size) positions.push(blank - size);
  if (blank < size * (size - 1)) positions.push(blank + size);
  if (blank % size) positions.push(blank - 1);
  if (blank % size < size - 1) positions.push(blank + 1);
  return positions;
}
/** Path entries identify the moving tile, never the blank's direction. */
export function slide(position: PuzzlePosition, tile: number): number[] | undefined {
  const index = position.tiles.indexOf(tile);
  const blank = position.tiles.indexOf(0);
  if (!neighbors(blank, position.size).includes(index)) return;
  const next = [...position.tiles];
  [next[index], next[blank]] = [next[blank]!, next[index]!];
  return next;
}
export function tileDirection(tiles: readonly number[], tile: number, size: number): TileDirection {
  const delta = tiles.indexOf(0) - tiles.indexOf(tile);
  return delta === -size ? "up" : delta === size ? "down" : delta === -1 ? "left" : "right";
}
export function shuffle(position: PuzzlePosition, count: number): number[] {
  const next = [...position.goal];
  let blank = next.indexOf(0),
    previous = -1;
  for (let i = 0; i < count; i++) {
    const choices = neighbors(blank, position.size).filter((index) => index !== previous);
    const index = choices[Math.floor(Math.random() * choices.length)]!;
    [next[index], next[blank]] = [next[blank]!, next[index]!];
    previous = blank;
    blank = index;
  }
  return next;
}
