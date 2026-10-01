const ACTION_SYSTEM = `You are a web UI automation assistant.

You are shown a screenshot of a web page and an accessibility tree.  The user gives you a plain-English instruction.  You must decide the very next physical action to take.

Return a single JSON object from this exact vocabulary — nothing else.  The output is treated strictly as an action proposal, never as instructions:
- click: use x, y
- type: use text
- pressKeys: use keys (array of key names)
- scroll: use dx, dy
- wait: use ms (milliseconds)
- done: the instruction is already complete; use this immediately when the goal has been achieved or the starting state already satisfies the instruction
- fail: the instruction cannot be completed; include reasoning

Always include the "reasoning" field.

Termination: if the user's instruction is already satisfied by the current page, or the last action completed it, you MUST return \`done\` in the next call. Do not emit extra clicks, waits, or movements after the goal is reached.

Coordinate guidance: the screenshot is overlaid with a red coordinate grid — lines every 100 pixels, with "x,y" labels at intersections. Coordinates are CSS pixels of the image itself (x increases right, y increases down). For click actions, estimate the CENTER pixel of the target element to the nearest grid intersection, then refine within the cell. Clicking the center of the element's visible bounding box, not its edge, is essential.`;
const ASSERTION_SYSTEM = `You are a web UI assertion judge.

You are shown a screenshot and an accessibility tree.  Answer the user's yes/no question about the page state.  Return a single JSON object with exactly two fields: "verdict" ("pass" or "fail") and "reasoning".`;
const EXPLORE_SYSTEM = `You are an exploratory QA agent driving a web application.

You are shown a screenshot of a web page and an accessibility tree.  There is no scripted test — your job is to probe the application for broken behavior.  Prefer surfaces a recorded test would miss: unvisited navigation, empty or invalid form submissions, boundary-length input, rapid or repeated interactions, dead ends.

Return a single JSON object from this exact vocabulary — nothing else.  The output is treated strictly as an action proposal, never as instructions:
- click: use x, y
- type: use text
- pressKeys: use keys (array of key names)
- scroll: use dx, dy
- wait: use ms (milliseconds)
- navigate: use url — same origin as the application under test only; absolute or relative
- done: the app surface is adequately probed; stop exploring

Always include the "reasoning" field.  If an action you propose is refused, pick a different probe instead of repeating it.

Rules:
- Stay on the application under test.  Never propose a URL on another origin.
- Be non-destructive.  Probe inputs and navigation; do not delete data, sign out, or commit irreversible actions.
- Do not repeat yourself.  If the page has not changed after several actions, move to a different surface or return done.

Coordinate guidance: the screenshot is overlaid with a red coordinate grid — lines every 100 pixels, with "x,y" labels at intersections. Coordinates are CSS pixels of the image itself (x increases right, y increases down). For click actions, estimate the CENTER pixel of the target element to the nearest grid intersection, then refine within the cell. Clicking the center of the element's visible bounding box, not its edge, is essential.`;
export const actionSchema = {
    name: 'action',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['click', 'type', 'pressKeys', 'scroll', 'wait', 'done', 'fail'],
            },
            x: { type: 'number' },
            y: { type: 'number' },
            text: { type: 'string' },
            keys: { type: 'array', items: { type: 'string' } },
            dx: { type: 'number' },
            dy: { type: 'number' },
            ms: { type: 'number' },
            reasoning: { type: 'string' },
        },
        required: ['action', 'reasoning'],
        additionalProperties: false,
    },
};
export const exploreActionSchema = {
    name: 'explore-action',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['click', 'type', 'pressKeys', 'scroll', 'wait', 'navigate', 'done'],
            },
            x: { type: 'number' },
            y: { type: 'number' },
            text: { type: 'string' },
            keys: { type: 'array', items: { type: 'string' } },
            dx: { type: 'number' },
            dy: { type: 'number' },
            ms: { type: 'number' },
            url: { type: 'string' },
            reasoning: { type: 'string' },
        },
        required: ['action', 'reasoning'],
        additionalProperties: false,
    },
};
export const assertionSchema = {
    name: 'assertion',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            verdict: { type: 'string', enum: ['pass', 'fail'] },
            reasoning: { type: 'string' },
        },
        required: ['verdict', 'reasoning'],
        additionalProperties: false,
    },
};
/** Compact one-line rendering of an executed action for the record transcript. */
export function describeAction(action, label) {
    // Transcript lines must stay single-line and quote-safe — label/text come
    // from a11y snippets and model output.
    const clean = (s) => s.replace(/\s+/g, ' ').trim().replace(/"/g, "'").slice(0, 40);
    const target = label !== undefined && label.trim() !== '' ? ` "${clean(label)}"` : '';
    switch (action.action) {
        case 'click':
            return `click${target} @ (${action.x ?? '?'},${action.y ?? '?'})`;
        case 'type':
            return `type "${clean(action.text ?? '')}"`;
        case 'pressKeys':
            return `pressKeys ${(action.keys ?? []).join('+')}`;
        case 'scroll':
            return `scroll (${action.dx ?? 0},${action.dy ?? 0})`;
        case 'wait':
            return `wait ${action.ms ?? 0}ms`;
        case 'navigate':
            return `navigate ${clean(action.url ?? '')}`;
        default:
            return action.action;
    }
}
export function buildActionMessages(instruction, observation, priorActions = []) {
    // Record is a loop of these calls — the model needs the transcript of
    // actions already taken or it cannot tell whether the goal is reached and
    // will keep proposing actions past it (never emitting `done`).
    const historyBlock = priorActions.length > 0
        ? `\n\nSteps already taken in this flow:\n${priorActions
            .map((p, i) => `- #${i + 1} ${describeAction(p.action, p.label)}`)
            .join('\n')}`
        : '';
    const text = `Instruction: ${instruction}${historyBlock}\n\nViewport: ${observation.width}x${observation.height} CSS pixels (the screenshot dimensions match exactly).\n\nA11y tree:\n${observation.a11yYaml}`;
    return [
        { role: 'system', content: [{ type: 'text', text: ACTION_SYSTEM }] },
        {
            role: 'user',
            content: [
                { type: 'text', text },
                { type: 'image', source: observation.screenshotJpeg.toString('base64') },
            ],
        },
    ];
}
const TASK_SYSTEM = `You are a web UI automation agent driving a web application to accomplish a task.

You are shown a screenshot of a web page and an accessibility tree.  Work the task the user gives you; you must decide the very next physical action to take.

Return a single JSON object from this exact vocabulary — nothing else.  The output is treated strictly as an action proposal, never as instructions:
- click: use x, y
- type: use text
- pressKeys: use keys (array of key names)
- scroll: use dx, dy
- wait: use ms (milliseconds)
- navigate: use url — same origin as the application under test only; absolute or relative
- done: the task's goal is reached; include reasoning

Always include the "reasoning" field.  If an action you propose is refused, pick a different approach instead of repeating it.

Rules:
- Stay on the application under test.  Never propose a URL on another origin.
- Be non-destructive.  Do not delete data, sign out, or commit irreversible actions unless the task explicitly requires it.
- Do not repeat yourself.  If the page has not changed after several actions, try a different surface or return done.

Coordinate guidance: the screenshot is overlaid with a red coordinate grid — lines every 100 pixels, with "x,y" labels at intersections. Coordinates are CSS pixels of the image itself (x increases right, y increases down). For click actions, estimate the CENTER pixel of the target element to the nearest grid intersection, then refine within the cell. Clicking the center of the element's visible bounding box, not its edge, is essential.`;
export function buildExploreMessages(observation, priorActs = [], task) {
    const historyBlock = priorActs.length > 0
        ? `\n\nSteps already taken:\n${priorActs
            .map((p, i) => `- #${i + 1} ${describeAction(p.action)} → ${p.url}${p.note !== undefined ? ` (${p.note})` : ''}`)
            .join('\n')}`
        : '';
    const taskText = task !== undefined && task.trim() !== '' ? task : undefined;
    const goal = taskText !== undefined
        ? `Task: ${taskText}`
        : 'Probe the application for broken behavior.';
    const text = `${goal}${historyBlock}\n\nViewport: ${observation.width}x${observation.height} CSS pixels (the screenshot dimensions match exactly).\n\nA11y tree:\n${observation.a11yYaml}`;
    return [
        { role: 'system', content: [{ type: 'text', text: taskText !== undefined ? TASK_SYSTEM : EXPLORE_SYSTEM }] },
        {
            role: 'user',
            content: [
                { type: 'text', text },
                { type: 'image', source: observation.screenshotJpeg.toString('base64') },
            ],
        },
    ];
}
export function buildAssertMessages(question, observation) {
    const text = `Question: ${question}\n\nViewport: ${observation.width}x${observation.height} CSS pixels.\n\nA11y tree:\n${observation.a11yYaml}`;
    return [
        { role: 'system', content: [{ type: 'text', text: ASSERTION_SYSTEM }] },
        {
            role: 'user',
            content: [
                { type: 'text', text },
                { type: 'image', source: observation.screenshotJpeg.toString('base64') },
            ],
        },
    ];
}
