'use strict';
// The chat's composer and tools keep their room from the first paint (11-28: the input row grew 48 → 56 px and the tools
// row 4 → 38 px after it, and the bottom-anchored messages moved up 42 px: /chat's desktop CLS p75 0.29; 0 in place).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
assert.ok(css.includes('.chat-input-area .chat-input-row { min-height: 56px; }'), 'the input row keeps 56 px');
assert.ok(css.includes('.chat-input-area .chat-tools-row { min-height: 38px; box-sizing: border-box; }'), 'the tools row keeps 38 px');
console.log('chat-input-reserved: the composer and its tools keep their room from the first paint');
