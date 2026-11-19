/**
 * Sends one test email the way the server sends every email (ZeptoMail if
 * its token is set, else the Netlify mail relay, else Zoho Mail's SMTP), and
 * prints what happened: the provider's id, or its exact reason for refusing.
 *
 *   yarn mail:test you@example.com
 *   yarn mail:test you@example.com relay     the relay only, to check the fallback works
 */
const only = process.argv[3];
if (only === 'relay') {
    // Checking the fallback on its own: as if there were no ZeptoMail token. Blank, not deleted, since
    // .env would fill a missing one back in, and blank counts as not set.
    process.env.ZEPTOMAIL_TOKEN = '';
}
const { isMailConfigured, mailRoute, sendMail } = await import('../src/services/emails/zohoMail.js');

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.log('Say who to send it to: yarn mail:test you@example.com');
    process.exit(1);
}
if (!isMailConfigured()) {
    console.log('No email is set up: put ZEPTOMAIL_TOKEN (or MAIL_RELAY_URL and MAIL_RELAY_KEY) in .env first.');
    process.exit(1);
}

const { env } = await import('../src/env.mjs');
const route = mailRoute();
if (only === 'relay' && route !== 'relay') {
    console.log('The relay isn\'t set up: put MAIL_RELAY_URL and MAIL_RELAY_KEY in .env first.');
    process.exit(1);
}
const via = { zeptomail: `ZeptoMail (${new URL(env.ZEPTOMAIL_API_URL).host})`, relay: `the Netlify mail relay (${new URL(env.MAIL_RELAY_URL ?? 'https://x').host}, from the Gmail address)`, smtp: `Zoho SMTP (${env.ZOHO_SMTP_HOST}:${env.ZOHO_SMTP_PORT})` }[route];
console.log(`Sending through ${via}…`);
try {
    const id = await sendMail({
        to,
        subject: 'Artistry360 test email',
        text: 'This is a test from the Artistry360 server. If you can read it, email is working.',
        html: '<div style="font-family:Arial,sans-serif;color:#111"><h1 style="font-size:20px">It works</h1><p>This is a test from the Artistry360 server. If you can read it, email is working.</p></div>',
    });
    console.log(`Sent${id ? ` (id ${id})` : ''}. Check the inbox, and the spam folder.`);
    process.exit(0);
} catch (error) {
    console.log(`Not sent: ${error.message}`);
    if (route === 'smtp' && /timeout|ETIMEDOUT|ECONNREFUSED/i.test(error.message)) {
        console.log('A timeout here usually means the host blocks the SMTP ports (DigitalOcean does): use ZEPTOMAIL_TOKEN or the mail relay instead.');
    }
    process.exit(1);
}
