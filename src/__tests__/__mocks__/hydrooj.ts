export class Handler {
  ctx: any = {};
  request: any = {};
  response: any = {};
  user?: any;
  args?: any;
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
    toArray: jest.fn().mockResolvedValue([])
  }))
};

export function definePlugin(options: any) {
  return options;
}

export const Schema = {};
