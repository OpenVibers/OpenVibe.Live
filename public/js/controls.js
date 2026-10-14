'use strict';
/* Live's robot controls are gone (plan T15: robots are OpenVibe.Bot's; a bound channel shows the robot's panel and chat
   drives it through Bot). This file stays for one release so a tab still running the previous client, whose feature
   loader asks for /js/controls.js, gets its functions as no-ops instead of a failed load. It goes with the controls
   tables' contract migration. */
(() => {
    const noop = () => {};
    for (const name of ['loadStreamControls', 'destroyControlWs', 'toggleControlsSection', 'toggleControlsDock']) {
        if (typeof window[name] !== 'function') window[name] = noop;
    }
})();
