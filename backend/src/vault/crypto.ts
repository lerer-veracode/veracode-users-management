import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

export type KdfParams = { name: "scrypt"; salt: string; N: number; r: number; p: number };
export type Sealed = { iv: string; tag: string; ciphertext: string };

export const DEFAULT_COST = { N: 2 ** 17, r: 8, p: 1 };
export type Cost = typeof DEFAULT_COST;

const KEY_BYTES = 32;

export class OpenError extends Error {}

export const newKdf = (cost: Cost): KdfParams => ({
  name: "scrypt",
  salt: randomBytes(16).toString("base64"),
  ...cost,
});

export const deriveKey = (password: string, kdf: KdfParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const { N, r, p } = kdf;
    const maxmem = 256 * N * r;
    scrypt(
      password.normalize("NFC"),
      Buffer.from(kdf.salt, "base64"),
      KEY_BYTES,
      { N, r, p, maxmem },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });

export const newDataKey = (): Buffer => randomBytes(KEY_BYTES);

export const seal = (key: Buffer, plain: Buffer): Sealed => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
};

export const open = (key: Buffer, sealed: Sealed): Buffer => {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new OpenError("Could not decrypt");
  }
};
