declare module 'hydrooj' {
  import { Collection, Db, Cursor } from 'mongodb';

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

  export const RecordModel: {
    getMulti(domainId: string, query: any): {
      sort(order: any): {
        limit(n: number): {
          project(projection: any): {
            toArray(): Promise<any[]>;
          };
        };
      };
    };
  };

  export const ProblemModel: any;

  // STATUS enum from @hydrooj/common, re-exported via builtin
  export const STATUS: {
    STATUS_WAITING: number;
    STATUS_ACCEPTED: number;
    STATUS_WRONG_ANSWER: number;
    STATUS_TIME_LIMIT_EXCEEDED: number;
    STATUS_MEMORY_LIMIT_EXCEEDED: number;
    STATUS_OUTPUT_LIMIT_EXCEEDED: number;
    STATUS_RUNTIME_ERROR: number;
    STATUS_COMPILE_ERROR: number;
    STATUS_SYSTEM_ERROR: number;
    STATUS_CANCELED: number;
    STATUS_ETC: number;
    STATUS_HACKED: number;
    STATUS_JUDGING: number;
    STATUS_COMPILING: number;
    STATUS_FETCHED: number;
    STATUS_IGNORED: number;
    STATUS_FORMAT_ERROR: number;
    [key: string]: number;
  };
}
