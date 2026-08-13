// Pure windowing helpers for the virtualized provider-group list in
// ModelSelectModal. Keeping the math here (instead of inside the component)
// makes it unit-testable and lets the render pass stay trivially cheap:
// computing offsets + the visible slice is O(groups) per render.

// Estimated sizes (px) used until a group is measured from the DOM.
// Deliberately conservative (a bit generous) so fast scrolls show the next
// group before its real size is known instead of a blank gap.
export const EST_GROUP_HEADER = 34; // header row (py + mb-1.5)
export const EST_BUTTON_ROW = 30; // one wrapped row of pill buttons + gap
export const EST_ITEMS_PER_ROW = 6; // rough pills per wrapped row
export const GROUP_PADDING_BOTTOM = 12; // pb-3 on the group wrapper

/**
 * Estimated rendered height of a provider group before it is measured.
 * @param {{models: Array}} group
 * @returns {number} px
 */
export function estimateGroupHeight(group) {
  const count = group?.models?.length || 0;
  const rows = Math.max(1, Math.ceil(count / EST_ITEMS_PER_ROW));
  return EST_GROUP_HEADER + rows * EST_BUTTON_ROW + GROUP_PADDING_BOTTOM;
}

/**
 * Compute the top offset of every group from measured (or estimated) heights.
 * @param {Array<[string, object]>} groups - Object.entries(filteredGroups)
 * @param {Record<string, number>} measured - providerId -> measured px
 * @returns {{ offsets: number[], total: number }}
 */
export function computeGroupOffsets(groups, measured = {}) {
  const offsets = new Array(groups.length);
  let total = 0;
  for (let i = 0; i < groups.length; i++) {
    offsets[i] = total;
    const [id, group] = groups[i];
    total += measured[id] ?? estimateGroupHeight(group);
  }
  return { offsets, total };
}

/**
 * Slice of groups that intersect the viewport (with overscan), as indexes
 * into `groups`. Returns start > end when nothing is visible (clamped scroll).
 * @param {number[]} offsets
 * @param {number} total
 * @param {number} scrollTop
 * @param {number} viewportH
 * @param {number} [overscan=2]
 * @returns {{ start: number, end: number }}
 */
export function visibleGroupRange(offsets, total, scrollTop, viewportH, overscan = 2) {
  const count = offsets.length;
  if (count === 0) return { start: 0, end: -1 };

  const top = Math.max(0, scrollTop);
  const bottom = scrollTop + Math.max(1, viewportH);

  let start = count;
  let end = -1;
  for (let i = 0; i < count; i++) {
    const gTop = offsets[i];
    const gBottom = i + 1 < count ? offsets[i + 1] : total;
    if (gBottom <= top || gTop >= bottom) continue;
    if (i < start) start = i;
    if (i > end) end = i;
  }

  if (end < start) {
    // Nothing intersected (e.g. scrollTop beyond the estimated total while
    // heights are still being measured): fall back to the group nearest the
    // viewport instead of rendering an empty window.
    const clampedTop = Math.max(0, Math.min(top, total - Math.max(1, viewportH)));
    for (let i = 0; i < count; i++) {
      const gTop = offsets[i];
      const gBottom = i + 1 < count ? offsets[i + 1] : total;
      if (clampedTop >= gTop && clampedTop < gBottom) {
        start = i;
        end = i;
        break;
      }
    }
    if (end < start) {
      start = count - 1;
      end = count - 1;
    }
  }

  start = Math.max(0, start - overscan);
  end = Math.min(count - 1, end + overscan);
  return { start, end };
}
