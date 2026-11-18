// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD turn card's icons (card_icons.cpp, made by
 * tools/bake_card_icons.py from icons/README.md's sources): Mapbox's turn
 * arrows and lanes, and the few Mapbox lacks. Each is paths in a square box
 * of units (32 for a turn, 30 for a lane), y down, drawn right-handed: a
 * left one is its right one mirrored. card_raster.h draws them. */
#ifndef WOC_CARD_ICONS_H
#define WOC_CARD_ICONS_H

#include <stdint.h>

namespace woc {
namespace card {

enum IconOp : uint8_t { kIconFill = 0, kIconFillEvenOdd = 1, kIconStroke = 2 };
/* A path's commands in kIconNumbers: kMove x y, kLine x y, kCurve x1 y1 x2 y2 x y, kClose. */
enum IconCommand { kMove = 0, kLine = 1, kCurve = 2, kClose = 3 };

/* One path: filled (non-zero or even-odd) or stroked `width` thick with
 * square ends and round (or mitred) corners; in white or the card's grey. */
struct IconPath {
    uint8_t op;
    uint8_t grey;
    uint8_t round_join;
    float width;
    uint32_t at, size;   /* its numbers in kIconNumbers */
};

struct Icon {
    const char *name;
    float box;
    uint32_t at, size;   /* its paths in kIconPaths, drawn in order */
};

extern const float *const kIconNumbers;
extern const IconPath *const kIconPaths;

/* The icon of that name, or null. */
const Icon *find_icon(const char *name);
const Icon *icons_begin();
const Icon *icons_end();

}  // namespace card
}  // namespace woc

#endif
