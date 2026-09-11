const DEBUG = process.env.ARGUS_DEBUG === '1' || process.env.ARGUS_DEBUG === 'true';
export function debug(kind, ...args) {
    if (!DEBUG)
        return;
    const prefix = `[argus-reviewer:${kind}]`;
    for (const arg of args) {
        if (typeof arg === 'string') {
            console.error(`${prefix} ${arg}`);
        }
        else {
            console.error(prefix, arg);
        }
    }
}
