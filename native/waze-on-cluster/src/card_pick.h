// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* Which icon (card_icons.h) the HUD turn card draws for a turn and for a
 * lane.
 *
 * A turn by its arrow's name (turn_card.h). Mapbox's: straight, slight_,
 * sharp_ and plain left / right, uturn_left / _right, offramp_left /
 * _right, merge_left / _right, arrive, arrive_left / _right, destination
 * (a stopover's pin) and roundabout; OsmAnd's fork3_left / _straight /
 * _right and lane_change_left / _right; overpass, underpass, ferry and
 * car_train. keep_left, keep_right and follow have no icon: they are the
 * card's own shapes (card_shapes.h), as is a name this build does not know.
 *
 * A roundabout points at its exit: the car's exit angle (degrees clockwise
 * from straight on) as Mapbox's (degrees round the ring from the entry,
 * anticlockwise where traffic drives on the right), baked every 5 degrees
 * from 20 to 340; driving on the left, clockwise, it is mirrored. With no
 * angle it points straight on.
 *
 * A lane by its arrows, "s+r*" (turn_card.h): Mapbox's lane drawings, picked
 * by its rules (navigation-ui-resources docs/lanes.md). A lane whose arrows
 * all go left is a right one mirrored, and one with both sides is drawn
 * facing the arrow to take. With an arrow to take it is the drawing "using"
 * that arrow, lit; else the drawing in grey. A mix Mapbox has no drawing for
 * is the arrow to take alone, or a grey straight arrow. */
#ifndef WOC_CARD_PICK_H
#define WOC_CARD_PICK_H

#include <string>

#include "card_icons.h"
#include "turn_card.h"

namespace woc {
namespace card {

struct Pick {
    const Icon *icon = nullptr;   /* null: none (a turn: the card's own shape; a lane: no arrow) */
    bool mirror = false;
};

Pick turn_icon(const Turn &turn);
Pick lane_icon(const std::string &lane);

/* The baked roundabout angle (20-340, a multiple of 5) for the car's exit
 * angle ("" or not a number: none) and side ("left": driving on the left). */
int roundabout_angle(const std::string &exit_angle, const std::string &side);

}  // namespace card
}  // namespace woc

#endif
