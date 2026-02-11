/**
 * 偏题检测服务
 * 轻量级关键词匹配，不依赖额外模型
 */

// 编程相关关键词（命中任一即认为与编程相关）
const PROGRAMMING_KEYWORDS: string[] = [
  '代码', '函数', '变量', '循环', '数组', '列表', '字典', '集合',
  '算法', '排序', '递归', '栈', '队列', '二叉树', '图', '链表',
  'dp', 'dfs', 'bfs', '贪心', '二分', '搜索', '枚举', '模拟',
  '动态规划', '分治', '回溯', '字符串', '哈希', '前缀和',
  '报错', '错误', 'error', 'bug', 'debug', '调试', '运行',
  '编译', '输出', '输入', '样例', '测试', 'AC', 'WA', 'TLE', 'RE', 'MLE',
  '题目', '题意', '思路', '做法', '解题', '提交', '通过',
  '复杂度', '时间', '空间', 'O(n)', 'O(1)', '优化',
  '冒泡', '选择', '插入', '快排', '归并', '堆', '树状数组',
  '线段树', '并查集', '拓扑排序', '最短路', '最小生成树',
  'python', 'c++', 'java', 'cpp', 'code', 'function', 'variable',
  'array', 'loop', 'algorithm', 'recursion', 'complexity',
  'binary search', 'prefix sum', '编程', '程序'
];

// 跑题关键词（必须显式命中此表才标记偏题）
const OFF_TOPIC_KEYWORDS: string[] = [
  '原神', '崩坏', '王者荣耀', '英雄联盟', 'LOL', '我的世界', 'Minecraft',
  '绝地求生', 'PUBG', '使命召唤', '堡垒之夜', '明日方舟', '光遇',
  '蛋仔派对', '和平精英', '第五人格', '阴阳师', '梦幻西游',
  '穿越火线', 'CSGO', 'CS2', 'Dota', '星穹铁道', '鸣潮', '绝区零',
  '海贼王', '火影忍者', '进击的巨人', '鬼灭之刃', '咒术回战',
  '间谍过家家', '龙珠', '名侦探柯南', '死神', '银魂',
  '刀剑神域', '一拳超人', '全职猎人', '东京喰种', '约会大作战',
  '抖音', 'TikTok', '快手', '小红书',
  '猫娘', '女仆', 'AI女友', '恋爱模拟',
  '讲个笑话', '讲个故事', '写首诗', '写一篇作文',
  '今天天气', '帮我写情书', '你喜欢', '你觉得好看吗'
];

export interface TopicGuardResult {
  isOffTopic: boolean;
  matchedKeyword?: string;
}

export interface TopicGuardOptions {
  code?: string;
  problemTitle?: string;
  problemContent?: string;
}

const ASCII_TOKEN_REGEX = /^[a-z0-9_+\-.#]+$/i;

export class TopicGuardService {
  evaluate(userThinking: string, options: TopicGuardOptions = {}): TopicGuardResult {
    const { code, problemTitle, problemContent } = options;

    // 带代码的请求默认不判偏题
    if (code && code.trim().length > 0) {
      return { isOffTopic: false };
    }

    const text = this.normalize(userThinking);
    const whitelistSource = this.normalize(
      [problemTitle, problemContent].filter(Boolean).join(' ')
    );

    // 必须显式命中偏题关键词
    let matchedOffTopic: string | undefined;
    for (const keyword of OFF_TOPIC_KEYWORDS) {
      if (!this.matchesKeyword(text, keyword)) continue;
      // 题面/标题中已出现的关键词默认视为白名单，不计偏题
      if (whitelistSource && this.matchesKeyword(whitelistSource, keyword)) continue;
      matchedOffTopic = keyword;
      break;
    }

    if (!matchedOffTopic) {
      return { isOffTopic: false };
    }

    // 同时检查是否包含编程关键词（包含则不判偏题）
    for (const keyword of PROGRAMMING_KEYWORDS) {
      if (this.matchesKeyword(text, keyword)) {
        return { isOffTopic: false };
      }
    }

    return { isOffTopic: true, matchedKeyword: matchedOffTopic };
  }

  private normalize(text: string): string {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private matchesKeyword(text: string, keyword: string): boolean {
    const normalizedKeyword = this.normalize(keyword);
    if (!normalizedKeyword) {
      return false;
    }

    // ASCII 关键词使用单词边界，避免 "Fortnite" 命中 "for" 之类的子串绕过
    if (ASCII_TOKEN_REGEX.test(normalizedKeyword)) {
      const escaped = this.escapeRegExp(normalizedKeyword);
      const pattern = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i');
      return pattern.test(text);
    }

    return text.includes(normalizedKeyword);
  }
}
