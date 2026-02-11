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
});
