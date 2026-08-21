import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

/**
 * npm asks for a one-time password on publish and on dist-tag changes when the account
 * has 2FA. A code lasts about 30 seconds while a release touches several packages, so a
 * session asks for a fresh one and retries rather than abandoning the run.
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
    /** Asks for a code up front, so the first command does not fail just to ask. */
    async prime() {
      if (otp === undefined) {
        otp = await prompt('');
      }
    },

    /** Runs an npm command, retrying with a fresh code if it is rejected. */
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
