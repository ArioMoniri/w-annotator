/**
 * The handle the app leaves on the window for tests (`src/main.tsx`).
 *
 * It is loosely typed on purpose, here and nowhere else. Tests reach into the session, the
 * engine and the store from inside the page, where a mask is known to be open and values are
 * known to be set; the app's own types would ask every call for checks that say nothing
 * about the app.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TestHandle = any;

interface Window {
  __w: {
    session: TestHandle;
    engine: TestHandle;
    store: TestHandle;
    settings: TestHandle;
    recovery: TestHandle;
    windowing: TestHandle;
  };
}
