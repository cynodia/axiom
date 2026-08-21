import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

/**
 * Two-factor authentication for npm write commands.
 *
 * By default this passes nothing and lets npm authenticate the way it prefers: in a
 * terminal it prints a URL, waits for the browser, and the registry then treats the
 * session as 2FA-satisfied for a few minutes — long enough for a whole release. Supplying
 * `--otp=<code>` instead forces a classic one-time password, which npm applies to a single
 * request, so a five-package release would need five codes. The typed code is therefore a
 * fallback, not the normal path.
 */
export function otpFromArgv(argv = process.argv) {
  return argv.find((argument) => argument.startsWith('--otp='))?.slice('--otp='.length);
}

async function prompt(reason) {
  if (process.stdin.isTTY !== true) {
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${reason}npm one-time password (blank to skip): `)).trim();
    return answer || undefined;
  } finally {
    rl.close();
  }
}

export function createOtpSession(initial) {
  let otp = initial;

  return {
    /** Runs an npm command, falling back to a typed code if npm's own flow does not run. */
    async run(label, args, cwd) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          execFileSync('npm', otp ? [...args, '--otp', otp] : args, { cwd, stdio: 'inherit' });
          return;
        } catch (error) {
          const fresh = attempt <= 3 ? await prompt(`${label} failed. `) : undefined;
          if (!fresh) {
            throw error;
          }
          otp = fresh;
        }
      }
    },
  };
}
