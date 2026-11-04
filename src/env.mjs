import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().startsWith("mongodb", "DATABASE_URL must be a MongoDB connection string"),
    // One signing secret per realm, so a member token can never pass as a Studio one (14-state-management.md, section 9).
    ADMIN_TOKEN_SECRET: z.string().min(32, "ADMIN_TOKEN_SECRET must be at least 32 characters"),
    MEMBER_TOKEN_SECRET: z.string().min(32, "MEMBER_TOKEN_SECRET must be at least 32 characters"),
    ORGANIZER_TOKEN_SECRET: z.string().min(32, "ORGANIZER_TOKEN_SECRET must be at least 32 characters"),
    REDIS_URL: z.string().startsWith("redis", "REDIS_URL must be a Redis connection string"),
    // Email through Zoho Mail (src/services/emails/zohoMail.js). Leave the user and password out and
    // nothing is sent. smtp.zoho.com for a personal account, smtppro.zoho.com for a domain account.
    ZOHO_SMTP_HOST: z.string().default("smtp.zoho.com"),
    ZOHO_SMTP_PORT: z.coerce.number().int().positive().default(465),
    ZOHO_SMTP_USER: z.email().optional(),
    // An app-specific password (Zoho, My Account, Security, App passwords), not the account password.
    ZOHO_SMTP_PASSWORD: z.string().min(1).optional(),
    MAIL_FROM: z.string().optional(),
    MAIL_REPLY_TO: z.string().optional(),
    // Where theartistry360.com runs; links in emails, and PesaPal's return to the site, point here.
    APP_URL: z.url().default("http://localhost:5173"),
    // Where the stream site runs; PesaPal returns streaming payers here.
    STREAM_URL: z.url().default("http://localhost:5174"),
    // Where this API is reached from the internet; PesaPal's IPN calls it.
    API_URL: z.url().default("http://localhost:5000"),
    // PesaPal API 3.0 (src/services/payments/pesapal.mjs). Without the key and secret, nobody can buy votes.
    PESAPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
    PESAPAL_CONSUMER_KEY: z.string().min(1).optional(),
    PESAPAL_CONSUMER_SECRET: z.string().min(1).optional(),
    // Defaults to API_URL + /api/v1/payments/pesapal/ipn. On a laptop PesaPal can't reach it; returning to the site checks the payment instead.
    PESAPAL_IPN_URL: z.url().optional(),
    // Tests only: point the client at a stand-in for PesaPal.
    PESAPAL_BASE_URL: z.url().optional(),
    // Google sign-in (Google Cloud Console, Clients). A Google ID token is accepted when it was issued
    // to one of these client IDs. The secret is for the stream site's redirect flow only.
    GOOGLE_WEB_CLIENT_ID: z.string().endsWith(".apps.googleusercontent.com", "GOOGLE_WEB_CLIENT_ID must end in .apps.googleusercontent.com").optional(),
    GOOGLE_ANDROID_CLIENT_ID: z.string().endsWith(".apps.googleusercontent.com", "GOOGLE_ANDROID_CLIENT_ID must end in .apps.googleusercontent.com").optional(),
    GOOGLE_IOS_CLIENT_ID: z.string().endsWith(".apps.googleusercontent.com", "GOOGLE_IOS_CLIENT_ID must end in .apps.googleusercontent.com").optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    // Sign in with Apple (Apple Developer, Certificates, Identifiers & Profiles). An Apple ID token is
    // accepted when it was issued to the Services ID (websites) or the bundle ID (the app).
    APPLE_TEAM_ID: z.string().length(10, "APPLE_TEAM_ID is the 10-character Team ID").optional(),
    APPLE_SERVICES_ID: z.string().min(1).optional(),
    APPLE_BUNDLE_ID: z.string().min(1).optional(),
    APPLE_KEY_ID: z.string().length(10, "APPLE_KEY_ID is the 10-character Key ID").optional(),
    // The .p8 key downloaded with APPLE_KEY_ID, relative to server/. Needed to revoke Apple sign-in when an account is deleted.
    APPLE_PRIVATE_KEY_PATH: z.string().min(1).optional(),

    // Video for live classes (services/video). Without a token, the Studio's stream setup says it isn't connected yet.
    VIDEO_PROVIDER: z.enum(["mux", "cloudflare"]).default("mux"),
    MUX_TOKEN_ID: z.string().min(1).optional(),
    MUX_TOKEN_SECRET: z.string().min(1).optional(),
    MUX_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Signed playback for members-only and pay-per-view classes: the key's id and its base64 private key, as Mux shows them.
    MUX_SIGNING_KEY_ID: z.string().min(1).optional(),
    MUX_SIGNING_PRIVATE_KEY: z.string().min(1).optional(),
    // Only to point tests at a stand-in for Mux's API.
    MUX_API_URL: z.url().optional(),
    // Cloudflare Stream: the account, an API token with Stream Write, and the "customer-<code>" part of its playback links.
    CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
    CLOUDFLARE_STREAM_API_TOKEN: z.string().min(1).optional(),
    CLOUDFLARE_STREAM_CUSTOMER_CODE: z.string().min(1).optional(),
    // Its two webhooks: Stream's (recording ready) and Notifications' (live input connected / disconnected).
    CLOUDFLARE_STREAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    CLOUDFLARE_NOTIFICATION_SECRET: z.string().min(1).optional(),
    // Signed playback: the signing key's id and its base64 pem, as Cloudflare returns them.
    CLOUDFLARE_STREAM_SIGNING_KEY_ID: z.string().min(1).optional(),
    CLOUDFLARE_STREAM_SIGNING_KEY: z.string().min(1).optional(),
    // Only to point tests at a stand-in for Cloudflare's API.
    CLOUDFLARE_API_URL: z.url().optional(),

    // Streaming videos in DigitalOcean Spaces (services/storage/spaces.mjs). Without the key and secret,
    // the Studio's uploads say they aren't connected yet. The region is the bucket's (fra1, ams3, sgp1…).
    SPACES_REGION: z.string().regex(/^[a-z]{3}\d$/, "SPACES_REGION is the bucket's region, like fra1").optional(),
    SPACES_BUCKET: z.string().min(3).optional(),
    SPACES_KEY: z.string().min(1).optional(),
    SPACES_SECRET: z.string().min(1).optional(),
    // The bucket's CDN address. Defaults to https://<bucket>.<region>.cdn.digitaloceanspaces.com.
    SPACES_CDN_URL: z.url().optional(),
    // Only to point tests at a stand-in for Spaces (MinIO).
    SPACES_ENDPOINT: z.url().optional(),
    // Converting uploads to HLS with ffmpeg (services/streaming/encoder.mjs). "off" leaves it to a
    // separate worker process (yarn worker), on its own droplet.
    VIDEO_WORKER: z.enum(["on", "off"]).default("on"),
    VIDEO_ENCODE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    // ffmpeg's x264 preset: faster encodes, or smaller files at the same quality.
    VIDEO_ENCODE_PRESET: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"]).default("veryfast"),
    // Where encodes are written before they go to Spaces. A 2-hour film needs about 8 GB free.
    VIDEO_WORK_DIR: z.string().min(1).optional(),
    FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
    FFPROBE_PATH: z.string().min(1).default("ffprobe"),
});

// A blank line in .env (KEY="") means "not set", so optional settings can be left empty.
const set = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));

const parsed = envSchema
    .refine((e) => new Set([e.ADMIN_TOKEN_SECRET, e.MEMBER_TOKEN_SECRET, e.ORGANIZER_TOKEN_SECRET]).size === 3, { path: ["ORGANIZER_TOKEN_SECRET"], message: "The three token secrets must all differ" })
    .safeParse(set);

if (!parsed.success) {
    console.error("Invalid environment variables:");
    for (const issue of parsed.error.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
}

export const env = parsed.data;
