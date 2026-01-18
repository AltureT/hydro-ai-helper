import { getDomainId } from '../../utils/domainHelper';
import { Handler } from 'hydrooj';

describe('domainHelper', () => {
  describe('getDomainId', () => {
    it('should return domainId from args when available', () => {
      const handler = {
        args: { domainId: 'test-domain' },
        domain: { _id: 'other-domain' }
      } as unknown as Handler;

      expect(getDomainId(handler)).toBe('test-domain');
    });

    it('should return domain._id when args.domainId is not available', () => {
      const handler = {
        args: {},
        domain: { _id: 'domain-from-context' }
      } as unknown as Handler;

      expect(getDomainId(handler)).toBe('domain-from-context');
    });

    it('should return "system" when neither is available', () => {
      const handler = {
        args: {}
      } as unknown as Handler;

      expect(getDomainId(handler)).toBe('system');
    });

    it('should return "system" when args is undefined', () => {
      const handler = {} as Handler;

      expect(getDomainId(handler)).toBe('system');
    });

    it('should prioritize args.domainId over domain._id', () => {
      const handler = {
        args: { domainId: 'priority-domain' },
        domain: { _id: 'context-domain' }
      } as unknown as Handler;

      expect(getDomainId(handler)).toBe('priority-domain');
    });
  });
});
