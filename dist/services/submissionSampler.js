"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubmissionSampler = void 0;
const crypto_1 = require("crypto");
const MAX_SAMPLES = 5;
const CODE_TOKEN_BUDGET = 4000;
const CE_TOKEN_CAP = 500;
const SINGLE_CODE_MAX_TOKENS = 2000;
const TIME_GAP_MS = 10 * 60 * 1000;
const CHARS_PER_TOKEN = 3.5;
function estimateTokens(code) {
    return Math.ceil(code.length / CHARS_PER_TOKEN);
}
class SubmissionSampler {
    constructor() {
        // ── Step 1 helpers ───────────────────────────────────────────────────────────
        // ── Step 4: Priority sampling ─────────────────────────────────────────────────
        this.priorityOrder = [
            'final',
            'first_ac',
            'score_up',
            'first',
            'status_change',
            'lang_change',
            'time_gap',
        ];
    }
    normalizeCode(code, lang) {
        if (!code)
            return '';
        let normalized = code;
        if (['cpp', 'c', 'java', 'js', 'ts'].includes(lang)) {
            // Strip block comments first
            normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, ' ');
            // Strip single-line comments
            normalized = normalized.replace(/\/\/[^\n]*/g, ' ');
        }
        else if (['py', 'python'].includes(lang)) {
            // Strip Python single-line comments
            normalized = normalized.replace(/#[^\n]*/g, ' ');
        }
        // Collapse all whitespace (spaces, tabs, newlines) to single space and trim
        normalized = normalized.replace(/\s+/g, ' ').trim();
        return normalized;
    }
    hashCode(code, lang) {
        // Regex comment/whitespace stripping can change string literals. Only
        // byte-identical source in the same language is safe to deduplicate.
        return (0, crypto_1.createHash)('sha256').update(`${lang}\0${code}`).digest('hex').slice(0, 16);
    }
    hashDedup(submissions, lang) {
        if (submissions.length === 0)
            return [];
        const result = [];
        let i = 0;
        while (i < submissions.length) {
            const currentHash = this.hashCode(submissions[i].code, submissions[i].lang || lang);
            let j = i;
            // Advance j while adjacent hashes match
            while (j + 1 < submissions.length
                && this.hashCode(submissions[j + 1].code, submissions[j + 1].lang || lang) === currentHash
                && submissions[j + 1].status === submissions[i].status
                && submissions[j + 1].score === submissions[i].score) {
                j++;
            }
            // Preserve the original first-AC timestamp as well as the final record.
            result.push(submissions[i]);
            if (j !== i)
                result.push(submissions[j]);
            i = j + 1;
        }
        return result;
    }
    // ── Step 2: Merge consecutive CE ─────────────────────────────────────────────
    mergeCE(submissions) {
        if (submissions.length === 0)
            return [];
        const result = [];
        let i = 0;
        while (i < submissions.length) {
            if (submissions[i].status === 'CE') {
                let j = i;
                while (j + 1 < submissions.length && submissions[j + 1].status === 'CE') {
                    j++;
                }
                result.push(submissions[j]);
                i = j + 1;
            }
            else {
                result.push(submissions[i]);
                i++;
            }
        }
        return result;
    }
    // ── Step 3: Mark milestones ───────────────────────────────────────────────────
    markMilestones(submissions, original = submissions) {
        if (submissions.length === 0)
            return [];
        const result = submissions.map((s) => ({ ...s, milestones: [] }));
        let firstAcMarked = false;
        for (let i = 0; i < result.length; i++) {
            const curr = result[i];
            if (curr.recordId === original[0].recordId)
                curr.milestones.push('first');
            if (curr.recordId === original[original.length - 1].recordId)
                curr.milestones.push('final');
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
    primaryMilestone(milestones) {
        for (const p of this.priorityOrder) {
            if (milestones.includes(p))
                return p;
        }
        return 'evenly_spaced';
    }
    truncateCode(code, maxTokens) {
        const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
        if (code.length <= maxChars)
            return code;
        const half = Math.floor(maxChars / 2);
        return code.slice(0, half) + '\n[...truncated...]\n' + code.slice(code.length - half);
    }
    applyCodeConstraints(sub) {
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
    sample(submissions, lang) {
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
        const milestoned = this.markMilestones(ceMerged, submissions);
        // Step 4: Priority sampling
        // Sort candidates by priority, fill budget
        const priorityGroups = new Map();
        for (const p of [...this.priorityOrder, 'evenly_spaced']) {
            priorityGroups.set(p, []);
        }
        for (const sub of milestoned) {
            const primary = this.primaryMilestone(sub.milestones);
            const group = priorityGroups.get(primary);
            if (group)
                group.push(sub);
        }
        const selected = [];
        let tokenBudget = CODE_TOKEN_BUDGET;
        for (const p of [...this.priorityOrder, 'evenly_spaced']) {
            if (selected.length >= MAX_SAMPLES)
                break;
            const candidates = priorityGroups.get(p) ?? [];
            for (const sub of candidates) {
                if (selected.length >= MAX_SAMPLES)
                    break;
                // Check if already selected
                if (selected.some((s) => s.sub.recordId === sub.recordId))
                    continue;
                const duplicate = selected.find(s => s.sub.code === sub.code
                    && s.sub.lang === sub.lang && s.sub.status === sub.status && s.sub.score === sub.score);
                if (duplicate) {
                    // Repeated accepted source does not need another code block. Keep the
                    // real first-AC record and leave all repetitions in the full timeline.
                    if (p === 'first_ac') {
                        duplicate.sub = sub;
                        duplicate.primary = p;
                    }
                    continue;
                }
                const code = this.applyCodeConstraints(sub);
                const tokens = estimateTokens(code);
                if (tokenBudget - tokens < 0 && selected.length > 0)
                    continue;
                tokenBudget -= tokens;
                selected.push({ sub, primary: p });
            }
        }
        // Evenly-spaced fallback: if still under MAX_SAMPLES and budget remains
        if (selected.length < MAX_SAMPLES && tokenBudget > 0) {
            const remaining = milestoned.filter((sub) => !selected.some((s) => s.sub.recordId === sub.recordId
                || (s.sub.code === sub.code && s.sub.lang === sub.lang
                    && s.sub.status === sub.status && s.sub.score === sub.score)));
            if (remaining.length > 0) {
                const slots = MAX_SAMPLES - selected.length;
                const step = Math.max(1, Math.floor(remaining.length / slots));
                for (let i = 0; i < remaining.length && selected.length < MAX_SAMPLES; i += step) {
                    const sub = remaining[i];
                    const code = this.applyCodeConstraints(sub);
                    const tokens = estimateTokens(code);
                    if (tokenBudget - tokens < 0)
                        break;
                    tokenBudget -= tokens;
                    selected.push({ sub, primary: 'evenly_spaced' });
                }
            }
        }
        // Sort selected back into chronological order
        selected.sort((a, b) => a.sub.timestamp.getTime() - b.sub.timestamp.getTime());
        const sampledSubmissions = selected.map(({ sub, primary }) => ({
            recordId: sub.recordId,
            code: this.applyCodeConstraints(sub),
            status: sub.status,
            timestamp: sub.timestamp,
            milestone: primary,
        }));
        return { sampledSubmissions, allStatuses, submissionCount };
    }
}
exports.SubmissionSampler = SubmissionSampler;
//# sourceMappingURL=submissionSampler.js.map