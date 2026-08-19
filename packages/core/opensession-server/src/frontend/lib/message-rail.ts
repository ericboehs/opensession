/**
 * Geometry shared by the message rail (components/MessageRail.tsx) and the
 * transcript layout that leaves room for it (lib/session-viewer-classes.ts).
 *
 * The rail sits in the LEFT gutter, beside the reading column. It cannot
 * overlap that column: an invisible hit strip over the prose would swallow the
 * selection drags that stage a quote. The column is centred and capped, so a
 * wide pane has gutters to spare and a narrow one has none, which is why the
 * room is reserved here rather than hoped for.
 *
 * The left edge is also the one edge no scrollbar can reach. On the right, a
 * macOS scrollbar is an overlay that reserves NO layout width, so
 * `offsetWidth - clientWidth` is 0 there and a rail placed at the measured
 * inset lands under the thumb and fights it for every drag, while measuring
 * perfectly on a Linux verification browser that paints classic scrollbars.
 * That is how the first attempt at a rail shipped broken for every Mac user.
 * Here the question cannot come up.
 *
 * The reservation is keyed to the same static media condition that shows the
 * rail, never to whether a session currently HAS one. A gutter that appeared
 * with a session's second message would shift the column out from under the
 * reader mid-conversation, which costs more than the space it saves.
 */

/** Width of the rail's hit strip. */
export const RAIL_W = 22;

/** Kept clear outboard of the rail, so it reads as sitting in a margin rather
 *  than against the pane's edge. */
export const RAIL_EDGE = 15;

/** What the transcript keeps clear at each side for the rail to live in. Both
 *  sides, so the column stays centred. */
export const RAIL_GUTTER = RAIL_W + RAIL_EDGE;

/**
 * That gutter as padding, for the transcript scroller and the composer under
 * it. Both take it so the column and the input stay on the same edges.
 *
 * Written out rather than built from {@link RAIL_GUTTER}: Tailwind compiles
 * the class names it can find in the source, so an interpolated one compiles
 * to nothing. message-rail.test.ts asserts the two agree.
 *
 * Applied on both sides, so the column stays centred, and only where the rail
 * can be used: a hover rail is meaningless on touch, and at phone widths there
 * is no room to give away. Both conditions stack into one query so neither can
 * out-order the other.
 */
export const RAIL_GUTTER_CLASS = "desktop:[@media(hover:hover)]:px-[37px]";
