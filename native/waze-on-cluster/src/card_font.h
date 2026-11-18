// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD turn card's lettering: glyphs of Noto Sans baked at one size each
 * (tools/bake_card_font.py writes card_font.cpp), the text set for street
 * names and units, the digits for the distance. card_draw.cpp draws them at
 * the card's size, never larger than they are baked. */
#ifndef WOC_CARD_FONT_H
#define WOC_CARD_FONT_H

#include <stdint.h>

namespace woc {

struct CardGlyph {
    uint32_t cp;        /* the character */
    uint32_t off;       /* its coverage in the font's pixels: w * h values of 4 bits, rows top down, the high half first */
    uint8_t w, h;       /* 0: no ink (a space) */
    int8_t left;        /* from the pen to its left edge */
    int8_t top;         /* from the baseline up to its top edge */
    uint16_t advance;   /* the pen's step, sixteenths of a pixel */
};

struct CardFont {
    unsigned px;                /* the size it is baked at */
    unsigned count;             /* glyphs, in the characters' order */
    const CardGlyph *glyphs;
    const uint8_t *pixels;
};

extern const CardFont kCardText, kCardDigits;

/* The font's glyph of a character, or null. */
inline const CardGlyph *card_glyph(const CardFont &f, uint32_t cp)
{
    unsigned lo = 0, hi = f.count;
    while (lo < hi) {
        const unsigned mid = (lo + hi) / 2;
        if (f.glyphs[mid].cp < cp)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo < f.count && f.glyphs[lo].cp == cp ? &f.glyphs[lo] : nullptr;
}

}  // namespace woc

#endif
