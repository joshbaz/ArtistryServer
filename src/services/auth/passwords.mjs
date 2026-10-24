import argon2 from 'argon2';

/**
 * Passwords are stored as argon2id hashes (17-api-server.md, section 5),
 * at OWASP's recommended cost: 19 MiB of memory, 2 passes.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;

export const hashPassword = (password) => argon2.hash(password, OPTIONS);

// Checked when no account matches, so a wrong email takes as long as a wrong password.
let dummyHash = null;

/**
 * Whether `password` matches `hash`. With no hash (no such account) it still
 * does the work, so the response time doesn't reveal which emails exist.
 * @param {string | null | undefined} hash
 * @param {string} password
 */
export const verifyPassword = async (hash, password) => {
    if (!hash) {
        dummyHash ??= await hashPassword('no account has this password');
        await argon2.verify(dummyHash, password).catch(() => false);
        return false;
    }
    return argon2.verify(hash, password).catch(() => false);
};
