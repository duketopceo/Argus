import { LANE_IDS } from '../report/manifest.js';
export { LANE_IDS };
export function defaultLaneSelection() {
    return { review: true, flow: false, app: false, a0: false };
}
export function selectionFromFlags(flags) {
    const selection = defaultLaneSelection();
    for (const lane of LANE_IDS) {
        if (flags[lane] !== undefined)
            selection[lane] = flags[lane];
    }
    return selection;
}
export function selectedLanes(selection) {
    return LANE_IDS.filter((lane) => selection[lane]);
}
