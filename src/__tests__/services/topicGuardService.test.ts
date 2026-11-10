import { TopicGuardService } from '../../services/topicGuardService';

describe('TopicGuardService', () => {
  let service: TopicGuardService;

  beforeEach(() => {
    service = new TopicGuardService();
  });

  it('should mark off-topic request when matching off-topic keyword', () => {
    const result = service.evaluate('原神最近更新了什么？');
    expect(result.isOffTopic).toBe(true);
    expect(result.matchedKeyword).toBe('原神');
  });

  it('should not be bypassed by short substring matches like Minecraft -> int', () => {
    const result = service.evaluate('Minecraft 真好玩，聊聊剧情吧');
    expect(result.isOffTopic).toBe(true);
    expect(result.matchedKeyword).toBe('Minecraft');
  });

  it('should allow discussion when off-topic keyword appears in trusted problem title', () => {
    const result = service.evaluate('Minecraft 这题输入格式看不懂', {
      problemTitle: 'Minecraft 角色战力统计',
      problemContent: '给定 n 个角色，输出最强角色编号'
    });
    expect(result.isOffTopic).toBe(false);
  });

  it('should allow request when clear programming keywords are present', () => {
    const result = service.evaluate('原神这道题的算法复杂度怎么分析？');
    expect(result.isOffTopic).toBe(false);
  });

  it('should skip off-topic detection when code is attached', () => {
    const result = service.evaluate('帮我看看这个问题', { code: 'print("hello")' });
    expect(result.isOffTopic).toBe(false);
  });

  describe('code exemption threshold (FR-038)', () => {
    const code = 'for i in range(n):\n    total += a[i]\nprint(total)';

    it('exempts messages with real code attached', () => {
      expect(service.evaluate('原神好玩吗', { code }).isOffTopic).toBe(false);
    });

    it('does not let one or two characters of "code" bypass the check', () => {
      expect(service.evaluate('原神好玩吗', { code: 'a' }).isOffTopic).toBe(true);
      expect(service.evaluate('原神好玩吗', { code: ' x ;\n ' }).isOffTopic).toBe(true);
    });

    it('counts code length without whitespace against the configured threshold', () => {
      const padded = 'a b c d e f g h i j';
      expect(service.evaluate('原神好玩吗', { code: padded, codeExemptMinChars: 10 }).isOffTopic).toBe(false);
      expect(service.evaluate('原神好玩吗', { code: padded, codeExemptMinChars: 11 }).isOffTopic).toBe(true);
      expect(service.evaluate('原神好玩吗', { code: 'x', codeExemptMinChars: 0 }).isOffTopic).toBe(false);
    });
  });

  describe('custom keywords (FR-039)', () => {
    it('treats an administrator keyword as off-topic', () => {
      expect(service.evaluate('周末去哪里吃火锅', { customKeywords: ['火锅'] })).toEqual({ isOffTopic: true, matchedKeyword: '火锅' });
      expect(service.evaluate('周末去哪里吃火锅').isOffTopic).toBe(false);
    });

    it('still whitelists keywords that appear in the problem statement', () => {
      const result = service.evaluate('题目里的火锅店怎么排队？', {
        customKeywords: ['火锅'],
        problemTitle: '火锅店排队',
        problemContent: '有 n 位客人在火锅店门口排队……',
      });
      expect(result.isOffTopic).toBe(false);
    });

    it('ignores blank custom keywords', () => {
      expect(service.evaluate('今天学了什么', { customKeywords: ['', '   '] }).isOffTopic).toBe(false);
    });
  });
});
