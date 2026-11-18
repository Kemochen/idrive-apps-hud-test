// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD turn card's two pictures (turn_card.h), drawn on the head unit:
 * RGBA, straight alpha, clear where nothing is drawn (black and clear are
 * both see-through on a HUD).
 *
 * The row, 44 high at 100 %: the street's name from the left edge (26 px
 * lettering, cut with an ellipsis short of the arrow), and at the right
 * end the arrow in a 36 px square, then the distance (28 px digits, its
 * unit 26 px), all centred on the row's middle. What has no room is left
 * out: first the name, then the distance. A name with a letter the
 * lettering lacks (card_font.h), or that is not UTF-8, is left out whole,
 * never drawn in part.
 *
 * The arrows are icons (card_pick.h), white, with the road not taken and a
 * roundabout's ring grey; keeping to a side is the card's own Y, and an
 * arrow name this build does not know draws as "follow" (a dot).
 *
 * The lanes: up to kCardLanes places 36 wide at 100 %, ending at the right
 * edge, a dashed grey line between them; each lane is its arrows' icon, the
 * arrow to take white, the others grey. */
#ifndef WOC_CARD_DRAW_H
#define WOC_CARD_DRAW_H

#include <stdint.h>
#include <string>
#include <vector>

#include "turn_card.h"

namespace woc {

struct CardImage {
    unsigned w = 0, h = 0;
    std::vector<uint8_t> rgba;   /* w * h * 4 */
};

/* The row for a turn, w x h, drawn at `scale` (1: a row 44 high). */
void draw_card_row(const Turn &turn, float scale, unsigned w, unsigned h, CardImage *out);
/* The lanes ("s*,s+r*,r", turn_card.h), w x h, drawn at `scale`. */
void draw_card_lanes(const std::string &lanes, float scale, unsigned w, unsigned h, CardImage *out);

}  // namespace woc

#endif
