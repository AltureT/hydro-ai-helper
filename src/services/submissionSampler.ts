import { createHash } from 'crypto';
import { ObjectIdType } from '../utils/mongo';

export interface RawSubmission {
  recordId: ObjectIdType;
  code: string;
  status: string;
  score: number;
  lang: string;
  timestamp: Date;
  runtime: number;
  memory: number;
}

export interface SampledSubmission {
  recordId: ObjectIdType;
  code: string; // original code with comments (may be truncated)
  status: string;
  timestamp: Date;
  milestone: string; // primary milestone tag
}

export interface SampleResult {
  sampledSubmissions: SampledSubmission[];
  allStatuses: string[]; // full timeline as "ISO_timestamp:STATUS" strings
  submissionCount: number; // total original count
}

export interface MilestonedSubmission extends RawSubmission {
  milestones: string[];
}

const MAX_SAMPLES = 5;
const CODE_TOKEN_BUDGET = 4000;
const CE_TOKEN_CAP = 500;
const SINGLE_CODE_MAX_TOKENS = 2000;
const TIME_GAP_MS = 10 * 60 * 1000;
const CHARS_PER_TOKEN = 3.5;

function estimateTokens(code: string): number {
  return Math.ceil(code.length / CHARS_PER_TOKEN);
}

export class SubmissionSampler {
  // ── Step 1 helpers ───────────────────────────────────────────────────────────

  normalizeCode(code: string, lang: string): string {
    if (!code) return '';

    let normalized = code;

    if (['cpp', 'c', 'java', 'js', 'ts'].includes(lang)) {
      // Strip block comments first
      normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, ' ');
      // Strip single-line comments
      normalized = normalized.replace(/\/\/[^\n]*/g, ' ');
    } else if (['py', 'python'].includes(lang)) {
      // Strip Python single-line comments
      normalized = normalized.replace(/#[^\n]*/g, ' ');
    }

    // Collapse all whitespace (spaces, tabs, newlines) to single space and trim
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
  }

