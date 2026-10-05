/** Canonical token shared by the editor, renderer and comment write guard. */
export const validStickerToken = (value: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,31}:\d{1,12}(?::[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)?$/.test(value);
