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
  PRIV_EDIT_SYSTEM: 2
};

export const db = {
  collection: jest.fn(() => ({
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    toArray: jest.fn().mockResolvedValue([])
  }))
};

export const ProblemModel = {
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
};

export function definePlugin(options: any) {
  return options;
}

export const Schema = {};
