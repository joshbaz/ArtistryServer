/**
 * Create a Studio account. Until the Team page exists, this is how the first
 * Super Admin (and anyone else) gets in.
 *
 *   yarn staff:create --email you@theartistry360.com --name "Your Name" [--role super-admin]
 *
 * The password is asked for without echoing it, or read from STAFF_PASSWORD
 * when that is set (for scripted setups). Roles: super-admin,
 * content-manager, finance, moderator.
 */
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import prisma from '../src/utils/db.mjs';
import { createStaff } from '../src/services/auth/staff.mjs';

const { values } = parseArgs({
    options: {
        email: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string', default: 'super-admin' },
    },
});

if (!values.email || !values.name) {
    console.error('Usage: yarn staff:create --email you@example.com --name "Your Name" [--role super-admin]');
    process.exit(1);
}

/** Read a line from the terminal without showing what is typed. */
const askHidden = (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
    };
    rl.question(question, (answer) => {
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
    });
});

const readPassword = async () => {
    if (process.env.STAFF_PASSWORD) return process.env.STAFF_PASSWORD;
    const password = await askHidden('Password (at least 12 characters): ');
    const again = await askHidden('Same password again: ');
    if (password !== again) throw new Error('The two passwords are different.');
    return password;
};

try {
    const staff = await createStaff({ ...values, password: await readPassword() });
    console.info(`Created ${staff.role} ${staff.name} <${staff.email}>. They can sign in at /studio/login.`);
} catch (error) {
    console.error(error.code === 'P2002' ? 'A Studio account with that email already exists.' : error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
