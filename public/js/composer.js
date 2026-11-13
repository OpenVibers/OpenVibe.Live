/* Live's stream chat on the shared composer (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset chat): each
   .chat-input-row (a stream, a channel, the global page, the floating chat, a broadcast) keeps its textarea's id
   and .chat-textarea class, so sendChat() and the emote picker still find it; the box and Send are the shared ones.
   Loaded after /shared/ov-composer.js; without it the old textarea stays. */
(function () {
  'use strict';
  /* Live's tools in the shared box (ask 371, 2026-11-13: an emoji button and a "+" in the box, and again in the row under
     it). The box holds what goes into a message: Live's emote picker (the channel's emotes and every emoji) in its row,
     and in its + sheet a GIF and adding a channel emote or sound. The row under the box keeps the channel's own actions
     (sound, coins, tips). Each tool finds its box's textarea by id, as the pickers always have. */
  var SMILE = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.2s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9.2 9.6h.01M14.8 9.6h.01';
  var GIF = 'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM10.2 10H8.6a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h1.6v-1.7M12.6 10v4M15.2 14v-4h2.2M15.2 12h1.8';
  var ADD = 'M20 12a8 8 0 1 1-8-8M8.6 14.2s1.2 1.6 3.4 1.6 3.4-1.6 3.4-1.6M9.3 10h.01M14.7 10h.01M18.5 2.5v5M16 5h5';
  function inputOf(form) { var t = form && form.querySelector('textarea'); return t ? t.id : ''; }
  function registerTools() {
    var C = window.OpenVibeComposer;
    if (!C || typeof C.tool !== 'function' || registerTools.done) return;
    registerTools.done = true;
    C.tool('emote', { label: 'Emotes and emoji', path: SMILE, run: function (ctx, button, form) {
      if (typeof window.toggleEmotePicker === 'function') window.toggleEmotePicker(inputOf(form || (ctx && ctx.form)));
    } });
    C.tool('gif', { label: 'GIF', path: GIF, extra: true, run: function (ctx, button, form) {
      if (typeof window.toggleGifPicker === 'function') window.toggleGifPicker(inputOf(form || (ctx && ctx.form)));
    } });
    C.tool('emote-add', { label: 'Add an emote or sound', path: ADD, extra: true, run: function () {
      if (typeof window.openChannelUploadModal === 'function') window.openChannelUploadModal();
    } });
  }
  function upgrade(row) {
    if (!row || row.dataset.ovcMounted || !window.OpenVibeComposer || !window.OpenVibeComposer.mount) return;
    registerTools();
    var old = row.querySelector('textarea');
    if (!old) return;
    var id = old.id, max = Number(old.getAttribute('maxlength')) || 500, placeholder = old.placeholder || 'Send a message...';
    var c = window.OpenVibeComposer.mount(document.createElement('div'), {
      preset: 'chat', maxLength: max, placeholder: placeholder, label: placeholder, tools: ['emote'],
      onSubmit: function () {
        var before = c.text.value;
        if (id === 'fcw-chat-input' && typeof window.fcwSendChat === 'function') window.fcwSendChat();
        else if (typeof window.sendChat === 'function') window.sendChat(c.text);
        return c.text.value !== before;
      },
    });
    if (!c) return;
    // The shared box sizes itself on the next frame and on typing; Live's full stylesheet can arrive after that first
    // measure, and a chat panel can open narrow and widen. Measure again whenever the width changes.
    if (window.ResizeObserver) {
      var lastW = 0;
      new ResizeObserver(function () {
        var w = c.text.clientWidth;
        if (!w || w === lastW) return;
        lastW = w;
        c.text.style.height = 'auto';
        c.text.style.height = Math.min(c.text.scrollHeight + 2, Math.round((window.innerHeight || 800) * 0.4)) + 'px';
      }).observe(c.text);
    }
    c.text.id = id;
    c.text.classList.add('chat-textarea');
    c.text.setAttribute('enterkeyhint', 'send');
    row.replaceChildren(c.form);
    row.dataset.ovcMounted = '1';
  }
  function mount() {
    Array.prototype.forEach.call(document.querySelectorAll('.chat-input-row'), upgrade);
  }
  window.OVChatComposer = { mount: mount, upgrade: upgrade };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  // A page's chat frame is fetched after the route changes: catch the row when it lands, once per row.
  var queued = 0;
  if (window.MutationObserver && document.body) {
    new MutationObserver(function () {
      if (queued) return;
      queued = setTimeout(function () { queued = 0; mount(); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
