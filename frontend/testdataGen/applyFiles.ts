interface TestdataFile { name: string; content: string }

interface ApplyPayload {
  problemId: string;
  jobId?: string;
  files: Array<{ name: string; content?: string; fromJob?: true }>;
}

/** Large teacher edits use raw file parts, avoiding JSON escaping and the 8 MiB JSON body ceiling. */
export function buildTestdataApplyRequest(payload: ApplyPayload): { body: string | FormData; headers: Record<string, string> } {
  const json = JSON.stringify(payload);
  if (new Blob([json]).size <= 8 * 1024 * 1024) {
    return { body: json, headers: { 'Content-Type': 'application/json' } };
  }
  const form = new FormData();
  const files = payload.files.map((file, index) => {
    // Hydro's multipart parser rejects empty file parts; preserve empty edits inline.
    if (file.content === undefined || file.content === '') return file;
    const uploadField = `file-${index}`;
    form.append(uploadField, new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.name);
    return { name: file.name, uploadField };
  });
  form.append('payload', JSON.stringify({ ...payload, files }));
  return { body: form, headers: {} };
}

/** Reuse authorized server job data only when the teacher has not edited it. */
export function buildTestdataApplyFiles(
  files: readonly TestdataFile[],
  selected: Record<string, boolean>,
  contents: Record<string, string>,
  jobId: string | null,
): Array<{ name: string; content: string } | { name: string; fromJob: true }> {
  return files.filter(file => selected[file.name]).map(file => {
    const content = contents[file.name] ?? file.content;
    return jobId && content === file.content
      ? { name: file.name, fromJob: true }
      : { name: file.name, content };
  });
}
