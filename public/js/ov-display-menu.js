/* Display settings in the user menu. The state lives in the shared theme loader
 * (OpenVibeThemeLoader.display): same keys, same account sync, same behaviour as every other OpenVibe site. */
(function () {
    'use strict';
    var box = document.getElementById('ud-display'), L = window.OpenVibeThemeLoader;
    if (!box || !L || !L.display) { if (box) box.style.display = 'none'; return; }
    var LABEL = { text: { '100': 'Default', '112': 'Large', '125': 'Largest' }, motion: { auto: 'On', reduced: 'Calm' } };
    function paint() { var d = L.display.get(); box.querySelectorAll('[data-ov-display]').forEach(function (a) { var k = a.getAttribute('data-ov-display'); a.querySelector('[data-v]').textContent = LABEL[k][d[k]]; }); }
    box.addEventListener('click', function (e) {
        var a = e.target.closest('[data-ov-display]'); if (!a) return; e.preventDefault(); e.stopPropagation();
        var k = a.getAttribute('data-ov-display'), opts = L.display.options[k], cur = L.display.get()[k], patch = {};
        patch[k] = opts[(opts.indexOf(cur) + 1) % opts.length]; L.display.set(patch); paint();
    });
    window.addEventListener('ov:display', paint); paint();
})();
