import { LANE_IDS, type LaneId } from '../report/manifest.js';
export { LANE_IDS };
export type { LaneId };
export interface LaneSelection {
    review: boolean;
    flow: boolean;
    app: boolean;
    a0: boolean;
}
export declare function defaultLaneSelection(): LaneSelection;
export declare function selectionFromFlags(flags: Partial<Record<LaneId, boolean>>): LaneSelection;
export declare function selectedLanes(selection: LaneSelection): LaneId[];
