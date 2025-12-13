declare module 'hydrooj' {
  import { Collection, Db } from 'mongodb';

  export interface Context {
    Route(name: string, path: string, handler: any, privilege?: any): void;
    [key: string]: any;
  }

  export class Handler {
    ctx: Context;
    request: any;
    response: any;
    user?: any;
    args?: any;
  }

  export const PRIV: Record<string, any>;

  export function definePlugin<TConfig = any>(options: {
    name?: string;
    using?: (keyof Context)[];
    schema?: any;
    apply: (ctx: Context, config: TConfig) => void | Promise<void>;
  }): {
    name?: string;
    schema?: any;
    apply: (ctx: Context, config: TConfig) => void | Promise<void>;
  };

  export const Schema: any;

  export interface DbService {
    collection<T = any>(name: string): Collection<T>;
  }

  export const db: DbService;
}
