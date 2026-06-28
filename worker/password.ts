import { Buffer } from "node:buffer";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 16,
  p: 1,
  maxmem: 128 * 16_384 * 16 * 2,
} as const;

const derivePasswordKey = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SCRYPT_SALT_BYTES).toString("hex");
  const key = await derivePasswordKey(password, salt);
  return `${salt}:${key.toString("hex")}`;
};

export const verifyPassword = async ({ hash, password }: { hash: string; password: string }): Promise<boolean> => {
  const [salt, encodedKey, extraPart] = hash.split(":");
  if (extraPart !== undefined || !salt || !encodedKey) return false;
  if (!/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(encodedKey)) return false;

  const expectedKey = Buffer.from(encodedKey, "hex");
  const actualKey = await derivePasswordKey(password, salt);
  return timingSafeEqual(actualKey, expectedKey);
};
