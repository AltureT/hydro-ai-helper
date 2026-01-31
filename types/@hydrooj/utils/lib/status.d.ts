declare module '@hydrooj/utils/lib/status' {
  export const STATUS: {
    STATUS_ACCEPTED: number;
    STATUS_WRONG_ANSWER: number;
    STATUS_TIME_LIMIT_EXCEEDED: number;
    STATUS_MEMORY_LIMIT_EXCEEDED: number;
    STATUS_RUNTIME_ERROR: number;
    STATUS_COMPILE_ERROR: number;
    STATUS_SYSTEM_ERROR: number;
    STATUS_JUDGING: number;
    STATUS_WAITING: number;
    STATUS_IGNORED: number;
    [key: string]: number;
  };
}
