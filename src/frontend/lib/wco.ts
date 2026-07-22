/** True when running under Window Controls Overlay (the OS¹ desktop shell or
 * an installed PWA). `html.wco` is set before the bundle runs by the detection
 * script in index.html, so reading it at render time is reliable.
 *
 * Lives here (not in a component module) so component files keep
 * component-only exports — a mixed export disqualifies the module from React
 * Fast Refresh and downgrades every edit to a full page reload. */
export const isWco = () => document.documentElement.classList.contains("wco");
