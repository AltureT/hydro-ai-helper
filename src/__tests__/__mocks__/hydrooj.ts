export class Handler {
  ctx: any = {};
  request: any = {};
  response: any = {};
  user?: any;
  args?: any;
  limitRate = jest.fn();
}

export const PRIV = {
  PRIV_NONE: 0,
  PRIV_USER_PROFILE: 1,
  PRIV_EDIT_SYSTEM: 2,
  PRIV_READ_RECORD_CODE: 4,
};

export const PERM = {
  PERM_EDIT_DOMAIN: 1n << 1n,
  PERM_EDIT_PROBLEM: 1n << 5n,
  PERM_EDIT_PROBLEM_SELF: 1n << 6n,
  PERM_READ_RECORD_CODE: 1n << 7n,
};

export const BUILTIN_ROLES: Record<string, bigint> = {
  guest: 1n,
  default: 1n << 3n,
  root: -1n,
};

export const db = {
  collection: jest.fn(() => ({
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    toArray: jest.fn().mockResolvedValue([])
  }))
};

/**
 * Hydro 4 / Hydro 5 differ in how domain membership and user-cache invalidation work.
 * The plugin feature-detects (`DomainModel.setJoin`, `UserModel._deleteUserCache`), so the
 * mock exposes a toggle. Default shape is Hydro 4 (the version in devDependencies).
 */
export const UserModel: any = {
  cache: new Map<string, unknown>(),
  getById: jest.fn(),
};

export const DomainModel: any = {
  get: jest.fn(),
  setUserRole: jest.fn(),
  collUser: {
    find: jest.fn(),
    updateMany: jest.fn(),
  },
};

export type HydroMockMode = 'v4' | 'v5';

export function setHydroMode(mode: HydroMockMode): void {
  UserModel.cache = new Map<string, unknown>();
  UserModel.getById = jest.fn();
  DomainModel.get = jest.fn();
  DomainModel.setUserRole = jest.fn();
  if (mode === 'v5') {
    DomainModel.setJoin = jest.fn();
    UserModel._deleteUserCache = jest.fn();
  } else {
    delete DomainModel.setJoin;
    delete UserModel._deleteUserCache;
  }
}

export const ProblemModel = {
  get: jest.fn(),
  addTestdata: jest.fn(),
};

export const StorageModel = {
  get: jest.fn(),
};

export const SystemModel = {
  get: jest.fn(),
};

export const STATUS = {
  STATUS_WAITING: 0,
  STATUS_ACCEPTED: 1,
  STATUS_WRONG_ANSWER: 2,
  STATUS_TIME_LIMIT_EXCEEDED: 3,
  STATUS_MEMORY_LIMIT_EXCEEDED: 4,
  STATUS_OUTPUT_LIMIT_EXCEEDED: 5,
  STATUS_RUNTIME_ERROR: 6,
  STATUS_COMPILE_ERROR: 7,
  STATUS_SYSTEM_ERROR: 8,
  STATUS_CANCELED: 9,
  STATUS_ETC: 10,
  STATUS_HACKED: 11,
  STATUS_JUDGING: 20,
  STATUS_COMPILING: 21,
  STATUS_FETCHED: 22,
  STATUS_IGNORED: 30,
  STATUS_FORMAT_ERROR: 31,
};

export const ContestModel = {
  get: jest.fn(),
  isOngoing: jest.fn(),
  isDone: jest.fn(),
};

export function definePlugin(options: any) {
  return options;
}

export const Schema = {};
