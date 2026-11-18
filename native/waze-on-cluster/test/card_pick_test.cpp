// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* Which icon the HUD turn card draws (card_pick.h): a turn's by its name,
 * a roundabout's by its exit's angle, and a lane's by Mapbox's rules
 * (navigation-ui-resources docs/lanes.md), worked by hand. */
#include "card_pick.h"

#include <stdio.h>
#include <string.h>

using namespace woc;
using namespace woc::card;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

/* The pick is that icon, mirrored or not. */
static bool is(const Pick &p, const char *name, bool mirror)
{
    if (p.icon && strcmp(p.icon->name, name) == 0 && p.mirror == mirror)
        return true;
    fprintf(stderr, "  got %s%s, not %s%s\n", p.icon ? p.icon->name : "(none)", p.mirror ? " mirrored" : "", name,
            mirror ? " mirrored" : "");
    return false;
}

static Pick turn(const char *arrow, const char *angle = "", const char *side = "")
{
    Turn t;
    t.arrow = arrow;
    t.angle = angle;
    t.side = side;
    return turn_icon(t);
}

static void turns()
{
    expect(is(turn("straight"), "arrow_straight", false), "straight on: Mapbox's straight arrow");
    expect(is(turn("right"), "arrow_right", false) && is(turn("left"), "arrow_right", true), "a left turn is the right one mirrored");
    expect(is(turn("slight_left"), "arrow_slight_right", true) && is(turn("sharp_right"), "arrow_sharp_right", false),
           "slight and sharp turns");
    expect(is(turn("uturn_left"), "arrow_uturn_right", true) && is(turn("uturn_right"), "arrow_uturn_right", false), "U-turns");
    expect(is(turn("offramp_right"), "offramp", false) && is(turn("offramp_left"), "offramp", true),
           "a motorway exit: the off ramp, the slip road leaving the main road");
    expect(is(turn("merge_left"), "merge", false) && is(turn("merge_right"), "merge", true), "a motorway entry: Mapbox's merge");
    expect(is(turn("arrive"), "arrive", false) && is(turn("arrive_right"), "arrive_right", false) &&
               is(turn("arrive_left"), "arrive_right", true) && is(turn("destination"), "destination", false),
           "arriving, on a side, and a stopover's pin");
    expect(is(turn("fork3_left"), "fork3_left", false) && is(turn("fork3_straight"), "fork3_straight", false) &&
               is(turn("fork3_right"), "fork3_right", false),
           "three-way forks: OsmAnd's");
    expect(is(turn("lane_change_left"), "lane_change_left", false) && is(turn("lane_change_right"), "lane_change_right", false),
           "lane changes: OsmAnd's");
    expect(is(turn("overpass"), "overpass", false) && is(turn("underpass"), "underpass", false) && is(turn("ferry"), "ferry", false) &&
               is(turn("car_train"), "car_train", false),
           "overpass, underpass, ferry and car train");
    expect(!turn("keep_left").icon && !turn("keep_right").icon && !turn("follow").icon && !turn("teleport").icon,
           "keeping to a side, following and a name this build does not know: the card's own shapes");

    expect(is(turn("roundabout", "90", "right"), "roundabout_90", false), "a roundabout's exit to the right, driving on the right");
    expect(is(turn("roundabout", "270", "left"), "roundabout_90", true), "its mirror, driving on the left");
    expect(is(turn("roundabout"), "roundabout_180", false), "no angle: straight on");
}

static void roundabouts()
{
    /* the car's angle clockwise from straight on, as Mapbox's degrees round the ring */
    expect(roundabout_angle("0", "right") == 180 && roundabout_angle("90", "right") == 90 && roundabout_angle("270", "right") == 270,
           "driving on the right: straight on 180, right 90, left 270");
    expect(roundabout_angle("0", "left") == 180 && roundabout_angle("270", "left") == 90 && roundabout_angle("90", "left") == 270,
           "driving on the left, the ring the other way round");
    expect(roundabout_angle("180", "right") == 340 && roundabout_angle("180", "left") == 340,
           "back the way it came: all the way round, as far as the drawing goes");
    expect(roundabout_angle("170", "right") == 20 && roundabout_angle("190", "right") == 340, "held to 20-340");
    expect(roundabout_angle("47", "right") == 135 && roundabout_angle("3", "right") == 175, "to the nearest 5 degrees");
    expect(roundabout_angle("", "right") == 180 && roundabout_angle("x", "") == 180 && roundabout_angle("360", "") == 180 &&
               roundabout_angle("-5", "") == 180 && roundabout_angle("9z", "") == 180,
           "no angle, or none that is one: straight on");
    expect(roundabout_angle("90", "") == 90, "no side: driving on the right");
}

static void lanes()
{
    expect(is(lane_icon("s*"), "lane_straight_using_straight", false) && is(lane_icon("s"), "lane_straight", false),
           "one arrow: lit when it is the one to take, else grey");
    expect(is(lane_icon("s+r*"), "lane_straight_or_turn_using_turn", false), "straight or right, take right: one drawing, the right lit");
    expect(is(lane_icon("s*+r"), "lane_straight_or_turn_using_straight", false) && is(lane_icon("s+r"), "lane_straight_or_turn", false),
           "take straight; none to take");
    expect(is(lane_icon("r*+s"), "lane_straight_or_turn_using_turn", false), "the arrows in any order");
    expect(is(lane_icon("l*+s"), "lane_straight_or_turn_using_turn", true) && is(lane_icon("l"), "lane_turn", true),
           "arrows to the left only: the right drawing mirrored");
    expect(is(lane_icon("l+ul*"), "lane_turn_or_uturn_using_uturn", true) && is(lane_icon("ul"), "lane_uturn", true),
           "a left U-turn: Mapbox's U-turn mirrored");
    expect(is(lane_icon("ur*"), "lane_uturn_using_uturn", false), "a right U-turn, where traffic drives on the left");
    expect(is(lane_icon("l+r*"), "lane_opposite_turn_or_turn_using_turn", false) &&
               is(lane_icon("l*+r"), "lane_opposite_turn_or_turn_using_turn", true) && is(lane_icon("l+r"), "lane_opposite_turn_or_turn", false),
           "both sides: facing the one to take, the other side opposite");
    expect(is(lane_icon("l+s*+r"), "lane_opposite_turn_or_straight_or_turn_using_straight", false), "left, straight or right");
    expect(is(lane_icon("hl*+hr"), "lane_sharp_turn_using_sharp_turn", true), "a mix with no drawing: the arrow to take alone");
    expect(is(lane_icon("hl+hr"), "lane_straight", false), "and with none to take, a grey straight arrow");
    expect(is(lane_icon("l+s+r+ur*"), "lane_uturn_using_uturn", false),
           "more than three arrows: the one to take and two others, here no drawing, so the one to take");
    expect(is(lane_icon("s+s*"), "lane_straight_using_straight", false), "an arrow twice is once");
    expect(!lane_icon("-").icon && !lane_icon("").icon && !lane_icon("zz*").icon, "no arrow, or none this build knows: nothing");
    expect(is(lane_icon("zz+r*"), "lane_turn_using_turn", false), "an unknown arrow beside known ones is left out");
}

int main()
{
    turns();
    roundabouts();
    lanes();
    if (failures)
        return 1;
    printf("card_pick_test: ok\n");
    return 0;
}
