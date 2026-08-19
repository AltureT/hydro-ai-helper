export interface StatementSample {
  id: string;
  input: string;
  output: string;
}

function normalizeFileContent(content: string): string {
  const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (lf === '') return '\n';
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

function comparableFileContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd();
}

/**
 * Extract supported Hydro inputN/outputN fences and inline input/output pairs.
 * Risk grading reuses this exact parser so a recognized production sample never
 * becomes a false "no sample" risk signal.
 */
export function extractStatementSamples(statementMarkdown: string): StatementSample[] {
  const inputs: Array<{ id: string; content: string }> = [];
  const outputs: Array<{ id: string; content: string }> = [];
  const fenceRe = /```(input|output)(\d*)[^\n]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(statementMarkdown)) !== null) {
    let content = match[3].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (content.endsWith('\n')) content = content.slice(0, -1);
    const entry = { id: match[2], content: normalizeFileContent(content) };
    if (match[1].toLowerCase() === 'input') inputs.push(entry);
    else outputs.push(entry);
  }

  const samples = inputs.flatMap((input, index) => {
    const output = input.id
      ? outputs.find(candidate => candidate.id === input.id)
      : outputs[index];
    return output ? [{ id: input.id || String(index + 1), input: input.content, output: output.content }] : [];
  });

  const normalized = statementMarkdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const inputLineRe = /^\s*(?:输入|Input)\s*[:：]\s*(\S[\s\S]*?)\s*$/i;
  const outputLineRe = /^\s*(?:输出|Output)\s*[:：]\s*(\S[\s\S]*?)\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    const inputMatch = lines[i].match(inputLineRe);
    if (!inputMatch) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (inputLineRe.test(lines[j])) break;
      const outputMatch = lines[j].match(outputLineRe);
      if (!outputMatch) continue;
      const input = normalizeFileContent(inputMatch[1].replace(/^`([\s\S]*)`$/, '$1'));
      const output = normalizeFileContent(outputMatch[1].replace(/^`([\s\S]*)`$/, '$1'));
      const duplicate = samples.some(sample =>
        comparableFileContent(sample.input) === comparableFileContent(input)
        && comparableFileContent(sample.output) === comparableFileContent(output));
      if (!duplicate) {
        samples.push({ id: String(samples.length + 1), input, output });
      }
      i = j;
      break;
    }
  }

  return samples;
}

export function hasParseableStatementSamples(statementMarkdown: string): boolean {
  return extractStatementSamples(statementMarkdown).length > 0;
}
