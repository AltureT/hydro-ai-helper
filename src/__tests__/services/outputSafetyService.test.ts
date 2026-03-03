import { OutputSafetyService } from '../../services/outputSafetyService';

describe('OutputSafetyService', () => {
  let service: OutputSafetyService;

  beforeEach(() => {
    service = new OutputSafetyService();
  });

  describe('sanitize - off-topic filtering', () => {
    it('should replace off-topic keywords', () => {
      const result = service.sanitize('来聊聊原神吧', {
        questionType: 'understand',
      });
      expect(result.content).not.toContain('原神');
      expect(result.content).toContain('该话题');
      expect(result.rewritten).toBe(true);
    });

    it('should replace clarify response with safe template when no programming content', () => {
      const result = service.sanitize('来聊聊原神的角色培养吧', {
        questionType: 'clarify',
      });
      expect(result.rewritten).toBe(true);
      expect(result.content).toContain('与编程学习无关');
    });

    it('should keep clarify response if programming content exists after rewrite', () => {
      const result = service.sanitize('原神里面也有循环机制', {
        questionType: 'clarify',
      });
      expect(result.rewritten).toBe(true);
      expect(result.content).not.toContain('与编程学习无关');
    });

    it('should whitelist keywords from problem content', () => {
      const result = service.sanitize('这道题涉及到Minecraft的红石电路', {
        questionType: 'understand',
        problemTitle: '编程模拟Minecraft红石',
        problemContent: 'Minecraft红石电路模拟',
      });
      expect(result.content).toContain('Minecraft');
    });
  });

  describe('sanitize - code leak detection', () => {
    it('should truncate code blocks with >5 real code lines', () => {
      const codeBlock = `\`\`\`python
def solve():
    n = int(input())
    arr = []
    for i in range(n):
        arr.append(int(input()))
    result = sorted(arr)
    for x in result:
        print(x)
\`\`\``;
      const aiResponse = `这道题可以这样做：\n${codeBlock}`;
      const result = service.sanitize(aiResponse, { questionType: 'debug' });

      expect(result.codeLeakDetected).toBe(true);
      expect(result.rewritten).toBe(true);
      expect(result.content).toContain('代码已被截断');
      expect(result.content).not.toContain('print(x)');
    });

    it('should keep code blocks with <=5 real code lines', () => {
      const codeBlock = `\`\`\`python
n = int(input())
arr = []
for i in range(n):
    arr.append(int(input()))
\`\`\``;
      const aiResponse = `提示：\n${codeBlock}`;
      const result = service.sanitize(aiResponse, { questionType: 'debug' });

      expect(result.codeLeakDetected).toBe(false);
      expect(result.content).toContain('arr.append');
    });

    it('should exempt optimize question type from code leak detection', () => {
      const codeBlock = `\`\`\`python
def solve():
    n = int(input())
    arr = []
    for i in range(n):
        arr.append(int(input()))
    result = sorted(arr)
    for x in result:
        print(x)
\`\`\``;
      const aiResponse = `优化分析：\n${codeBlock}`;
      const result = service.sanitize(aiResponse, { questionType: 'optimize' });

      expect(result.codeLeakDetected).toBe(false);
      expect(result.content).toContain('print(x)');
    });

    it('should not trigger on responses without code blocks', () => {
      const result = service.sanitize('你可以试试用循环来解决', {
        questionType: 'think',
      });
      expect(result.codeLeakDetected).toBe(false);
      expect(result.rewritten).toBe(false);
    });

    it('should not count comments and empty lines as real code', () => {
      const codeBlock = `\`\`\`python
# 这是一个示例
# 演示排序

n = int(input())

# 读取数据
arr = []

# 排序
result = sorted(arr)
\`\`\``;
      const result = service.sanitize(`提示：\n${codeBlock}`, {
        questionType: 'debug',
      });
      // Only 3 real code lines (n=, arr=, result=), should not truncate
      expect(result.codeLeakDetected).toBe(false);
    });

    it('should handle multiple code blocks', () => {
      const smallBlock = `\`\`\`python
x = 1
y = 2
\`\`\``;
      const largeBlock = `\`\`\`python
def main():
    n = int(input())
    for i in range(n):
        x = int(input())
        if x > 0:
            print(x)
        else:
            print(-x)
\`\`\``;
      const aiResponse = `正确片段：\n${smallBlock}\n完整代码：\n${largeBlock}`;
      const result = service.sanitize(aiResponse, { questionType: 'think' });

      expect(result.codeLeakDetected).toBe(true);
      // Small block should remain intact
      expect(result.content).toContain('x = 1');
      // Large block should be truncated
      expect(result.content).toContain('代码已被截断');
    });

    it('should preserve first 2 real code lines when truncating', () => {
      const codeBlock = `\`\`\`python
def solve():
    n = int(input())
    for i in range(n):
        x = int(input())
        if x > 0:
            print(x)
\`\`\``;
      const result = service.sanitize(`解法：\n${codeBlock}`, {
        questionType: 'understand',
      });

      expect(result.codeLeakDetected).toBe(true);
      expect(result.content).toContain('def solve():');
      expect(result.content).toContain('n = int(input())');
    });
  });
});
