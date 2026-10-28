// The app's shared runtime state: what every part of the UI reads (the loaded state, the current view and cursor,
// the items on screen…). Kept in its own module, imported first, so the feature modules can use it at any time.
export const LOCAL_COLOR = '#5b7c99';
export const app = {
  state: null, view: 'week', cursor: null, miniCursor: null,
  items: new Map(), lastBusy: [], scrolled: false, status: { text: '', kind: '' },
  shownProblems: new Set(), renderSeq: 0,
};
export const st = () => app.state;
export const tz = () => app.state.settings.tz;
export const set = () => app.state.settings;
