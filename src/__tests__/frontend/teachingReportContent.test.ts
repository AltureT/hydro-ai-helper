import { parseReviewActions, prepareStudentHomework } from '../../../frontend/teachingSummary/reportContent';
import MarkdownIt from 'markdown-it';

function question(number: number): string {
  return [
    `#### 第 ${number} 题：练习 ${number}（原题 ${number}）`,
    '**练习目的**：教师备课说明。',
    '##### 练习代码（可直接复制到试卷）',
    '```python',
    '# [空1] _____',
    'for i in range(3):',
    '    print(i)',
    '```',
    '##### 变式思考（选做）',
    '如果输入为空，会发生什么？',
    '##### 建议挖空点说明（教师参考答案，勿下发）',
    '| 空号 | 参考答案 |',
    '|---|---|',
    '| 空1 | TEACHER_ONLY_ANSWER |',
  ].join('\n\n');
}

describe('student homework export', () => {
  it('exports every exercise and question while excluding teaching notes and reference answers', () => {
    const result = prepareStudentHomework([
      '### 📝 课后巩固作业（适用于全年段）',
      '> 使用说明：参考答案请勿下发。',
      question(1), question(2),
    ].join('\n\n'));
    expect(result.questionCount).toBe(2);
    expect(result.studentMarkdown).toContain('第 1 题');
    expect(result.studentMarkdown).toContain('第 2 题');
    expect(result.studentMarkdown).toContain('    print(i)');
    expect(result.studentMarkdown).toContain('# [空1] _____');
    expect(result.studentMarkdown).toContain('如果输入为空');
    expect(result.studentMarkdown).not.toMatch(/TEACHER_ONLY|教师|参考答案|练习目的|使用说明/);
  });

  it('ignores heading-like comments inside fences and supports CRLF', () => {
    const input = question(1).replace('    print(i)', '    print(i)\n### A Python comment');
    const result = prepareStudentHomework(input.replace(/\n/g, '\r\n'));
    expect(result.questionCount).toBe(1);
    expect(result.studentMarkdown).toContain('### A Python comment');
  });

  it('supports tildes and four-backtick exercise fences', () => {
    for (const marker of ['~~~', '````']) {
      expect(prepareStudentHomework(question(1).replace(/```/g, marker)).questionCount).toBe(1);
    }
  });

  it('never promotes exercises nested inside a teacher section into the student export', () => {
    const nestedTeacherExercise = [
      '#### 第 1 题：仅有教师解答',
      '##### 教师参考',
      '###### 练习代码',
      '```python\nprint("TEACHER_ONLY_ANSWER")\n```',
      '###### 变式思考',
      '完整解答在上方。',
    ].join('\n\n');
    expect(prepareStudentHomework(nestedTeacherExercise).studentMarkdown).toBeNull();
    expect(prepareStudentHomework(nestedTeacherExercise.replace('##### 教师参考', '##### 📝 **教师参考**')).studentMarkdown).toBeNull();
    const complete = prepareStudentHomework(question(1) + '\n\n###### 练习代码\n\nTEACHER_ONLY_NESTED\n\n' + question(2));
    expect(complete.questionCount).toBe(2);
    expect(complete.studentMarkdown).not.toContain('TEACHER_ONLY');
    expect(prepareStudentHomework('### 教师参考\n\n' + question(1)).studentMarkdown).toBeNull();
    expect(prepareStudentHomework('### 📝 **答案**\n\n' + question(1)).studentMarkdown).toBeNull();
    expect(prepareStudentHomework('### 参考解答\n\n' + question(1)).studentMarkdown).toBeNull();
  });

  it('preserves the interpreted Python indentation of an indented fence', () => {
    const input = question(1).replace(/```python[\s\S]*?```/, block => (
      block.split('\n').map(line => '  ' + line).join('\n')
    ));
    const student = prepareStudentHomework(input).studentMarkdown;
    expect(student).not.toBeNull();
    const md = new MarkdownIt();
    const originalCode = md.parse(input, {}).find(token => token.type === 'fence')!.content;
    const exportedCode = md.parse(student!, {}).find(token => token.type === 'fence')!.content;
    expect(exportedCode).toBe(originalCode);
    expect(exportedCode).toContain('for i in range(3):');
  });

  it.each([
    '',
    '旧版未分段作业与参考答案混排',
    question(1).replace('练习代码（可直接复制到试卷）', '完整参考代码'),
    question(1).replace('变式思考（选做）', '参考解答'),
    question(1).replace('如果输入为空，会发生什么？', '参考答案：不执行循环'),
    question(1).replace('如果输入为空，会发生什么？', '如果输入为空呢？\n\n**答案**：不执行循环'),
    question(1).replace('如果输入为空，会发生什么？', '输入为空时？答案：不执行循环'),
    question(1).replace('如果输入为空，会发生什么？', '1. **解答**：不执行循环'),
    question(1).replace('如果输入为空，会发生什么？', '如果输入为空呢？\n\n**答案**\n\n不执行循环'),
    question(1).replace('如果输入为空，会发生什么？', '如果输入为空呢？\n\n**答**案：不执行循环'),
    question(1).replace('如果输入为空，会发生什么？', '如果输入为空呢？\n\n> 📝 **Answer**\n> Nothing happens.'),
    question(1).replace('```python', '下面是参考答案。\n\n```python'),
    question(1) + '\n\n##### 补充答案\n\nTEACHER_ONLY_EXTRA',
    question(1) + '\n\n#### 第 2 题：不完整的练习',
    question(1).replace('如果输入为空，会发生什么？', '查看[提示][p1]。') + '\n\n[p1]: https://example.com/hint',
  ])('does not offer export for an ambiguous or incomplete document (%#)', input => {
    expect(prepareStudentHomework(input).studentMarkdown).toBeNull();
  });
});

describe('review action presentation', () => {
  const table = [
    '| 优先级 | 要回顾的问题 | 建议课堂动作（2-5分钟） |',
    '|---|---|---|',
    '| 1 | 4 人出现 CE | 投影 `a \\| b`，讨论含义 |',
    '| 2 | 边界条件 | 对比 **空输入** 与单个元素 |',
  ].join('\n');

  it('preserves row order, escaped pipes and inline markdown', () => {
    expect(parseReviewActions(table)).toEqual([
      { priority: '1', problem: '4 人出现 CE', action: '投影 `a | b`，讨论含义' },
      { priority: '2', problem: '边界条件', action: '对比 **空输入** 与单个元素' },
    ]);
  });

  it.each([
    '1. 先检查语法',
    '| 行为模式 | 人数 | 建议动作 |\n|---|---|---|\n| 未参与 | 2 | 单独询问 |',
    table + '\n\n附加说明必须保留',
    table + '\n\n' + table,
    table.replace('4 人出现 CE', '[题目一][p1]') + '\n\n[p1]: /p/1',
  ])('falls back to the original report when the structure differs (%#)', input => {
    expect(parseReviewActions(input)).toBeNull();
  });
});
