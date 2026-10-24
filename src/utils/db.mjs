import { PrismaClient } from '@prisma/client';

/**
 * The one Prisma client (MongoDB). It connects on the first query, so the
 * server starts even while the database is briefly unreachable.
 * @type {PrismaClient}
 */
const prisma = new PrismaClient({
    // Never return secrets unless a query explicitly opts in with omit: { field: false }
    omit: {
        staff: { passwordHash: true },
        session: { tokenHash: true, previousHash: true },
    },
});

export default prisma;
