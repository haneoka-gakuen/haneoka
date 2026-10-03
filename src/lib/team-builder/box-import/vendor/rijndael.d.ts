declare class Rijndael {
  constructor(key: ArrayLike<number>);
  ExpandKey(size: number): number[];
  decrypt(block: ArrayLike<number>): number[];
  SubBytesReversed(block: number[]): void;
  ShiftRowsReversed(block: number[]): void;
}
export default Rijndael;
