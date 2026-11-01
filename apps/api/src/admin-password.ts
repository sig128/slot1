import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH, hashAdminPassword, passwordLength } from "./lib/admin-password";

/**
 * Hashes a new admin password (docs/ADMIN.md). The password is read from stdin, never from the
 * command line, so it can't end up in shell history or a process list: the server's
 * `slot1 admin-password` asks for it without showing it and pipes it in, roughly
 *   printf '%s' "$password" | docker compose exec -T api node dist/admin-password.js
 * The last line of the output is `SLOT1_ADMIN_PASSWORD_HASH=<hash>`, ready for .env (single-quote
 * the value there: it contains "$"). Nothing is stored or sent anywhere by this command.
 */

const MAX_INPUT_BYTES = 16 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error("The input is too long for a password");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fail(message: string, code = 1): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

if (process.stdin.isTTY) {
  fail("Pipe the new admin password in on stdin. On the server, `slot1 admin-password` asks for it without showing it and does this for you.", 2);
} else {
  try {
    // One line: drop a single trailing newline (printf/echo), keep every other character.
    const password = (await readStdin()).replace(/\r?\n$/, "");
    if (/[\r\n]/.test(password)) fail("The password must be a single line.");
    else if (passwordLength(password) < ADMIN_PASSWORD_MIN_LENGTH) fail(`The password needs at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`);
    else if (passwordLength(password) > ADMIN_PASSWORD_MAX_LENGTH) fail(`The password can have at most ${ADMIN_PASSWORD_MAX_LENGTH} characters.`);
    else {
      const hash = await hashAdminPassword(password);
      process.stdout.write(
        "Admin password hash (scrypt). Put this line in the server's .env with the value in single quotes, then restart the API.\n" +
          "Changing it signs out every admin session.\n" +
          `SLOT1_ADMIN_PASSWORD_HASH=${hash}\n`,
      );
    }
  } catch (err) {
    fail(`Couldn't hash the password: ${(err as Error).message}`);
  }
}