  private hashCode(code: string, lang: string): string {
    const normalized = this.normalizeCode(code, lang);
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  hashDedup(submissions: RawSubmission[], lang: string): RawSubmission[] {
    if (submissions.length === 0) return [];

    const result: RawSubmission[] = [];
    let i = 0;

    while (i < submissions.length) {
      const currentHash = this.hashCode(submissions[i].code, lang);
      let j = i;

      // Advance j while adjacent hashes match
      while (j + 1 < submissions.length && this.hashCode(submissions[j + 1].code, lang) === currentHash) {
        j++;
      }

      // Keep the last one in the run
      result.push(submissions[j]);
      i = j + 1;
    }

    return result;
  }

  // ── Step 2: Merge consecutive CE ─────────────────────────────────────────────

  private mergeCE(submissions: RawSubmission[]): RawSubmission[] {
    if (submissions.length === 0) return [];

    const result: RawSubmission[] = [];
    let i = 0;

    while (i < submissions.length) {
      if (submissions[i].status === 'CE') {
        let j = i;
        while (j + 1 < submissions.length && submissions[j + 1].status === 'CE') {
          j++;
        }
        result.push(submissions[j]);
        i = j + 1;
      } else {
        result.push(submissions[i]);
        i++;
      }
    }

    return result;
  }

  // ── Step 3: Mark milestones ───────────────────────────────────────────────────

  markMilestones(submissions: RawSubmission[]): MilestonedSubmission[] {
    if (submissions.length === 0) return [];

    const result: MilestonedSubmission[] = submissions.map((s) => ({ ...s, milestones: [] as string[] }));

    let firstAcMarked = false;

    for (let i = 0; i < result.length; i++) {
      const curr = result[i];

      if (i === 0) curr.milestones.push('first');
      if (i === result.length - 1) curr.milestones.push('final');

      if (curr.status === 'AC' && !firstAcMarked) {
        curr.milestones.push('first_ac');
        firstAcMarked = true;
      }

      if (i > 0) {
        const prev = result[i - 1];

        if (curr.score > prev.score) {
          curr.milestones.push('score_up');
        }

        if (curr.status !== prev.status) {
          curr.milestones.push('status_change');
        }

        if (curr.lang !== prev.lang) {
          curr.milestones.push('lang_change');
        }

        const gap = curr.timestamp.getTime() - prev.timestamp.getTime();
        if (gap > TIME_GAP_MS) {
          curr.milestones.push('time_gap');
        }
      }
    }

    return result;
  }

  // ── Step 4: Priority sampling ─────────────────────────────────────────────────

  private priorityOrder: string[] = [
    'final',
    'first_ac',
    'score_up',
    'first',
    'status_change',
    'lang_change',
    'time_gap',
  ];

  private primaryMilestone(milestones: string[]): string {
    for (const p of this.priorityOrder) {
      if (milestones.includes(p)) return p;
    }
    return 'evenly_spaced';
  }

  private truncateCode(code: string, maxTokens: number): string {
    const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
    if (code.length <= maxChars) return code;

    const half = Math.floor(maxChars / 2);
    return code.slice(0, half) + '\n[...truncated...]\n' + code.slice(code.length - half);
  }

  private applyCodeConstraints(sub: RawSubmission): string {
    let code = sub.code;

    if (sub.status === 'CE') {
      // CE cap: 500 tokens
      const maxChars = Math.floor(CE_TOKEN_CAP * CHARS_PER_TOKEN);
      if (code.length > maxChars) {
        code = code.slice(0, maxChars) + '\n[...truncated...]';
      }
      return code;
    }

    // Single code > 2000 tokens: keep first half + last half
    if (estimateTokens(code) > SINGLE_CODE_MAX_TOKENS) {
      code = this.truncateCode(code, SINGLE_CODE_MAX_TOKENS);
    }

    return code;
  }

  // ── Full pipeline ─────────────────────────────────────────────────────────────

  sample(submissions: RawSubmission[], lang: string): SampleResult {
    const submissionCount = submissions.length;

    if (submissionCount === 0) {
      return { sampledSubmissions: [], allStatuses: [], submissionCount: 0 };
    }

    // Build allStatuses from the original list
    const allStatuses = submissions.map((s) => `${s.timestamp.toISOString()}:${s.status}`);

    if (submissionCount === 1) {
      const sub = submissions[0];
      const code = this.applyCodeConstraints(sub);
      return {
        sampledSubmissions: [
          {
            recordId: sub.recordId,
            code,
            status: sub.status,
            timestamp: sub.timestamp,
            milestone: 'first+final',
          },
        ],
        allStatuses,
        submissionCount,
      };
    }

    // Step 1: Hash dedup
    const deduped = this.hashDedup(submissions, lang);

    // Step 2: Merge consecutive CE
    const ceMerged = this.mergeCE(deduped);

    // Step 3: Mark milestones
    const milestoned = this.markMilestones(ceMerged);

    // Step 4: Priority sampling
    // Sort candidates by priority, fill budget
    const priorityGroups: Map<string, MilestonedSubmission[]> = new Map();
    for (const p of [...this.priorityOrder, 'evenly_spaced']) {
      priorityGroups.set(p, []);
    }

    for (const sub of milestoned) {
      const primary = this.primaryMilestone(sub.milestones);
      const group = priorityGroups.get(primary);
      if (group) group.push(sub);
    }

    const selected: { sub: MilestonedSubmission; primary: string }[] = [];
    let tokenBudget = CODE_TOKEN_BUDGET;

    for (const p of [...this.priorityOrder, 'evenly_spaced']) {
      if (selected.length >= MAX_SAMPLES) break;
      const candidates = priorityGroups.get(p) ?? [];
      for (const sub of candidates) {
        if (selected.length >= MAX_SAMPLES) break;
        // Check if already selected
        if (selected.some((s) => s.sub.recordId === sub.recordId)) continue;
        const code = this.applyCodeConstraints(sub);
        const tokens = estimateTokens(code);
        if (tokenBudget - tokens < 0 && selected.length > 0) continue;
        tokenBudget -= tokens;
        selected.push({ sub, primary: p });
      }
    }

    // Evenly-spaced fallback: if still under MAX_SAMPLES and budget remains
    if (selected.length < MAX_SAMPLES && tokenBudget > 0) {
      const remaining = milestoned.filter(
        (sub) => !selected.some((s) => s.sub.recordId === sub.recordId)
      );
      if (remaining.length > 0) {
        const slots = MAX_SAMPLES - selected.length;
        const step = Math.max(1, Math.floor(remaining.length / slots));
        for (let i = 0; i < remaining.length && selected.length < MAX_SAMPLES; i += step) {
          const sub = remaining[i];
          const code = this.applyCodeConstraints(sub);
          const tokens = estimateTokens(code);
          if (tokenBudget - tokens < 0) break;
          tokenBudget -= tokens;
          selected.push({ sub, primary: 'evenly_spaced' });
        }
      }
    }

    // Sort selected back into chronological order
    selected.sort(
      (a, b) => a.sub.timestamp.getTime() - b.sub.timestamp.getTime()
    );

    const sampledSubmissions: SampledSubmission[] = selected.map(({ sub, primary }) => ({
      recordId: sub.recordId,
      code: this.applyCodeConstraints(sub),
      status: sub.status,
      timestamp: sub.timestamp,
      milestone: primary,
    }));

    return { sampledSubmissions, allStatuses, submissionCount };
  }
}
