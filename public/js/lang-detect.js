/*
   OpenVibe.Live — which language a short text is in, without a model call. One file for the browser
   (window.OVLang, chat's translate button and auto-translate) and the server (require, server/i18n/translate.js),
   so both sides agree on what counts as foreign.

     detect(text)          → { lang: 'es' | 'ja' | … | null, confidence: 0–1 }
     foreignFor(text, me)  → the language code when text is confidently not in `me`, else null

   Non-Latin scripts decide by their characters (kana → Japanese, hangul → Korean, …). Latin-script text is scored
   by common short words and letters particular to a language (ñ, ã, ß, ł, ğ, ơ, …); chat slang and emote names
   carry no score, so "gg", "pog" and "lol" stay unknown rather than guessed. Unknown means "don't offer or spend
   a translation".
*/
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OVLang = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SCRIPTS = [
        ['kana', /[぀-ヿｦ-ﾟ]/g], ['hangul', /[가-힯ᄀ-ᇿ㄰-㆏]/g],
        ['han', /[一-鿿㐀-䶿]/g], ['cyr', /[Ѐ-ӿ]/g], ['ar', /[؀-ۿ]/g],
        ['th', /[฀-๿]/g], ['he', /[֐-׿]/g], ['el', /[Ͱ-Ͽ]/g], ['hi', /[ऀ-ॿ]/g],
    ];
    const W = {
        en: 'the and you that this with for are was have not but what all were when your can there how which their will about would them been has its who did get just like know dont doesnt cant im ive youre thats yeah yes hello thanks thank good really think because some here want going people very much where they them then than also only',
        es: 'que el los las por para con una como pero más mas muy está esta estoy esto eso también tambien porque cuando donde hola gracias bueno qué cómo tengo tiene hay nada todo soy eres del al pues vamos quiero puedo sabes ahora aquí aqui bien',
        pt: 'que não nao uma com para por mais como mas você voce está estou isso também muito obrigado olá ola tudo então entao quando onde tem sou são aqui agora da do das dos na no eu ele ela vou pra',
        fr: 'le les des une est pas que qui dans pour avec sur mais vous nous je tu il elle très tres bien merci bonjour oui non cest cette aussi quoi comment ça ca suis mon ton son',
        de: 'der die das und ist nicht ich du wir ihr sie ein eine mit auf für fur auch aber wie was sehr gut danke hallo ja nein schon noch mal bin bist hast habe den dem zu',
        it: 'il lo gli che di non una per con sono come ma anche molto bene grazie ciao questo quello cosa perché perche io tu lui lei sei è della',
        nl: 'het een en van ik je niet dat is op te zijn met voor maar ook wat hoe goed dank hallo ja nee heb heeft wel dit',
        pl: 'nie się sie jest to że ze na jak ale co tak czy już juz jestem mam dzięki dzieki cześć czesc bardzo dobrze tylko może moze też tez',
        tr: 've bir bu için icin ile ama çok cok değil degil ne var yok ben sen evet hayır hayir merhaba teşekkürler nasıl nasil iyi',
        id: 'yang dan di ini itu dengan untuk tidak ada saya kamu aku apa juga sudah bisa terima kasih halo baik',
        vi: 'và của là không có được cho này những một người tôi bạn cảm ơn xin chào rất',
    };
    const SETS = {};
    for (const k of Object.keys(W)) SETS[k] = new Set(W[k].split(' '));
    const MARKS = {
        es: /[ñ¿¡]/g, pt: /[ãõ]/g, fr: /[œæ]|[çèêëîïûù]/g, de: /ß|[äöü]/g, pl: /[ąćęłńśźż]/g, tr: /[ğış]/g,
        vi: /[ăđơư]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g,
    };
    const count = (s, re) => (s.match(re) || []).length;
    const clean = (t) => String(t || '')
        .replace(/https?:\/\/\S+/gi, ' ').replace(/:[a-z0-9_]+:/gi, ' ').replace(/(^|\s)[!/@#]\S+/g, ' ');

    const memo = new Map();
    function detect(text) {
        const s = clean(text);
        if (memo.has(s)) return memo.get(s);
        const out = compute(s);
        if (memo.size > 3000) memo.delete(memo.keys().next().value);
        memo.set(s, out);
        return out;
    }
    function compute(s) {
        const n = {}; let nonLatin = 0;
        for (const [k, re] of SCRIPTS) { n[k] = count(s, re); nonLatin += n[k]; }
        const latin = count(s, /[A-Za-zÀ-ɏḀ-ỿ]/g);
        if (!nonLatin && !latin) return { lang: null, confidence: 0 };
        if (nonLatin && nonLatin / (nonLatin + latin) >= 0.34) {
            const lang = n.kana ? 'ja' : n.hangul ? 'ko' : n.han ? 'zh' : n.cyr ? (/[іїєґ]/i.test(s) ? 'uk' : 'ru')
                : n.ar ? 'ar' : n.th ? 'th' : n.he ? 'he' : n.el ? 'el' : 'hi';
            return { lang, confidence: nonLatin >= 2 ? 0.95 : 0.6 };
        }
        const words = (s.toLowerCase().replace(/['’]/g, '').match(/[\p{L}]+/gu) || []);
        if (!words.length) return { lang: null, confidence: 0 };
        const score = {};
        for (const k of Object.keys(SETS)) {
            // A word of two letters or fewer (no, de, te, je) is shared by too many languages to count fully.
            let v = 0; for (const w of words) if (SETS[k].has(w)) v += w.length <= 2 ? 0.5 : 1;
            if (MARKS[k]) v += Math.min(3, count(s.toLowerCase(), MARKS[k])) * 0.75;
            score[k] = v;
        }
        const ranked = Object.keys(score).sort((a, b) => score[b] - score[a]);
        const best = ranked[0], a = score[best], b = score[ranked[1]];
        if (a < 1) return { lang: null, confidence: 0 };
        let confidence = 0.4;
        if (a >= 2 && a >= b * 2) confidence = 0.9;
        else if (a >= 1 && b === 0 && words.length <= 4) confidence = 0.65;
        else if (a > b) confidence = 0.55;
        return { lang: best, confidence };
    }
    /** The language of `text` when it is confidently not `me` (a 2-letter code), else null. */
    function foreignFor(text, me, min = 0.6) {
        const d = detect(text);
        return d.lang && d.confidence >= min && d.lang !== String(me || 'en').slice(0, 2) ? d.lang : null;
    }
    return { detect, foreignFor };
});
