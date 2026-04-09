import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeadService } from './lead.service.js';
import { NotFoundError } from '../../shared/errors.js';

// Minimal fluent query builder mock
function makeQueryBuilder(rows: any[]) {
  const builder: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
    returning: vi.fn().mockResolvedValue(rows),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
  };
  return builder;
}

const TENANT = 'tenant-uuid-1';
const LEAD_ID = 'lead-uuid-1';

const SAMPLE_LEAD = {
  id: LEAD_ID,
  tenantId: TENANT,
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+1234567890',
  status: 'new',
  score: 0,
  source: 'manual',
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('LeadService', () => {
  let db: any;
  let service: LeadService;

  beforeEach(() => {
    db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    };
    service = new LeadService(db);
  });

  describe('create', () => {
    it('inserts and returns the created lead', async () => {
      const builder = makeQueryBuilder([SAMPLE_LEAD]);
      db.insert.mockReturnValue(builder);

      const result = await service.create(TENANT, { name: 'Jane Doe', email: 'jane@example.com' });

      expect(db.insert).toHaveBeenCalledOnce();
      expect(result).toEqual(SAMPLE_LEAD);
    });
  });

  describe('getById', () => {
    it('returns the lead when found', async () => {
      const builder = makeQueryBuilder([SAMPLE_LEAD]);
      db.select.mockReturnValue(builder);

      const result = await service.getById(TENANT, LEAD_ID);
      expect(result).toEqual(SAMPLE_LEAD);
    });

    it('throws NotFoundError when lead does not exist', async () => {
      const builder = makeQueryBuilder([]);
      db.select.mockReturnValue(builder);

      await expect(service.getById(TENANT, 'missing-id')).rejects.toThrow(NotFoundError);
    });
  });

  describe('list', () => {
    it('returns all leads for the tenant', async () => {
      const builder = makeQueryBuilder([SAMPLE_LEAD]);
      db.select.mockReturnValue(builder);

      const result = await service.list(TENANT);
      expect(result).toEqual([SAMPLE_LEAD]);
    });
  });

  describe('update', () => {
    it('returns the updated lead', async () => {
      const updated = { ...SAMPLE_LEAD, status: 'qualified' };
      const builder = makeQueryBuilder([updated]);
      db.update.mockReturnValue(builder);

      const result = await service.update(TENANT, LEAD_ID, { status: 'qualified' });
      expect(result.status).toBe('qualified');
    });

    it('throws NotFoundError when no row is updated', async () => {
      const builder = makeQueryBuilder([]);
      db.update.mockReturnValue(builder);

      await expect(service.update(TENANT, 'missing-id', { status: 'qualified' })).rejects.toThrow(NotFoundError);
    });
  });

  describe('findByPhone', () => {
    it('returns lead when found', async () => {
      const builder = makeQueryBuilder([SAMPLE_LEAD]);
      db.select.mockReturnValue(builder);

      const result = await service.findByPhone(TENANT, '+1234567890');
      expect(result).toEqual(SAMPLE_LEAD);
    });

    it('returns null when not found', async () => {
      const builder = makeQueryBuilder([]);
      db.select.mockReturnValue(builder);

      const result = await service.findByPhone(TENANT, '+0000000000');
      expect(result).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('returns null when not found', async () => {
      const builder = makeQueryBuilder([]);
      db.select.mockReturnValue(builder);

      const result = await service.findByEmail(TENANT, 'nobody@example.com');
      expect(result).toBeNull();
    });
  });
});
