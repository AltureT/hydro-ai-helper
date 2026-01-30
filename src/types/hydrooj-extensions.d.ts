/**
 * HydroOJ 扩展类型定义
 * 补充 hydrooj 包中未完整导出的类型
 */

declare module 'hydrooj' {
  /**
   * 题目文档接口（简化版）
   */
  export interface ProblemDoc {
    _id: import('mongodb').ObjectId;
    docType: 10;
    docId: number;
    pid: string;
    domainId: string;
    title: string;
    content: string | Record<string, string>;
    owner: number;
    nSubmit?: number;
    nAccept?: number;
    difficulty?: number;
    tag?: string[];
    hidden?: boolean;
    html?: boolean;
  }

  /**
   * ProblemModel 类型定义
   */
  export const ProblemModel: {
    /**
     * 获取题目
     * @param domainId 域 ID
     * @param pid 题目 ID（数字或字符串）
     * @param projection 投影字段（可选）
     */
    get(
      domainId: string,
      pid: string | number,
      projection?: (keyof ProblemDoc)[]
    ): Promise<ProblemDoc | null>;

    /**
     * 检查用户是否可以查看题目
     */
    canViewBy(pdoc: ProblemDoc, user: { _id: number }): boolean;

    /** 公开字段投影 */
    PROJECTION_PUBLIC: (keyof ProblemDoc)[];
    /** 列表字段投影 */
    PROJECTION_LIST: (keyof ProblemDoc)[];
    /** 基础字段投影 */
    PROJECTION_BASE: (keyof ProblemDoc)[];
  };
}
