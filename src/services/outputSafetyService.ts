/**
 * 输出安全后处理服务
 * 轻量级 AI 回复清洗，不依赖 LLM 二次调用
 */

import type { QuestionType } from './promptService';

// 常见跑题关键词词典（游戏名、动漫名等热门内容）
const OFF_TOPIC_KEYWORDS: string[] = [
  // 游戏
  '原神', '崩坏', '王者荣耀', '英雄联盟', 'LOL', '我的世界', 'Minecraft',
  '绝地求生', 'PUBG', '使命召唤', '堡垒之夜', 'Fortnite', '明日方舟',
  '光遇', '蛋仔派对', '和平精英', '第五人格', '阴阳师', '梦幻西游',
  '穿越火线', 'CSGO', 'CS2', 'Dota', '星穹铁道', '鸣潮', '绝区零',
  // 动漫/影视
  '海贼王', '火影忍者', '进击的巨人', '鬼灭之刃', '咒术回战',
  '间谍过家家', '龙珠', '名侦探柯南', '死神', '银魂',
  '刀剑神域', '一拳超人', '全职猎人', '东京喰种', '约会大作战',
  // 社交/娱乐
  '抖音', 'TikTok', 'B站', '快手', '微博', '小红书',
  // 网络用语/角色扮演
  '猫娘', '女仆', 'AI女友', '恋爱'
];

export interface SanitizeOptions {
  questionType: QuestionType;
  problemTitle?: string;
  problemContent?: string;
}

export interface SanitizeResult {
  content: string;
  rewritten: boolean;
  codeLeakDetected?: boolean;
}

const CODE_BLOCK_REGEX = /```\w*\n([\s\S]*?)```/g;
const CODE_LINE_PATTERN = /^\s*(def\s|for\s|if\s|elif\s|else\s*:|while\s|return\b|print\s*\(|import\s|from\s|class\s|try\s*:|except\b|raise\s|with\s|yield\b|assert\b|break\b|continue\b|pass\b|\w+\s*=[^=])/;
const CODE_LEAK_THRESHOLD = 5;
const CODE_LEAK_KEEP_LINES = 2;

export class OutputSafetyService {
  sanitize(aiResponse: string, options: SanitizeOptions): SanitizeResult {
    const { problemTitle, problemContent } = options;

    // 构建白名单：题目标题和内容中出现的关键词不需要过滤
    const whitelist = new Set<string>();
    const whitelistSource = [problemTitle, problemContent].filter(Boolean).join(' ');

    let rewritten = false;
    let result = aiResponse;

    for (const keyword of OFF_TOPIC_KEYWORDS) {
      if (whitelistSource.includes(keyword)) {
        whitelist.add(keyword);
        continue;
      }
      // 检测 AI 回复中是否包含跑题关键词
      if (result.includes(keyword)) {
        result = result.split(keyword).join('该话题');
        rewritten = true;
      }
    }

    // 如果是 clarify 回复且被改写、且完全无编程关键词，替换为安全模板
    if (options.questionType === 'clarify' && rewritten) {
      const hasProgrammingContent = /(?:代码|函数|变量|循环|数组|列表|算法|排序|递归|栈|队列|二叉树|图|dp|dfs|bfs|print|if|for|while|def|class|return|import|int|str|float|input|output)/i.test(result);
      if (!hasProgrammingContent) {
        result = '这个内容与编程学习无关，我无法解释。请选中 AI 回复中与代码或算法相关的部分来追问。';
        rewritten = true;
      }
    }

    // 代码泄露检测（optimize 类型豁免）
    const codeLeakResult = this.detectCodeLeak(result, options.questionType);
    if (codeLeakResult.detected) {
      result = codeLeakResult.content;
      rewritten = true;
    }

    return { content: result, rewritten, codeLeakDetected: codeLeakResult.detected };
  }

  private detectCodeLeak(
    content: string,
    questionType: QuestionType
  ): { content: string; detected: boolean } {
    if (questionType === 'optimize') {
      return { content, detected: false };
    }

    let detected = false;

    const result = content.replace(
      CODE_BLOCK_REGEX,
      (match, codeContent: string) => {
        const lines = codeContent.split('\n');
        const realCodeLines = lines.filter((line) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          if (trimmed.startsWith('#')) return false;
          if (trimmed.startsWith('//')) return false;
          return CODE_LINE_PATTERN.test(line);
        });

        if (realCodeLines.length > CODE_LEAK_THRESHOLD) {
          detected = true;
          const kept = realCodeLines.slice(0, CODE_LEAK_KEEP_LINES).join('\n');
          const langMatch = match.match(/^```(\w*)/);
          const lang = langMatch ? langMatch[1] : '';
          return `\`\`\`${lang}\n${kept}\n# ... 代码已被截断（教学模式不展示完整实现）...\n\`\`\``;
        }

        return match;
      }
    );

    return { content: result, detected };
  }
}
