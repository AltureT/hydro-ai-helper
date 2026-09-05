import { TestdataPipelineError } from './failures';

export type OracleLanguage = 'python' | 'cpp';

function languageError(message: string): never {
  throw new TestdataPipelineError(message, 'SPEC_PARSE_FAILED', 'oracle', 'oracle',
    'repair-artifact', { failureKind: 'language' });
}

/** Recognize only a C++ opening statement, never keywords inside Python strings/comments. */
function hasCppOpening(source: string): boolean {
  let remaining = source.replace(/^\s*```[^\n]*\n/, '').trimStart();
  while (remaining) {
    const comment = remaining.match(/^(?:(?:#[^\n]*|\/\/[^\n]*)(?:\n|$)|\/\*[\s\S]*?\*\/)/);
    if (!comment) break;
    remaining = remaining.slice(comment[0].length).trimStart();
  }
  return [
    /^using\s+(?:namespace\s+\w+\s*;|\w+\s*=)/,
    /^(?:namespace\s+\w+\s*\{|template\s*<)/,
    /^(?:int|signed|auto)\s+main\s*\(/,
    /^(?:struct|class)\s+\w+(?:\s+final)?\s*(?:\{|:\s*(?:public|protected|private)\s+\w)/,
    /^(?:const\s+)?(?:int|long\s+long|double|bool|void)\s+\w+\s*[=;[(]/,
  ].some(pattern => pattern.test(remaining));
}

/** Explicit declarations are authoritative; legacy C++ code-only responses need a clear opening. */
export function parseOracleLanguage(
  raw: string,
  problemType: 'traditional' | 'function',
  source = '',
  fallback: OracleLanguage = 'python',
): OracleLanguage {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const declarations = [...text.matchAll(
    /(?:^|\r?\n)[ \t]*(?:@@@ORACLE_LANG@@@|===\s*ORACLE_LANG\s*===)[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*([^\r\n]*)/gi,
  )].map(match => {
    const value = match[1].trim().toLowerCase();
    if (['cpp', 'c++', 'cpp17', 'c++17'].includes(value)) return 'cpp' as const;
    if (['python', 'python3', 'python 3'].includes(value)) return 'python' as const;
    return languageError('ORACLE_LANG 必须为 python 或 cpp，不能把缺损或未知声明按 Python 执行。');
  });
  if (new Set(declarations).size > 1) languageError('ORACLE_LANG 存在互相冲突的声明。');
  const declared = declarations[0];
  const cpp = hasCppOpening(source);
  if (declared === 'python' && cpp) {
    languageError('ORACLE_LANG 声明为 python，但 ORACLE 是 C++ 程序；请同时修正语言声明与源码。');
  }
  const language = declared || (cpp ? 'cpp' : fallback);
  if (problemType === 'function' && language !== 'python') {
    languageError('函数题 ORACLE 必须使用 Python 3，不能把 C++ 源码重新标记为 Python。');
  }
  return language;
}
