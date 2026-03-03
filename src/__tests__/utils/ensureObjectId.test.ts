jest.mock('../../utils/mongo', () => {
  const { ObjectId } = require('mongodb');
  return { ObjectId };
});

import { ensureObjectId } from '../../utils/ensureObjectId';
import { ObjectId } from 'mongodb';

describe('ensureObjectId', () => {
  it('should convert a string to ObjectId', () => {
    const hex = '507f1f77bcf86cd799439011';
    const result = ensureObjectId(hex);
    expect(result).toBeInstanceOf(ObjectId);
    expect(result.toString()).toBe(hex);
  });

  it('should return an existing ObjectId as-is', () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    const result = ensureObjectId(oid);
    expect(result).toBe(oid);
  });
});
