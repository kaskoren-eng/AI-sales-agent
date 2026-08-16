import { pgTable, uuid, varchar, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * WHICH TENANT OWNS WHICH PHONE NUMBER.
 *
 * Until this table existed, every inbound call on every number resolved to one env var —
 * `VOICE_WEBHOOK_TENANT_ID`. With one customer that reads as configuration. With two it is a
 * cross-tenant leak in the most visible place the product has: tenant #2's caller reaches tenant
 * #1's agent, is greeted by tenant #1's company, and any lead created lands in tenant #1's data.
 *
 * The provisioning model is hybrid (see the program plan): ClickScales buys the DID and assigns it,
 * the tenant never touches telephony. So onboarding a number is one row here plus pointing Zadarma
 * forwarding at the SIP URI — `scripts/provision-number.mjs` does both halves of the row.
 *
 * `tenantId` IS NULLABLE ON PURPOSE. A number we have bought but not yet assigned is a real state
 * — the unassigned pool — and it must be representable, because the alternative is that numbers
 * only exist once they belong to someone and an unassigned DID is invisible to the very query that
 * decides whether to answer it.
 */
export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null = bought, not yet assigned. A call to it is answered with "not in service". */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    /**
     * E.164, WITH the leading `+`, stored canonically.
     *
     * Zadarma does not consistently send it that way — the trunk config shows `+972555070922`
     * while SIP attributes have arrived as `972555070922` — so writes normalise on the way in and
     * `resolveCallIdentity` normalises on the way out. Never compare a raw SIP attribute to this
     * column.
     */
    e164: varchar('e164', { length: 20 }).notNull(),
    /** Operator-facing note: which customer, which campaign, what it is for. */
    label: varchar('label', { length: 120 }),
    /**
     * Soft-disable without deleting the row, so a number can be parked between customers while
     * keeping its history. An inactive number answers "not in service" exactly like an unassigned
     * one.
     */
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One row per number, globally — a DID belongs to at most one tenant, and two rows claiming
    // the same number would make inbound routing depend on row order.
    uniqueIndex('phone_numbers_e164_key').on(table.e164),
    index('phone_numbers_tenant_idx').on(table.tenantId),
  ],
);

export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
