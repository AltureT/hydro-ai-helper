"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPythonTemplateInspection = buildPythonTemplateInspection;
exports.buildPythonTemplateExecution = buildPythonTemplateExecution;
exports.parsePythonTemplateInterfaceReport = parsePythonTemplateInterfaceReport;
exports.assertPythonTemplateInterface = assertPythonTemplateInterface;
exports.assertPythonTemplateExecutionDiagnostic = assertPythonTemplateExecutionDiagnostic;
const failures_1 = require("./failures");
const MARKER = 'HYDRO_TEMPLATE_INTERFACE:';
/** This program only parses source as data. It must run inside the execution sandbox. */
function inspectionProgram(solution, template) {
    return `import ast as _hydro_ast
import json as _hydro_json
import sys as _hydro_sys
_hydro_solution = ${JSON.stringify(solution)}
_hydro_template = ${JSON.stringify(template)}
def _hydro_inspect():
    try:
        solution_tree = _hydro_ast.parse(_hydro_solution)
    except (SyntaxError, ValueError):
        return {'kind': 'syntax', 'section': 'solution'}
    try:
        template_tree = _hydro_ast.parse(_hydro_template)
    except (SyntaxError, ValueError):
        return {'kind': 'syntax', 'section': 'template'}
    try:
        compile(_hydro_solution + '\\n' + _hydro_template, '/w/main.py', 'exec')
    except (SyntaxError, ValueError):
        return {'kind': 'syntax', 'section': 'template'}
    definitions = (_hydro_ast.FunctionDef, _hydro_ast.AsyncFunctionDef, _hydro_ast.ClassDef)
    protected = {node.name for node in solution_tree.body if isinstance(node, definitions)}
    class Bindings(_hydro_ast.NodeVisitor):
        def __init__(self):
            self.names = set()
        def visit_FunctionDef(self, node):
            self.names.add(node.name)
        visit_AsyncFunctionDef = visit_FunctionDef
        visit_ClassDef = visit_FunctionDef
        def visit_Lambda(self, node):
            pass
        visit_ListComp = visit_Lambda
        visit_SetComp = visit_Lambda
        visit_DictComp = visit_Lambda
        visit_GeneratorExp = visit_Lambda
        def visit_Name(self, node):
            if isinstance(node.ctx, (_hydro_ast.Store, _hydro_ast.Del)):
                self.names.add(node.id)
        def visit_Import(self, node):
            for item in node.names:
                self.names.add(item.asname or item.name.split('.')[0])
        def visit_ImportFrom(self, node):
            for item in node.names:
                if item.name == '*':
                    self.names.update(protected)
                else:
                    self.names.add(item.asname or item.name)
        def visit_Attribute(self, node):
            if isinstance(node.ctx, (_hydro_ast.Store, _hydro_ast.Del)):
                root = node.value
                while isinstance(root, _hydro_ast.Attribute):
                    root = root.value
                if isinstance(root, _hydro_ast.Name):
                    self.names.add(root.id)
            self.generic_visit(node)
    bindings = Bindings()
    bindings.visit(template_tree)
    conflicts = sorted(protected & bindings.names)
    return {'kind': 'conflict', 'names': conflicts[:30]} if conflicts else {'kind': 'ok'}
_hydro_report = _hydro_inspect()
`;
}
function buildPythonTemplateInspection(solution, template) {
    return inspectionProgram(solution, template) + 'print(_hydro_json.dumps(_hydro_report))\n';
}
/** The final execution also checks bindings, including runners without early inspection. */
function buildPythonTemplateExecution(solution, template) {
    return inspectionProgram(solution, template) + `if _hydro_report['kind'] != 'ok':
    _hydro_sys.stderr.write(${JSON.stringify(MARKER)} + _hydro_json.dumps(_hydro_report) + '\\n')
    raise SystemExit(86)
exec(compile(_hydro_solution + '\\n' + _hydro_template, '/w/main.py', 'exec'), {'__name__': '__main__', '__file__': '/w/main.py'})
`;
}
function parsePythonTemplateInterfaceReport(raw) {
    const value = JSON.parse(raw);
    if (value?.kind === 'ok' && Object.keys(value).length === 1)
        return value;
    if (value?.kind === 'conflict' && Object.keys(value).length === 2 && Array.isArray(value.names)
        && value.names.length > 0 && value.names.length <= 30
        && value.names.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 256))
        return value;
    if (value?.kind === 'syntax' && Object.keys(value).length === 2
        && ['solution', 'template'].includes(value.section))
        return value;
    throw new Error('Invalid Python template interface inspection result');
}
function assertPythonTemplateInterface(report) {
    if (report.kind === 'ok')
        return;
    const solution = report.kind === 'syntax' && report.section === 'solution';
    throw new failures_1.TestdataPipelineError(report.kind === 'conflict'
        ? `Python 模板重定义或覆盖了已验证接口：${(report.names || []).join(', ')}。删除占位定义、赋值或导入覆盖，只读取输入并调用既定接口；不得改写 SOLUTION。`
        : `Python ${solution ? 'SOLUTION' : '模板'}语法无效，必须修复对应源码。`, solution ? 'SPEC_PARSE_FAILED' : 'TEMPLATE_COMPILE_FAILED', solution ? 'oracle' : 'template', solution ? 'oracle' : 'template-py', 'repair-artifact', { failureKind: report.kind === 'conflict' ? 'interface' : 'syntax' });
}
function assertPythonTemplateExecutionDiagnostic(stderr) {
    const line = stderr.split('\n').find(item => item.startsWith(MARKER));
    if (!line || line.length > 12000)
        return;
    let report;
    try {
        report = parsePythonTemplateInterfaceReport(line.slice(MARKER.length));
    }
    catch {
        return;
    }
    assertPythonTemplateInterface(report);
}
//# sourceMappingURL=templateInterface.js.map