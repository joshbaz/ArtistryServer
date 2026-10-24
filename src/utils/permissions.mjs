/**
 * The Studio's roles, from the MOU (clause 3C). A Super Admin can do
 * everything; routes name the other roles that may use them, with
 * `allow(...roles)` from middleware/auth.mjs.
 */
export const STAFF_ROLES = ['super-admin', 'content-manager', 'finance', 'moderator'];

export const SUPER_ADMIN = 'super-admin';

export const ROLE_LABELS = {
    'super-admin': 'Super Admin',
    'content-manager': 'Content Manager',
    finance: 'Finance',
    moderator: 'Moderator',
};

/** Whether a staff member with `role` may use something open to `roles`. */
export const roleAllows = (role, roles) => role === SUPER_ADMIN || roles.includes(role);
