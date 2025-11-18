# 测试数据快速准备示例

在测试环境中预先准备一定规模的会话数据可以让性能测试更贴近真实场景。以下两种方式任选其一。

## 方式一：使用脚本循环调用聊天接口
适合需要真实业务链路的场景，可与 `tests/performance/scripts/student-chat-k6.js` 类似：

```bash
export HYDRO_BASE_URL=http://127.0.0.1
export HYDRO_STUDENT_COOKIE="sid=..."

for i in {1..500}; do
  curl -s -X POST "$HYDRO_BASE_URL/ai-helper/chat" \
    -H 'Content-Type: application/json' \
    -H "Cookie: $HYDRO_STUDENT_COOKIE" \
    -d '{"problemId":"demo","questionType":"understand","userThinking":"第'$i'次压测造数，帮我解释这道题的思路"}' >/dev/null
  sleep 0.2
done
```

## 方式二：直接写入 MongoDB（伪造数据）
适合快速灌入大量会话以测试列表/导出接口。以下为 Mongo shell/`mongosh` 的示例，按需调整集合名与字段：

```javascript
// 在 mongosh 中执行
const conversations = db.getCollection('ai_conversations');
const messages = db.getCollection('ai_messages');

const now = new Date();
for (let i = 0; i < 2000; i++) {
  const conversation = {
    userId: 10000 + (i % 50),
    problemId: 'demo',
    classId: 'class-A',
    startTime: new Date(now.getTime() - i * 60000),
    endTime: now,
    messageCount: 6,
    isEffective: true,
    tags: ['loadtest'],
    metadata: { problemTitle: 'A+B Problem' }
  };

  const { insertedId } = conversations.insertOne(conversation);

  // 插入简化的消息列表
  for (let j = 0; j < 6; j++) {
    messages.insertOne({
      conversationId: insertedId,
      role: j % 2 === 0 ? 'student' : 'ai',
      content: `msg ${j} for conv ${i}`,
      timestamp: new Date(conversation.startTime.getTime() + j * 1000)
    });
  }
}
```

> 造数后请确认不会影响生产数据，推荐在独立测试数据库中执行。
