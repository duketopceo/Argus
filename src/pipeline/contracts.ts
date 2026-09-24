import { LANE_IDS, type LaneId } from '../report/manifest.js'

export { LANE_IDS }
export type { LaneId }

export interface LaneSelection {
  review: boolean
  flow: boolean
  app: boolean
  a0: boolean
}

export function defaultLaneSelection(): LaneSelection {
  return { review: true, flow: false, app: false, a0: false }
}

export function selectionFromFlags(flags: Partial<Record<LaneId, boolean>>): LaneSelection {
  const selection = defaultLaneSelection()
  for (const lane of LANE_IDS) {
    if (flags[lane] !== undefined) selection[lane] = flags[lane]
  }
  return selection
}

export function selectedLanes(selection: LaneSelection): LaneId[] {
  return LANE_IDS.filter((lane) => selection[lane])
}
