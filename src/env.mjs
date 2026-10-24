import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().startsWith("mongodb", "DATABASE_URL must be a MongoDB connection string"),
    // One signing secret per realm, so a member token can never pass as a Studio one (14-state-management.md, section 9).
    ADMIN_TOKEN_SECRET: z.string().min(32, "ADMIN_TOKEN_SECRET must be at least 32 characters"),
    MEMBER_TOKEN_SECRET: z.string().min(32, "MEMBER_TOKEN_SECRET must be at least 32 characters"),
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
    // Where theartistry360.com runs; links in emails point here.
    APP_URL: z.url().default("http://localhost:5173"),
});

// A blank line in .env (KEY="") means "not set", so optional settings can be left empty.
const set = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));

const parsed = envSchema
    .refine((e) => e.ADMIN_TOKEN_SECRET !== e.MEMBER_TOKEN_SECRET, { path: ["MEMBER_TOKEN_SECRET"], message: "Must differ from ADMIN_TOKEN_SECRET" })
    .safeParse(set);

if (!parsed.success) {
    console.error("Invalid environment variables:");
    for (const issue of parsed.error.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
}

export const env = parsed.data;
