/* Live's stream chat on the shared composer (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset chat): each
   .chat-input-row (a stream, a channel, the global page, the floating chat, a broadcast) keeps its textarea's id
   and .chat-textarea class, so sendChat() and the emote picker still find it; the box and Send are the shared ones.
   Loaded after /shared/ov-composer.js; without it the old textarea stays. */
(function () {
  'use strict';
  function upgrade(row) {
    if (!row || row.dataset.ovcMounted || !window.OpenVibeComposer || !window.OpenVibeComposer.mount) return;
    var old = row.querySelector('textarea');
    if (!old) return;
    var id = old.id, max = Number(old.getAttribute('maxlength')) || 500, placeholder = old.placeholder || 'Send a message...';
    var c = window.OpenVibeComposer.mount(document.createElement('div'), {
      preset: 'chat', maxLength: max, placeholder: placeholder, label: placeholder, tools: ['emoji'],
      onSubmit: function () {
        var before = c.text.value;
        if (id === 'fcw-chat-input' && typeof window.fcwSendChat === 'function') window.fcwSendChat();
        else if (typeof window.sendChat === 'function') window.sendChat(c.text);
        return c.text.value !== before;
      },
    });
    if (!c) return;
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
