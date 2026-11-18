// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* An icon's path (card_icons.h) as how much of each pixel it covers, for
 * card_draw.cpp to paint: a fill by its winding rule, a stroke with square
 * ends and round corners (a mitred corner is drawn round). Curves are cut
 * into lines finer than a pixel; a fill's edges are exact across a row and
 * sampled four times down a pixel. */
#ifndef WOC_CARD_RASTER_H
#define WOC_CARD_RASTER_H

#include <vector>

#include "card_icons.h"

namespace woc {
namespace card {

/* Where an icon goes: its box's top left at (x, y) in pixels, `unit`
 * pixels a box unit, mirrored left to right within its box. */
struct IconPlace {
    float x = 0, y = 0, unit = 1;
    bool mirror = false;
};

/* How much of each pixel in x0..x0+w-1, y0..y0+h-1 a path covers, 0 to 1. */
struct Cover {
    int x0 = 0, y0 = 0, w = 0, h = 0;
    std::vector<float> v;   /* w * h */
};

/* The cover of an icon's path placed at `at`, within a picture of
 * pic_w x pic_h pixels (nothing outside it). */
void path_cover(const Icon &icon, const IconPath &path, const IconPlace &at, int pic_w, int pic_h, Cover *out);

}  // namespace card
}  // namespace woc

#endif
